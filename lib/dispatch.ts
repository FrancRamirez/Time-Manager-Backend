// ---------------------------------------------------------------------------
// Despachador de rutas
//
// Vercel (plan gratuito) admite como máximo 12 funciones serverless por despliegue, y cada archivo de
// api/ cuenta como una. Para no depender de ese límite, los handlers viven en lib/routes/ (que no son
// funciones) y unas pocas funciones "catch-all" (api/<grupo>/[...slug].ts) reparten las peticiones.
// Las URLs son las mismas de siempre: la app no cambia.
// ---------------------------------------------------------------------------

import type { VercelRequest, VercelResponse } from "@vercel/node";

export type RouteHandler = (req: VercelRequest, res: VercelResponse) => Promise<void> | void;

/**
 * Segmentos de la ruta después del prefijo del grupo. "/api/ai/actions/abc/confirm?x=1" con el
 * prefijo "/api/ai/" da ["actions", "abc", "confirm"]. Si Vercel no entrega la URL original, se usa el
 * parámetro del catch-all (`slug`, texto o lista). null = ruta con un % mal formado.
 */
export function pathAfter(req: VercelRequest, prefix: string): string[] | null {
  const pathname = (req.url ?? "").split("?")[0];
  const at = pathname.indexOf(prefix);
  let rest = at >= 0 ? pathname.slice(at + prefix.length) : "";
  if (!rest) {
    const slug = req.query?.slug;
    rest = Array.isArray(slug) ? slug.join("/") : typeof slug === "string" ? slug : "";
  }
  try {
    return rest
      .split("/")
      .filter(Boolean)
      .map((s) => decodeURIComponent(s));
  } catch {
    return null;
  }
}

/** Añade los parámetros de la ruta a req.query aunque esa propiedad sea de solo lectura (en Vercel es "perezosa"). */
function setQueryParams(req: VercelRequest, params: Record<string, string>) {
  const merged = { ...(req.query ?? {}), ...params };
  try {
    req.query = merged;
  } catch {
    /* propiedad con getter y sin setter: se redefine abajo */
  }
  const applied = Object.entries(params).every(([k, v]) => req.query?.[k] === v);
  if (!applied) {
    Object.defineProperty(req, "query", { value: merged, configurable: true, enumerable: true, writable: true });
  }
}

/**
 * Crea la función de un grupo. `table` asocia un patrón ("events", "events/:eventId") con su handler;
 * los segmentos ":nombre" se copian a req.query.nombre (el valor de la ruta manda sobre cualquier
 * parámetro igual que mande el cliente). Cada handler sigue validando método y sesión por su cuenta.
 */
export function dispatcher(prefix: string, table: Record<string, RouteHandler>) {
  const entries = Object.entries(table).map(([pattern, handler]) => ({
    pattern: pattern.split("/"),
    handler,
  }));

  return async (req: VercelRequest, res: VercelResponse) => {
    const segments = pathAfter(req, prefix);
    if (segments) {
      for (const { pattern, handler } of entries) {
        if (pattern.length !== segments.length) continue;
        const params: Record<string, string> = {};
        const matches = pattern.every((part, i) => {
          if (part.startsWith(":")) {
            params[part.slice(1)] = segments[i];
            return true;
          }
          return part === segments[i];
        });
        if (!matches) continue;
        setQueryParams(req, params);
        return handler(req, res);
      }
    }
    res.status(404).json({ error: "No encontrado" });
  };
}
