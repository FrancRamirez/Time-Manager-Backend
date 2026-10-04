// Prueba de SMS y llamadas (compose_sms / compose_call) con Gemini simulado. Ejecutar: npx tsx tests/phone-check.ts
import { parseDialablePhone, cleanSmsMessage, describeSms, describeCall, MAX_SMS_CHARS } from "../lib/phoneActions";
import { sendMessageToGemini, toolsFor } from "../lib/gemini";
import { DEFAULT_APP_ACCESS, toolAllowed, parseAppAccess } from "../lib/access";

let fails = 0;
const ok = (c: boolean, m: string) => { if (!c) { fails++; console.log("FALLA:", m); } };

// ---- Gemini simulado ----------------------------------------------------------------------
let script: any[] = [];
let geminiCalls = 0;
const json = (b: any) => new Response(JSON.stringify(b), { status: 200, headers: { "content-type": "application/json" } });
(globalThis as any).fetch = async (url: any) => {
  if (String(url).includes("generativelanguage")) { geminiCalls++; return json(script.shift()); }
  throw new Error("URL inesperada " + url);
};
const fnCall = (name: string, args: any = {}) => ({ candidates: [{ content: { role: "model", parts: [{ functionCall: { name, args } }] } }] });
const text = (t: string) => ({ candidates: [{ content: { role: "model", parts: [{ text: t }] } }] });
process.env.GEMINI_API_KEY = "test";

const settings = (level: "suggestion" | "autopilot", access: any = {}) => ({
  autonomyLevel: level, dailyActionLimit: 100, bufferMinutes: 0, blockedHours: [],
  appAccess: { ...DEFAULT_APP_ACCESS, ...access },
}) as any;
const base = { userId: "u1", message: "x", timeZone: "America/Argentina/Buenos_Aires" };

