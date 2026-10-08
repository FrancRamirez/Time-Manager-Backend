// ---------------------------------------------------------------------------
// Proveedor de IA alternativo (respaldo cuando Gemini no responde o agotó su cuota)
//
// Habla el formato "chat completions" de OpenAI, que usan Groq, Mistral, OpenRouter, Cerebras y
// muchos otros. El resto del servidor trabaja con el formato de Gemini (contents / parts), así que
// este módulo traduce en las dos direcciones:
//
//   contents de Gemini  ->  messages de OpenAI   (toOpenAiMessages)
//   function declarations -> tools de OpenAI      (toOpenAiTools)
//   respuesta de OpenAI ->  respuesta tipo Gemini (fromOpenAiResponse)
//
// Con eso el bucle de herramientas de gemini.ts funciona igual con cualquiera de los dos.
//
// Se activa SOLO si están las tres variables:
//   AI_ALT_BASE_URL   p. ej. https://api.groq.com/openai/v1
//   AI_ALT_API_KEY
//   AI_ALT_MODEL      p. ej. un modelo con soporte de function calling
// ---------------------------------------------------------------------------

import { tfetch } from "./timing";
import type { GeminiContent, GeminiPart, GeminiResponse } from "./gemini";

export interface AltConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

/** Configuración del respaldo, o null si no está completa (entonces no se usa). */
export function altConfig(): AltConfig | null {
  const baseUrl = (process.env.AI_ALT_BASE_URL ?? "").trim().replace(/\/+$/, "");
  const apiKey = (process.env.AI_ALT_API_KEY ?? "").trim();
  const model = (process.env.AI_ALT_MODEL ?? "").trim();
  if (!baseUrl || !apiKey || !model) return null;
  // La clave viaja en un header: solo por HTTPS.
  if (!/^https:\/\//i.test(baseUrl)) {
    console.error("AI_ALT_BASE_URL debe empezar con https:// : el proveedor alternativo queda desactivado.");
    return null;
  }
  return { baseUrl, apiKey, model };
}

/** El proveedor alternativo falló (el detalle técnico va al log, no al usuario). */
export class AltProviderError extends Error {
  constructor(
    message: string,
    public status?: number
  ) {
    super(message);
    this.name = "AltProviderError";
  }
}

// ---------------------------------------------------------------------------
// Formato OpenAI (mínimo)
// ---------------------------------------------------------------------------

type OpenAiToolCall = { id: string; type: "function"; function: { name: string; arguments: string } };

type OpenAiMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: OpenAiToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

interface OpenAiResponse {
  choices?: {
    message?: {
      content?: string | null;
      tool_calls?: { id?: string; function?: { name?: string; arguments?: string } }[];
    };
    finish_reason?: string | null;
  }[];
}

// ---------------------------------------------------------------------------
// Traducción
// ---------------------------------------------------------------------------

/** Declaraciones de herramientas de Gemini -> `tools` de OpenAI. Los esquemas ya son JSON Schema. */
export function toOpenAiTools(
  tools: { functionDeclarations: { name: string; description?: string; parameters?: unknown }[] }[] | undefined
) {
  if (!tools) return undefined;
  const out = tools
    .flatMap((group) => group.functionDeclarations)
    .map((d) => ({
      type: "function" as const,
      function: {
        name: d.name,
        description: d.description ?? "",
        parameters: d.parameters ?? { type: "object", properties: {} },
      },
    }));
  return out.length ? out : undefined;
}

const textOf = (parts: GeminiPart[]) =>
  parts
    .map((p) => (typeof p.text === "string" ? p.text : ""))
    .join("")
    .trim();

/**
 * Historial de Gemini -> mensajes de OpenAI. Los `functionCall` pasan a `tool_calls` y los
 * `functionResponse` a mensajes `tool`, emparejados por id (si Gemini no mandó id se genera uno).
 */
