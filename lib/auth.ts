import { SignJWT, jwtVerify } from "jose";
import type { VercelRequest } from "@vercel/node";
import { HttpError, env } from "./http";

type TokenType = "access" | "refresh";

function secret() {
  return new TextEncoder().encode(env("JWT_SECRET"));
}

async function sign(userId: string, typ: TokenType, ttl: string) {
  return new SignJWT({ typ })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(userId)
    .setIssuedAt()
    .setExpirationTime(ttl)
    .sign(secret());
}

export function signAccessToken(userId: string) {
  return sign(userId, "access", process.env.ACCESS_TOKEN_TTL ?? "30d");
}

export function signRefreshToken(userId: string) {
  return sign(userId, "refresh", process.env.REFRESH_TOKEN_TTL ?? "90d");
}

export async function verifyToken(token: string, expected: TokenType): Promise<string> {
  try {
    const { payload } = await jwtVerify(token, secret());
    if (payload.typ !== expected || !payload.sub) throw new Error("tipo de token incorrecto");
    return payload.sub;
  } catch {
    throw new HttpError(401, "Token inválido o vencido");
  }
}

/** Exige Authorization: Bearer <accessToken> y devuelve el id del usuario. */
export async function requireUser(req: VercelRequest): Promise<string> {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) {
    throw new HttpError(401, "Falta el token de sesión");
  }
  return verifyToken(header.slice(7), "access");
}
