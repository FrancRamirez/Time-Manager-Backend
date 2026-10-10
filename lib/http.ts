import type { VercelRequest, VercelResponse } from "@vercel/node";
import { logPerf, runWithTiming, type TimingContext } from "./timing";
import { parseLang, runWithLang, tr } from "./lang";

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
    const ctx: TimingContext = new Map();
    const t0 = performance.now();
    // Idioma de la app: encabezado X-App-Language o, si no viene, settings.language del cuerpo.
    const header = req.headers?.["x-app-language"];
    const bodySettings = bodyOf(req).settings as Record<string, unknown> | undefined;
    const lang = parseLang(Array.isArray(header) ? header[0] : header ?? bodySettings?.language);
    await runWithLang(lang, () => runWithTiming(ctx, async () => {
      try {
        if (!methods.includes(req.method ?? "")) {
          res.setHeader("Allow", methods.join(", "));
          throw new HttpError(405, tr("Método no permitido", "Method not allowed"));
        }
        await handler(req, res);
      } catch (err) {
        if (err instanceof HttpError) {
          const wait = err.extra?.retryAfterSeconds;
          if (typeof wait === "number" && wait > 0) res.setHeader("Retry-After", String(Math.ceil(wait)));
          res.status(err.status).json({ error: err.message, ...err.extra });
        } else {
          console.error(err);
          res.status(500).json({ error: tr("Error interno del servidor", "Internal server error"), code: "server_error" });
        }
      } finally {
        logPerf({
          method: req.method,
          url: req.url,
          status: res.statusCode,
          ms: performance.now() - t0,
          ctx,
        });
      }
    }));
  };
}

export function bodyOf(req: VercelRequest): Record<string, unknown> {
  return typeof req.body === "object" && req.body !== null
    ? (req.body as Record<string, unknown>)
    : {};
}
