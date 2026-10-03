import { SignJWT, jwtVerify } from "jose";
import type { VercelRequest } from "@vercel/node";
import { HttpError, env } from "./http";

type TokenType = "access" | "refresh";

function secret() {
  return new TextEncoder().encode(env("JWT_SECRET"));
}

/** Convierte "7d", "12h", "30m" o "45s" a segundos. */
function ttlSeconds(value: string): number {
  const m = /^(\d+)\s*([smhd])$/.exec(value.trim());
  if (!m) throw new Error(`TTL inválido: "${value}" (usa por ejemplo 7d, 12h o 30m)`);
  const unit = { s: 1, m: 60, h: 3600, d: 86400 }[m[2] as "s" | "m" | "h" | "d"];
  return Number(m[1]) * unit;
}

const nowSeconds = () => Math.floor(Date.now() / 1000);

async function sign(userId: string, typ: TokenType, exp: number) {
  return new SignJWT({ typ })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(userId)
    .setIssuedAt()
    .setExpirationTime(exp)
    .sign(secret());
}

/**
 * Sesión de 7 días por defecto (en modo Testing el refresh token de Google caduca igual a los 7 días).
 * Al publicar la app se puede alargar con ACCESS_TOKEN_TTL / REFRESH_TOKEN_TTL.
 * `capExp` (epoch en segundos) limita el vencimiento: /api/auth/refresh lo usa para que la
 * renovación nunca extienda la sesión más allá de la vida del refresh token.
 */
export function signAccessToken(userId: string, capExp?: number) {
  const exp = nowSeconds() + ttlSeconds(process.env.ACCESS_TOKEN_TTL ?? "7d");
  return sign(userId, "access", capExp ? Math.min(exp, capExp) : exp);
}

export function signRefreshToken(userId: string) {
  return sign(userId, "refresh", nowSeconds() + ttlSeconds(process.env.REFRESH_TOKEN_TTL ?? "7d"));
}

export async function verifyTokenFull(
  token: string,
  expected: TokenType
): Promise<{ sub: string; exp: number }> {
  try {
    const { payload } = await jwtVerify(token, secret());
    if (payload.typ !== expected || !payload.sub || !payload.exp) {
      throw new Error("tipo de token incorrecto");
    }
    return { sub: payload.sub, exp: payload.exp };
  } catch {
    throw new HttpError(401, "Token inválido o vencido", { code: "session_expired" });
  }
}

export async function verifyToken(token: string, expected: TokenType): Promise<string> {
  return (await verifyTokenFull(token, expected)).sub;
}

/** Exige Authorization: Bearer <accessToken> y devuelve el id del usuario. */
export async function requireUser(req: VercelRequest): Promise<string> {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) {
    throw new HttpError(401, "Falta el token de sesión", { code: "session_expired" });
  }
  return verifyToken(header.slice(7), "access");
}