(async () => {
  // 1. Validación de números: local e internacional, con separadores; nunca letras, * ni #
  const good: [string, string][] = [
    ["+54 9 11 2345-6789", "+5491123456789"], ["11 2345 6789", "1123456789"], ["(011) 4567.8901", "01145678901"],
    ["0054 9 351 555 1234", "00549351555 1234".replace(" ", "")], ["911", "911"], ["  +1 (415) 555-0100 ", "+14155550100"],
  ];
  for (const [raw, want] of good) ok(parseDialablePhone(raw) === want, `número válido "${raw}" -> ${parseDialablePhone(raw)} (esperado ${want})`);
  for (const bad of ["*#06#", "*123#", "#31#123456", "11 abc", "", "  ", "12", "1".repeat(16), "+", "1+2345678", "11-2345-6789; rm", null, undefined, 5491123456789, {}])
    ok(parseDialablePhone(bad as any) === null, `número inválido: ${JSON.stringify(bad)}`);

  // 2. Mensaje
  ok(cleanSmsMessage("  Hola\r\nmundo ") === "Hola\nmundo", "limpia espacios y saltos");
  ok(cleanSmsMessage("") === null && cleanSmsMessage("a".repeat(MAX_SMS_CHARS + 1)) === null && cleanSmsMessage(7) === null, "vacío, largo o no-texto = null");
  ok(cleanSmsMessage("a".repeat(MAX_SMS_CHARS)) !== null, "el tope exacto se acepta");

  // 3. Descripciones: lo que ve el usuario al confirmar
  ok(describeSms({ kind: "sms_send", message: "Hola", contactName: "Ana", phone: "+54911" }).includes("Ana (+54911)"), "SMS: nombre y número");
  ok(describeSms({ kind: "sms_send", message: "Hola" }).includes("elegirás el contacto"), "SMS sin destinatario");
  ok(describeCall({ kind: "call_dial", phone: "1123456789" }).includes("1123456789") && describeCall({ kind: "call_dial", contactName: "Ana" }).includes("Ana"), "llamada: describe destino");

  // 4. Flujo: en Piloto Automático SMS y llamadas IGUAL piden confirmación (abren otra app)
  for (const level of ["autopilot", "suggestion"] as const) {
    script = [fnCall("compose_sms", { message: "Llego en 10", contact_name: "Ana" }), text("Listo, confírmalo en la app.")];
    const r = await sendMessageToGemini({ ...base, settings: settings(level) });
    const d: any = r.deviceAction;
    ok(d?.kind === "sms_send" && d.requiresConfirmation === true && d.contactName === "Ana" && d.message === "Llego en 10", `SMS (${level}) pide confirmación`);
    script = [fnCall("compose_call", { phone: "11 2345 6789" }), text("Listo.")];
    const c: any = (await sendMessageToGemini({ ...base, settings: settings(level) })).deviceAction;
    ok(c?.kind === "call_dial" && c.requiresConfirmation === true && c.phone === "1123456789", `llamada (${level}) pide confirmación y normaliza el número`);
  }

  // 5. Entradas inválidas: no se arma ninguna acción
  for (const [tool, args, why] of [
    ["compose_sms", { message: "" }, "SMS sin texto"],
    ["compose_sms", { message: "hola", phone: "*#06#" }, "SMS con código USSD"],
    ["compose_call", {}, "llamada sin destino"],
    ["compose_call", { phone: "*123#" }, "llamada con código USSD"],
    ["compose_call", { phone: "12" }, "llamada con número demasiado corto"],
  ] as const) {
    script = [fnCall(tool, args), text("No se pudo.")];
    const r = await sendMessageToGemini({ ...base, settings: settings("autopilot") });
    ok(!r.deviceAction, `no debe armar acción: ${why}`);
  }

  // 6. Una sola acción por mensaje
  script = [fnCall("compose_sms", { message: "a", contact_name: "Ana" }), fnCall("compose_call", { contact_name: "Ana" }), text("ok")];
  const two = await sendMessageToGemini({ ...base, settings: settings("autopilot") });
  ok((two.deviceAction as any)?.kind === "sms_send", "con dos acciones en un mensaje solo queda la primera");

  // 7. Restringir aplicaciones: SMS y Llamadas son apps propias, solo Permitido / Bloqueada
  const names = (a: any) => (toolsFor(a)?.[0].functionDeclarations ?? []).map((d: any) => d.name);
  ok(names(DEFAULT_APP_ACCESS).includes("compose_sms") && names(DEFAULT_APP_ACCESS).includes("compose_call"), "por defecto se declaran");
  ok(!names({ ...DEFAULT_APP_ACCESS, sms: "blocked" }).includes("compose_sms") && names({ ...DEFAULT_APP_ACCESS, sms: "blocked" }).includes("compose_call"), "bloquear SMS no afecta a Llamadas");
  ok(!names({ ...DEFAULT_APP_ACCESS, calls: "blocked" }).includes("compose_call") && names({ ...DEFAULT_APP_ACCESS, calls: "blocked" }).includes("compose_sms"), "bloquear Llamadas no afecta a SMS");
  ok(!toolAllowed({ ...DEFAULT_APP_ACCESS, calls: "blocked" }, "compose_call"), "segunda capa: toolAllowed rechaza");
  ok(parseAppAccess({ sms: "read_only" }).sms === "blocked" && parseAppAccess({ calls: "read_only" }).calls === "blocked", "no admiten solo lectura (inválido = bloqueado)");
  ok(parseAppAccess({}).sms === "allowed" && parseAppAccess({}).calls === "allowed", "ausentes = permitido");

  // 8. Aunque el modelo pidiera la herramienta bloqueada, runTool la rechaza (segunda capa)
  script = [fnCall("compose_call", { phone: "1123456789" }), text("No puedo llamar: está bloqueado.")];
  const blocked = await sendMessageToGemini({ ...base, settings: settings("autopilot", { calls: "blocked" }) });
  ok(!blocked.deviceAction, "con Llamadas bloqueada no se arma la acción aunque el modelo la pida");

  console.log(fails === 0 ? "TODO OK" : `${fails} fallas`);
})();
