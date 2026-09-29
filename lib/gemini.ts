export interface ChatReply {
  reply: { id: string; role: "assistant"; content: string; createdAt: string };
  pendingAction?: {
    type: "reschedule" | "cancel" | "create";
    description: string;
    payload: Record<string, unknown>;
  };
}

const GEMINI_API_URL =
  "https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent";

/**
 * Sin GEMINI_API_KEY configurada, responde con un mensaje fijo para que
 * el flujo de chat de la app funcione de punta a punta mientras se
 * conecta la IA real. Los mensajes nunca se persisten (procesamiento
 * efímero), tal como pide la spec de privacidad.
 */
export async function sendMessageToGemini(message: string): Promise<ChatReply> {
  const apiKey = process.env.GEMINI_API_KEY;

  if (!apiKey) {
    return {
      reply: {
        id: `stub-${Date.now()}`,
        role: "assistant",
        content:
          "Todavía no conecté el motor de IA (falta GEMINI_API_KEY). Recibí tu mensaje: " +
          `"${message}"`,
        createdAt: new Date().toISOString(),
      },
    };
  }

  const res = await fetch(`${GEMINI_API_URL}?key=${apiKey}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: message }] }],
      // TODO: agregar function calling con las funciones de reprogramar/
      // cancelar/crear eventos una vez que el flujo de Calendar esté
      // probado de punta a punta.
    }),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Gemini respondió con error: ${detail}`);
  }

  const data = (await res.json()) as {
    candidates?: { content?: { parts?: { text?: string }[] } }[];
  };
  const text =
    data.candidates?.[0]?.content?.parts?.map((p) => p.text).join("") ??
    "No pude generar una respuesta.";

  return {
    reply: {
      id: `gemini-${Date.now()}`,
      role: "assistant",
      content: text,
      createdAt: new Date().toISOString(),
    },
  };
}
