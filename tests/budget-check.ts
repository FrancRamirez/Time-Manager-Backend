// Prueba del ahorro de cuota de IA: respuesta rápida tras una acción, vueltas máximas y respuestas locales.
// Ejecutar: npx tsx tests/budget-check.ts   (fetch simulado, sin red)
import { quickReply } from "../lib/quickReply";
import { sendMessageToGemini, systemPrompt } from "../lib/gemini";
import { DEFAULT_SETTINGS } from "../lib/schedule";

let fails = 0;
const ok = (c: boolean, m: string) => { if (!c) { fails++; console.log("FALLA:", m); } };

const calls: { url: string; body?: any }[] = [];
let geminiScript: any[] = [];
console.error = () => {};
const json = (b: any, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
(globalThis as any).fetch = async (url: any, init?: any) => {
  const u = String(url);
  calls.push({ url: u, body: init?.body ? JSON.parse(init.body) : undefined });
  if (u.includes("generativelanguage")) {
    if (!geminiScript.length) throw new Error("Se pidió una solicitud a Gemini que no estaba prevista");
    return json(geminiScript.shift());
  }
  throw new Error("URL inesperada " + u);
};
const part = (name: string, args: any = {}) => ({ functionCall: { name, args } });
const fnCalls = (...parts: any[]) => ({ candidates: [{ content: { role: "model", parts } }] });
const text = (t: string) => ({ candidates: [{ content: { role: "model", parts: [{ text: t }] } }] });
const gem = () => calls.filter((c) => c.url.includes("generativelanguage"));
const reset = () => { calls.length = 0; };

process.env.GEMINI_API_KEY = "test";
process.env.GEMINI_MODEL = "m1";
process.env.GEMINI_FALLBACK_MODEL = "";
const TZ = "America/Argentina/Buenos_Aires";
const base = { userId: "u1", message: "Abre el mapa a la oficina", timeZone: TZ };
const suggestion = { ...DEFAULT_SETTINGS, autonomyLevel: "suggestion" as const };

(async () => {
  // 1. Una acción = 1 sola solicitud (la confirmación la arma el servidor)
  delete process.env.AI_FAST_ACTIONS;
  reset(); geminiScript = [fnCalls(part("open_maps_route", { destination: "Av. Colón 100, Córdoba" }))];
  const r1 = await sendMessageToGemini({ ...base, settings: suggestion });
  ok(gem().length === 1, "una acción gasta 1 sola solicitud: " + gem().length);
  ok((r1.deviceAction as any)?.kind === "maps_open" && (r1.deviceAction as any).requiresConfirmation === true, "la acción sigue pendiente de confirmación");
  ok(r1.reply.content.endsWith("¿La confirmas?") && !r1.reply.content.includes(".."), "texto del servidor sin doble punto: " + r1.reply.content);

  // 2. Con AI_FAST_ACTIONS=0 vuelve al comportamiento anterior (2 solicitudes, texto del modelo)
  process.env.AI_FAST_ACTIONS = "0";
  reset(); geminiScript = [fnCalls(part("open_maps_route", { destination: "Av. Colón 100, Córdoba" })), text("Listo, revisa y confirma.")];
  const r2 = await sendMessageToGemini({ ...base, settings: suggestion });
  ok(gem().length === 2 && r2.reply.content === "Listo, revisa y confirma.", "desactivado: 2 solicitudes y texto del modelo");
  delete process.env.AI_FAST_ACTIONS;

  // 3. Un error en la herramienta de escritura: el modelo SÍ continúa para explicarlo
  reset(); geminiScript = [fnCalls(part("open_maps_route", { destination: "x" })), text("Necesito un destino más claro.")];
  const r3 = await sendMessageToGemini({ ...base, settings: suggestion });
  ok(gem().length === 2 && r3.reply.content.includes("destino más claro") && r3.deviceAction === undefined, "con error el modelo sigue y lo explica");

  // 4. Consultar y actuar en pasos distintos: la consulta sigue necesitando al modelo (2 solicitudes) y la acción no suma otra
  reset(); geminiScript = [fnCalls(part("list_alarms")), fnCalls(part("open_maps_route", { destination: "Centro, Córdoba" }))];
  const r4 = await sendMessageToGemini({ ...base, settings: suggestion });
  ok(gem().length === 2 && (r4.deviceAction as any)?.kind === "maps_open", "consulta + acción = 2 solicitudes (antes 3): " + gem().length);

  // 5. Lectura y escritura en la MISMA vuelta: el modelo continúa (puede necesitar el resultado de la lectura)
  reset(); geminiScript = [fnCalls(part("list_alarms"), part("open_maps_route", { destination: "Centro, Córdoba" })), text("Listo.")];
  const r5 = await sendMessageToGemini({ ...base, settings: suggestion });
  ok(gem().length === 2 && r5.reply.content === "Listo.", "lectura + escritura juntas: el modelo cierra la respuesta");

  // 6. Dos acciones en una vuelta: la segunda es rechazada con error -> el modelo continúa y la primera se conserva
  reset(); geminiScript = [fnCalls(part("open_maps_route", { destination: "Centro, Córdoba" }), part("compose_call", { phone: "1123456789" })), text("Hice la primera; la llamada va después.")];
  const r6 = await sendMessageToGemini({ ...base, settings: suggestion });
  ok(gem().length === 2 && (r6.deviceAction as any)?.kind === "maps_open", "dos acciones: queda la primera y el modelo avisa de la otra");

  // 7. Consultas en paralelo en una sola vuelta = 2 solicitudes en total
  reset(); geminiScript = [fnCalls(part("list_alarms"), part("list_alarms")), text("No tienes alarmas.")];
  await sendMessageToGemini({ ...base, message: "¿Qué alarmas tengo?", settings: suggestion });
  ok(gem().length === 2, "dos consultas en la misma vuelta no suman vueltas");

  // 8. Tope de vueltas: un modelo que no termina de consultar no gasta más de 3 solicitudes (nivel Media, el predeterminado)
  reset(); geminiScript = Array.from({ length: 10 }, () => fnCalls(part("get_directions", { destination: "x" })));
  await sendMessageToGemini({ ...base, message: "¿Cómo llego?", settings: suggestion });
  ok(gem().length === 3, "tope de 3 vueltas en Media: " + gem().length);

  // 9. El prompt pide agrupar consultas
  const prompt = systemPrompt(TZ, DEFAULT_SETTINGS, false);
  ok(prompt.includes("Eficiencia") && prompt.includes("todas juntas"), "el prompt pide agrupar consultas");

  // 10. Respuestas locales: solo agradecimientos, saludos y despedidas puros
  const yes = ["gracias", "Gracias!", "muchas gracias", "Mil gracias :)", "ok gracias", "gracias Frami", "genial, gracias", "hola", "¿Hola?", "Hola Frami!", "buenas", "Buenos días", "buenas noches", "chau", "Adiós", "hasta luego", "hasta mañana", "nos vemos"];
  for (const m of yes) ok(typeof quickReply(m) === "string" && quickReply(m)!.length > 5, `respuesta local para "${m}"`);
  const no = ["ok", "dale", "sí", "si", "listo", "perfecto", "gracias, ¿y mañana qué tengo?", "hola, pon una alarma a las 7", "gracias por mover la reunión al jueves", "chau, cancela la reunión", "no gracias", "", "   ", "no gracias, mejor otro horario", "x".repeat(60)];
  for (const m of no) ok(quickReply(m) === null, `"${m.slice(0, 30)}" sigue yendo al modelo`);
  ok(quickReply(123 as any) === null, "no texto = al modelo");
  ok(quickReply("gracias", () => 0) !== quickReply("gracias", () => 1), "hay variedad de respuestas");

  if (fails) { console.log(`\n${fails} FALLA(S)`); process.exit(1); }
  console.log("TODO OK");
})();
