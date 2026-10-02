import type { VercelRequest, VercelResponse } from "@vercel/node";

export class HttpError extends Error {
  /** `extra` se incluye tal cual en el JSON de la respuesta (ej. code, retryAfterSeconds). */
  constructor(
    public status: number,
    message: string,
    public extra?: Record<string, unknown>
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export function env(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Falta la variable de entorno ${name}`);
  }
  return value;
}

type Handler = (req: VercelRequest, res: VercelResponse) => Promise<void>;

/**
 * Envuelve un handler: valida el método HTTP y convierte los errores
 * en respuestas JSON { error: "..." }.
 */
export function route(methods: string[], handler: Handler) {
  return async (req: VercelRequest, res: VercelResponse) => {
    try {
      if (!methods.includes(req.method ?? "")) {
        res.setHeader("Allow", methods.join(", "));
        throw new HttpError(405, "Método no permitido");
      }
      await handler(req, res);
    } catch (err) {
      if (err instanceof HttpError) {
        const wait = err.extra?.retryAfterSeconds;
        if (typeof wait === "number" && wait > 0) res.setHeader("Retry-After", String(Math.ceil(wait)));
        res.status(err.status).json({ error: err.message, ...err.extra });
        return;
      }
      console.error(err);
      res.status(500).json({ error: "Error interno del servidor" });
    }
  };
}

export function bodyOf(req: VercelRequest): Record<string, unknown> {
  return typeof req.body === "object" && req.body !== null
    ? (req.body as Record<string, unknown>)
    : {};
}
