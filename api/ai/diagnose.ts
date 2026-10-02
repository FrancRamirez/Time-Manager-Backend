import { route, HttpError } from "../../lib/http";
import { API_BASE, TOOLS, modelChain, systemPrompt } from "../../lib/gemini";
import { DEFAULT_SETTINGS } from "../../lib/schedule";

/**
 * DIAGNÓSTICO TEMPORAL. Mide desde Vercel cuánto tarda Gemini con distintas
 * combinaciones (sin herramientas / con las herramientas reales / varios modelos).
 * Se protege con la variable DIAGNOSE_KEY (mínimo 16 caracteres); si no existe,
 * responde 404. No devuelve secretos. BORRAR este archivo cuando termine el diagnóstico.
 *
 * Uso: GET /api/ai/diagnose?key=<DIAGNOSE_KEY>
 */

const TIMEOUT_MS = 40_000;

interface Probe {
  label: string;
  model: string;
  status: number; // 0 = sin respuesta (timeout o red)
  ms: number;
  note: string;
}

async function probe(
  label: string,
  model: string,
  apiKey: string,
  body: Record<string, unknown>
): Promise<Probe> {
  const t0 = Date.now();
  try {
    const res = await fetch(`${API_BASE}/${model}:generateContent`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const text = await res.text();
    let note = text.slice(0, 250);
    if (res.ok) {
      try {
        const u = (JSON.parse(text) as { usageMetadata?: Record<string, unknown> }).usageMetadata;
        note = `ok; tokens prompt=${u?.promptTokenCount} pensamiento=${u?.thoughtsTokenCount ?? 0} salida=${u?.candidatesTokenCount}`;
      } catch {
        note = "ok";
      }
    }
    return { label, model, status: res.status, ms: Date.now() - t0, note };
  } catch (err) {
    return { label, model, status: 0, ms: Date.now() - t0, note: (err as Error).message };
  }
}

export default route(["GET"], async (req, res) => {
  const secret = process.env.DIAGNOSE_KEY;
  if (!secret || secret.length < 16) throw new HttpError(404, "No encontrado");
  if (req.query.key !== secret) throw new HttpError(401, "No autorizado");

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new HttpError(500, "Falta GEMINI_API_KEY");

  const [primary, fallback] = modelChain();
  const hello = { contents: [{ role: "user", parts: [{ text: "Responde solo: ok" }] }] };
  const low = { generationConfig: { thinkingConfig: { thinkingLevel: "low" } } };
  const realistic = {
    systemInstruction: {
      parts: [{ text: systemPrompt("America/New_York", DEFAULT_SETTINGS, false) }],
    },
    contents: [{ role: "user", parts: [{ text: "¿Qué tengo esta semana?" }] }],
    tools: TOOLS,
    ...low,
  };
  const extras = (process.env.GEMINI_DIAG_MODELS ?? "gemini-3.5-flash-lite")
    .split(",")
    .map((m: string) => m.trim())
    .filter(Boolean);

  const started = Date.now();
  const results = await Promise.all([
    probe("simple (sin herramientas)", primary, apiKey, hello),
    probe("simple + thinking low", primary, apiKey, { ...hello, ...low }),
    probe("como la app (prompt + herramientas)", primary, apiKey, realistic),
    ...(fallback && fallback !== primary
      ? [probe("simple (modelo de respaldo)", fallback, apiKey, hello)]
      : []),
    ...extras.map((m: string) => probe("simple (extra)", m, apiKey, hello)),
  ]);

  res.status(200).json({
    region: process.env.VERCEL_REGION ?? null,
    totalMs: Date.now() - started,
    results,
  });
});
