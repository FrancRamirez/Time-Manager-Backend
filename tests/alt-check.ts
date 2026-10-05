import { altConfig, callAltProvider, toOpenAiMessages, toOpenAiTools, fromOpenAiResponse, AltProviderError } from "../lib/altProvider";
declare const process: any; declare const console: any;
let fails = 0; const ok = (c: boolean, m: string) => { console.log(c ? "OK  " : "FAIL", m); if (!c) fails++; };

// 1) config
delete process.env.AI_ALT_API_KEY; ok(altConfig() === null, "sin variables -> desactivado");
process.env.AI_ALT_BASE_URL = "http://inseguro.test/v1"; process.env.AI_ALT_API_KEY = "k"; process.env.AI_ALT_MODEL = "m";
ok(altConfig() === null, "base_url http:// se rechaza");
process.env.AI_ALT_BASE_URL = "https://api.ejemplo.test/openai/v1/"; ok(altConfig()?.baseUrl === "https://api.ejemplo.test/openai/v1", "config válida, sin barra final");

// 2) historial con function calling (con y sin id) -> mensajes OpenAI
const contents: any[] = [
  { role: "user", parts: [{ text: "¿Qué tengo mañana?" }] },
  { role: "model", parts: [{ functionCall: { id: "g1", name: "list_events", args: { days_ahead: 2 } }, thoughtSignature: "abc" }] },
  { role: "user", parts: [{ functionResponse: { id: "g1", name: "list_events", response: { events: [] } } }] },
  { role: "model", parts: [{ functionCall: { name: "create_event", args: { title: "X" } } }] }, // sin id
  { role: "user", parts: [{ functionResponse: { name: "create_event", response: { status: "pending_user_confirmation" } } }] },
];
const msgs = toOpenAiMessages("SYS", contents);
ok(msgs[0].role === "system" && (msgs[0] as any).content === "SYS", "system primero");
ok(msgs[1].role === "user", "turno de usuario");
const a1: any = msgs[2]; ok(a1.role === "assistant" && a1.content === null && a1.tool_calls[0].id === "g1" && a1.tool_calls[0].function.arguments === '{"days_ahead":2}', "functionCall -> tool_calls (args como string JSON)");
const t1: any = msgs[3]; ok(t1.role === "tool" && t1.tool_call_id === "g1", "functionResponse empareja por id");
const a2: any = msgs[4]; const t2: any = msgs[5]; ok(!!a2.tool_calls[0].id && t2.tool_call_id === a2.tool_calls[0].id, "sin id: se genera y se empareja por nombre");
ok(JSON.stringify(msgs).indexOf("thoughtSignature") < 0, "no se filtran firmas internas de Gemini");

// 3) tools
const tools = toOpenAiTools([{ functionDeclarations: [{ name: "list_alarms", description: "d", parameters: { type: "object", properties: {} } }, { name: "x" }] }]);
ok(tools?.length === 2 && tools[0].type === "function" && tools[1].function.parameters !== undefined, "tools al formato OpenAI");
ok(toOpenAiTools(undefined) === undefined, "sin herramientas -> sin campo tools");

// 4) respuestas
const r1 = fromOpenAiResponse({ choices: [{ message: { content: "Hola", tool_calls: [{ id: "c1", function: { name: "set_timer", arguments: '{"seconds":60}' } }] }, finish_reason: "tool_calls" }] });
const p1 = r1.candidates![0].content!.parts; ok(p1[0].text === "Hola" && p1[1].functionCall!.name === "set_timer" && (p1[1].functionCall!.args as any).seconds === 60, "respuesta con texto + tool_call");
const r2 = fromOpenAiResponse({ choices: [{ message: { content: null, tool_calls: [{ id: "c2", function: { name: "a", arguments: "{no json" } }] } }] });
ok(JSON.stringify(r2.candidates![0].content!.parts[0].functionCall!.args) === "{}", "argumentos corruptos -> {} (no revienta)");
ok(fromOpenAiResponse({ choices: [{ message: { content: "" }, finish_reason: "length" }] }).candidates![0].content === undefined, "vacío -> sin content (lo maneja emptyReplyText)");
ok(fromOpenAiResponse({ choices: [{ message: { content: "" }, finish_reason: "length" }] }).candidates![0].finishReason === "MAX_TOKENS", "length -> MAX_TOKENS");

// 5) llamada HTTP simulada
(async () => {
  const cfg = altConfig()!; let seen: any;
  (globalThis as any).fetch = async (url: string, init: any) => { seen = { url, init, body: JSON.parse(init.body) }; return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), { status: 200 }); };
  const out = await callAltProvider(cfg, "SYS", contents.slice(0, 1), [{ functionDeclarations: [{ name: "list_alarms", parameters: { type: "object", properties: {} } }] }], Date.now() + 20000);
  ok(seen.url === "https://api.ejemplo.test/openai/v1/chat/completions" && seen.init.headers.Authorization === "Bearer k" && seen.body.tool_choice === "auto", "URL, header y tool_choice correctos");
  ok(out.candidates![0].content!.parts[0].text === "ok", "respuesta traducida");

  (globalThis as any).fetch = async () => new Response('{"error":"rate"}', { status: 429 });
  try { await callAltProvider(cfg, "S", contents.slice(0, 1), undefined, Date.now() + 20000); ok(false, "debía fallar"); } catch (e: any) { ok(e instanceof AltProviderError && e.status === 429, "HTTP 429 -> AltProviderError con status"); }
  (globalThis as any).fetch = async () => { throw new TypeError("fetch failed"); };
  try { await callAltProvider(cfg, "S", contents.slice(0, 1), undefined, Date.now() + 20000); ok(false, "debía fallar"); } catch (e: any) { ok(e instanceof AltProviderError, "caída de red -> AltProviderError"); }
  try { await callAltProvider(cfg, "S", contents.slice(0, 1), undefined, Date.now() + 500); ok(false, "debía fallar"); } catch (e: any) { ok(/sin tiempo/.test(e.message), "sin tiempo restante -> falla rápido sin llamar"); }
  console.log(fails ? `\n${fails} FALLAS` : "\nTODO OK"); process.exit(fails ? 1 : 0);
})();
