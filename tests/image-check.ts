// Prueba de la lectura de imágenes: validación del adjunto, formato del pedido a Gemini, reglas del prompt,
// confirmación obligatoria en Piloto Automático y que el proveedor alternativo no reciba la imagen.
// Ejecutar: npx tsx tests/image-check.ts   (fetch simulado, sin red ni base de datos)
import { parseImage, MAX_IMAGE_BASE64_CHARS, IMAGE_ONLY_REQUEST } from "../lib/imageInput";
import { sendMessageToGemini } from "../lib/gemini";
import { DEFAULT_SETTINGS } from "../lib/schedule";
import { HttpError } from "../lib/http";

let fails = 0;
const ok = (c: boolean, m: string) => { if (!c) { fails++; console.log("FALLA:", m); } };

// ---- Gemini simulado -----------------------------------------------------------------------
const calls: { url: string; body?: any }[] = [];
let script: any[] = [];
console.error = () => {};
const json = (b: any, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
(globalThis as any).fetch = async (url: any, init?: any) => {
  const u = String(url);
  calls.push({ url: u, body: init?.body ? JSON.parse(init.body) : undefined });
  if (u.includes("generativelanguage")) {
    if (!script.length) throw new Error("Solicitud a Gemini no prevista");
    const next = script.shift();
    return next instanceof Response ? next : json(next);
  }
  throw new Error("URL inesperada (el proveedor alternativo no debía recibir nada): " + u);
};
const gem = () => calls.filter((c) => c.url.includes("generativelanguage"));
const reset = () => { calls.length = 0; };
const text = (t: string) => ({ candidates: [{ content: { role: "model", parts: [{ text: t }] } }] });
const fnCall = (name: string, args: any = {}) => ({ candidates: [{ content: { role: "model", parts: [{ functionCall: { name, args } }] } }] });

process.env.GEMINI_API_KEY = "test";
process.env.GEMINI_MODEL = "m1";
process.env.GEMINI_FALLBACK_MODEL = "";
const TZ = "America/Argentina/Buenos_Aires";

// ---- Imágenes mínimas con firma real ------------------------------------------------------
const b64 = (bytes: number[], pad = 40) => Buffer.from([...bytes, ...new Array(pad).fill(1)]).toString("base64");
const JPEG = b64([0xff, 0xd8, 0xff, 0xe0]);
const PNG = b64([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const WEBP = b64([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]);

const fail = (raw: unknown): HttpError | null => {
  try { parseImage(raw); return null; } catch (e) { return e instanceof HttpError ? e : null; }
};

(async () => {
  // 1. parseImage: sin imagen, válidas e inválidas
  ok(parseImage(undefined) === null && parseImage(null) === null, "sin imagen devuelve null");
  ok(parseImage({ mimeType: "image/jpeg", data: JPEG })?.data === JPEG, "JPEG válido");
  ok(parseImage({ mimeType: "image/png", data: PNG })?.mimeType === "image/png", "PNG válido");
  ok(parseImage({ mimeType: "image/webp", data: WEBP })?.mimeType === "image/webp", "WEBP válido");
  ok(parseImage({ mimeType: "image/jpeg", data: JPEG.slice(0, 20) + "\n" + JPEG.slice(20) })?.data === JPEG, "se ignoran los saltos de línea del base64");

  const cases: [string, unknown, number][] = [
    ["tipo no admitido (gif)", { mimeType: "image/gif", data: JPEG }, 400],
    ["tipo ausente", { data: JPEG }, 400],
    ["datos ausentes", { mimeType: "image/jpeg" }, 400],
    ["datos vacíos", { mimeType: "image/jpeg", data: "" }, 400],
    ["no es un objeto", "hola", 400],
    ["es un arreglo", [JPEG], 400],
    ["con prefijo data:", { mimeType: "image/jpeg", data: "data:image/jpeg;base64," + JPEG }, 400],
    ["base64 inválido", { mimeType: "image/jpeg", data: "@@@@" + JPEG }, 400],
    ["longitud no múltiplo de 4", { mimeType: "image/jpeg", data: JPEG + "A" }, 400],
    ["firma de PNG declarada como JPEG", { mimeType: "image/jpeg", data: PNG }, 400],
    ["firma de JPEG declarada como WEBP", { mimeType: "image/webp", data: JPEG }, 400],
    ["muy pesada", { mimeType: "image/jpeg", data: "A".repeat(MAX_IMAGE_BASE64_CHARS + 4) }, 413],
    ["enorme (corta antes de limpiar)", { mimeType: "image/jpeg", data: "A".repeat(Math.ceil(MAX_IMAGE_BASE64_CHARS * 1.2)) }, 413],
  ];
  for (const [name, raw, status] of cases) {
    const e = fail(raw);
    ok(e?.status === status, `${name}: debía dar ${status} y dio ${e?.status}`);
    ok(!e || typeof e.message === "string" && /[a-záéíóú]/i.test(e.message), `${name}: mensaje en español`);
  }
  ok(fail({ mimeType: "image/jpeg", data: "A".repeat(MAX_IMAGE_BASE64_CHARS + 4) })?.extra?.code === "image_too_large", "código image_too_large");

  // 2. El pedido a Gemini: imagen primero, texto después, y reglas de imagen en el prompt
  const base = { userId: "u1", timeZone: TZ, settings: { ...DEFAULT_SETTINGS, autonomyLevel: "suggestion" as const } };
  const img = parseImage({ mimeType: "image/jpeg", data: JPEG });
  reset(); script = [text("Es un volante de un concierto el 12/11.")];
  const r1 = await sendMessageToGemini({ ...base, message: "¿Qué dice este volante?", image: img });
  ok(r1.reply.content.includes("volante"), "responde con el texto del modelo");
  const sent = gem()[0].body;
  const lastUser = sent.contents[sent.contents.length - 1];
  ok(lastUser.role === "user" && lastUser.parts[0].inlineData?.data === JPEG && lastUser.parts[0].inlineData?.mimeType === "image/jpeg", "la imagen va primero como inlineData");
  ok(lastUser.parts[1].text === "¿Qué dice este volante?", "el texto del usuario va después de la imagen");
  const sys = sent.systemInstruction.parts[0].text as string;
  ok(sys.includes("Imágenes:") && sys.includes("datos de terceros") && sys.includes("[Imagen adjunta]"), "el prompt trae las reglas de imagen");

  // 3. Sin imagen: nada cambia (ni inlineData ni reglas extra)
  reset(); script = [text("Hola")];
  await sendMessageToGemini({ ...base, message: "¿Qué tengo mañana?" });
  const plain = gem()[0].body;
  ok(!JSON.stringify(plain.contents).includes("inlineData"), "sin imagen no hay inlineData");
  ok(!(plain.systemInstruction.parts[0].text as string).includes("Imágenes:"), "sin imagen el prompt no cambia");

  // 4. Imagen sin texto: se usa la petición por defecto
  reset(); script = [text("Listo")];
  await sendMessageToGemini({ ...base, message: "   ", image: img });
  ok(gem()[0].body.contents.at(-1).parts[1].text === IMAGE_ONLY_REQUEST, "imagen sin texto usa la petición por defecto");

  // 5. La imagen solo va en el mensaje actual: el historial sigue siendo texto
  reset(); script = [text("ok")];
  await sendMessageToGemini({ ...base, message: "mira", image: img, history: [{ role: "user", content: "[Imagen adjunta] hola" }, { role: "assistant", content: "Vi un volante." }] });
  const contents = gem()[0].body.contents;
  ok(contents.slice(0, -1).every((c: any) => c.parts.every((p: any) => !p.inlineData)), "el historial no lleva imágenes");

  // 6. Piloto Automático + imagen: la alarma NO se aplica sola (contenido de terceros); sin imagen sí
  const auto = { ...DEFAULT_SETTINGS, autonomyLevel: "autopilot" as const };
  reset(); script = [fnCall("set_alarm", { hour: 7, minute: 30 })];
  const withImg = await sendMessageToGemini({ ...base, settings: auto, message: "ponme alarma", image: img });
  ok((withImg.deviceAction as any)?.requiresConfirmation === true, "con imagen, en Piloto Automático, la alarma pide confirmación");
  reset(); script = [fnCall("set_alarm", { hour: 7, minute: 30 })];
  const noImg = await sendMessageToGemini({ ...base, settings: auto, message: "ponme alarma" });
  ok((noImg.deviceAction as any)?.requiresConfirmation === false, "sin imagen, en Piloto Automático, la alarma se aplica sola (comportamiento de siempre)");

  // 7. Proveedor alternativo: con imagen NO se usa (no entiende imágenes y sería enviarlas a un tercero)
  process.env.AI_ALT_BASE_URL = "https://alt.example.com/v1";
  process.env.AI_ALT_API_KEY = "k";
  process.env.AI_ALT_MODEL = "alt-model";
  reset(); script = [json({ error: { message: "overloaded" } }, 503), json({ error: { message: "overloaded" } }, 503), json({ error: { message: "overloaded" } }, 503), json({ error: { message: "overloaded" } }, 503)];
  let threw = false;
  try { await sendMessageToGemini({ ...base, message: "mira", image: img }); } catch (e) { threw = e instanceof HttpError; }
  ok(threw, "con imagen y Gemini caído se informa el error (sin pasar al alternativo)");
  ok(!calls.some((c) => c.url.includes("alt.example.com")), "no se llamó al proveedor alternativo con una imagen");
  delete process.env.AI_ALT_BASE_URL; delete process.env.AI_ALT_API_KEY; delete process.env.AI_ALT_MODEL;

  console.log(fails === 0 ? "OK: todas las pruebas de imagen pasaron" : `${fails} FALLAS`);
  process.exit(fails === 0 ? 0 : 1);
})();