export function toOpenAiMessages(system: string, contents: GeminiContent[]): OpenAiMessage[] {
  const messages: OpenAiMessage[] = [{ role: "system", content: system }];
  let pending: { id: string; name: string }[] = []; // llamadas del modelo que esperan respuesta
  let counter = 0;

  for (const content of contents) {
    if (content.role === "model") {
      const calls: OpenAiToolCall[] = [];
      for (const part of content.parts) {
        if (!part.functionCall) continue;
        const id = part.functionCall.id || `call_${++counter}`;
        calls.push({
          id,
          type: "function",
          function: { name: part.functionCall.name, arguments: JSON.stringify(part.functionCall.args ?? {}) },
        });
        pending.push({ id, name: part.functionCall.name });
      }
      const text = textOf(content.parts);
      messages.push({
        role: "assistant",
        content: text || null,
        ...(calls.length ? { tool_calls: calls } : {}),
      });
      continue;
    }

    // role "user": o texto del usuario, o respuestas a herramientas.
    const responses = content.parts.filter((p) => p.functionResponse);
    for (const part of responses) {
      const fr = part.functionResponse!;
      const at = pending.findIndex((c) => (fr.id ? c.id === fr.id : c.name === fr.name));
      const callId = at >= 0 ? pending.splice(at, 1)[0].id : fr.id || `call_${++counter}`;
      messages.push({ role: "tool", tool_call_id: callId, content: JSON.stringify(fr.response ?? {}) });
    }
    const text = textOf(content.parts);
    if (text) messages.push({ role: "user", content: text });
  }
  return messages;
}

/** Respuesta de OpenAI -> forma de Gemini (candidates[0].content.parts), que ya entiende el bucle. */
export function fromOpenAiResponse(data: OpenAiResponse): GeminiResponse {
  const choice = data.choices?.[0];
  const message = choice?.message;
  const parts: GeminiPart[] = [];

  if (message?.content && message.content.trim()) parts.push({ text: message.content });

  let counter = 0;
  for (const tc of message?.tool_calls ?? []) {
    const name = tc.function?.name;
    if (!name) continue;
    let args: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(tc.function?.arguments || "{}");
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) args = parsed;
    } catch {
      /* argumentos mal formados: el validador de la herramienta responderá con su error */
    }
    parts.push({ functionCall: { id: tc.id || `alt_${Date.now()}_${++counter}`, name, args } });
  }

  const finish =
    choice?.finish_reason === "length"
      ? "MAX_TOKENS"
      : choice?.finish_reason === "content_filter"
        ? "SAFETY"
        : (choice?.finish_reason ?? undefined);

  return {
    candidates: [{ content: parts.length ? { role: "model", parts } : undefined, finishReason: finish ?? undefined }],
  };
}

// ---------------------------------------------------------------------------
// Llamada
// ---------------------------------------------------------------------------

const ALT_TIMEOUT_MS = 20_000;

export async function callAltProvider(
  cfg: AltConfig,
  system: string,
  contents: GeminiContent[],
  tools: Parameters<typeof toOpenAiTools>[0],
  deadline: number,
  /** Cierre forzado: las herramientas siguen declaradas pero no se puede llamar a ninguna (tool_choice "none"). */
  noTools = false
): Promise<GeminiResponse> {
  const remaining = deadline - Date.now();
  if (remaining < 1500) throw new AltProviderError("sin tiempo restante para el proveedor alternativo");

  const openAiTools = toOpenAiTools(tools);
  const t0 = Date.now();
  let res: Response;
  try {
    res = await tfetch(`${cfg.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${cfg.apiKey}` },
      body: JSON.stringify({
        model: cfg.model,
        messages: toOpenAiMessages(system, contents),
        ...(openAiTools ? { tools: openAiTools, tool_choice: noTools ? "none" : "auto" } : {}),
      }),
      signal: AbortSignal.timeout(Math.max(1000, Math.min(ALT_TIMEOUT_MS, remaining))),
    });
  } catch (err) {
    throw new AltProviderError(`${cfg.model}: ${(err as Error).message} (${Date.now() - t0} ms)`);
  }

  if (!res.ok) {
    const body = (await res.text().catch(() => "")).slice(0, 500);
    throw new AltProviderError(`${cfg.model}: HTTP ${res.status} (${Date.now() - t0} ms) ${body}`, res.status);
  }
  return fromOpenAiResponse((await res.json()) as OpenAiResponse);
}
