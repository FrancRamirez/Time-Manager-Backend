// Prueba del idioma (Español / Inglés) en el servidor. Ejecutar: npx tsx tests/lang-check.ts   (sin red ni base de datos)
import { parseLang, runWithLang, currentLang, tr } from "../lib/lang";
import { route } from "../lib/http";
import { quickReply } from "../lib/quickReply";
import { parseSettings, formatWhen, DEFAULT_SETTINGS } from "../lib/schedule";
import { forecastTemplate, lowNeedsMoreStepsText, LOW_NEEDS_MORE_STEPS } from "../lib/responseLevel";
import { describeDays, describeAlarm } from "../lib/clock";
import { describeDidi } from "../lib/didi";
import { describeMaps } from "../lib/maps";
import { describeSms, describeCall } from "../lib/phoneActions";
import { describeWhatsapp } from "../lib/whatsapp";
import { sendMessageToGemini } from "../lib/gemini";

process.env.GEMINI_API_KEY = "test";
(async () => {
let fails = 0;
const ok = (c: boolean, m: string) => { if (!c) { fails++; console.log("FALLA:", m); } };
const eq = (a: unknown, b: unknown, m: string) => ok(JSON.stringify(a) === JSON.stringify(b), `${m}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`);
const en = <T>(fn: () => T) => runWithLang("en", fn);

// parseLang / tr
eq(parseLang("en"), "en", "en"); eq(parseLang("en-US"), "en", "en-US"); eq(parseLang("EN_gb"), "en", "EN_gb");
eq(parseLang("es"), "es", "es"); eq(parseLang("fr"), "es", "otro = es"); eq(parseLang(undefined), "es", "sin valor = es"); eq(parseLang(5), "es", "no texto = es");
eq(currentLang(), "es", "sin contexto = es"); eq(tr("hola", "hi"), "hola", "tr sin contexto"); eq(en(() => tr("hola", "hi")), "hi", "tr en inglés");

// Ajustes: el idioma viaja y se valida
eq(parseSettings({ language: "en" }).language, "en", "settings.language en");
eq(parseSettings({ language: "xx" }).language, "es", "settings.language inválido = es");
eq(parseSettings({}).language, "es", "sin language = es");
eq(DEFAULT_SETTINGS.language, "es", "default es");

// route(): idioma por encabezado o por settings del cuerpo
const handler = route(["POST"], async (req, res) => { res.status(200).json({ lang: currentLang() }); });
const call = async (req: any) => { const r: any = { code: 0, body: null, setHeader() {}, status(c: number) { r.code = c; return r; }, json(b: any) { r.body = b; return r; } }; await handler(req, r); return r; };
eq((await call({ method: "POST", headers: { "x-app-language": "en" }, body: {}, url: "/x" })).body.lang, "en", "encabezado en");
eq((await call({ method: "POST", headers: { "x-app-language": "es" }, body: { settings: { language: "en" } }, url: "/x" })).body.lang, "es", "el encabezado manda");
eq((await call({ method: "POST", headers: {}, body: { settings: { language: "en" } }, url: "/x" })).body.lang, "en", "sin encabezado: settings.language");
eq((await call({ method: "POST", headers: {}, body: {}, url: "/x" })).body.lang, "es", "versión vieja de la app = es");
const bad = await call({ method: "GET", headers: { "x-app-language": "en" }, body: {}, url: "/x" });
eq([bad.code, bad.body.error], [405, "Method not allowed"], "error 405 en inglés");

// Saludos rápidos
ok(/hola|ayudo/i.test(quickReply("hola")!), "hola -> español");
ok(/help/i.test(quickReply("hello")!) , "hello -> inglés");
ok(/welcome|pleasure|anytime/i.test(quickReply("thanks")!), "thanks -> inglés");
ok(/welcome|pleasure|anytime/i.test(quickReply("Thank you so much!")!), "thank you so much");
ok(/see you|bye/i.test(quickReply("bye")!), "bye -> inglés");
eq(quickReply("hello, move my meeting to friday"), null, "pedido real va al modelo");
eq(quickReply("thanks, can you also check my calendar"), null, "gracias + pedido va al modelo");

// Fechas y descripciones
const t0 = Date.parse("2026-10-09T18:45:00Z");
ok(/vie/.test(formatWhen(t0, "UTC")) && /18:45/.test(formatWhen(t0, "UTC")), "formatWhen es");
ok(/Fri/.test(en(() => formatWhen(t0, "UTC"))) && /PM/.test(en(() => formatWhen(t0, "UTC"))), "formatWhen en (12 h)");
eq(en(() => describeDays(["mon", "tue", "wed", "thu", "fri"])), "Monday to Friday", "días en inglés");
eq(describeDays(["mon", "tue", "wed", "thu", "fri"]), "de lunes a viernes", "días en español");
eq(en(() => describeDays(["sat", "sun"])), "weekends", "fin de semana");
ok(/Mon, Wed/.test(en(() => describeDays(["mon", "wed"]))), "días sueltos en inglés");
ok(/Abrir DiDi/.test(describeDidi({ kind: "didi_open", destination: "Aeropuerto" } as any)), "didi es");
ok(/Open DiDi/.test(en(() => describeDidi({ kind: "didi_open", destination: "Aeropuerto" } as any))), "didi en");
ok(/Open Google Maps with the route by car/.test(en(() => describeMaps({ kind: "maps_open", destination: "X", mode: "drive" } as any))), "maps en");
ok(/Abrir Google Maps con la ruta en auto/.test(describeMaps({ kind: "maps_open", destination: "X", mode: "drive" } as any)), "maps es");
ok(/Open your messaging app with this text for Ana/.test(en(() => describeSms({ kind: "sms_send", contactName: "Ana", message: "hi" } as any))), "sms en");
ok(/Open the dialer with Ana's number/.test(en(() => describeCall({ kind: "call_dial", contactName: "Ana" } as any))), "llamada en");
ok(/Open WhatsApp with this message for Ana/.test(en(() => describeWhatsapp({ kind: "whatsapp_send", contactName: "Ana", message: "hi" } as any))), "whatsapp en");
ok(/Abrir WhatsApp con este mensaje para Ana/.test(describeWhatsapp({ kind: "whatsapp_send", contactName: "Ana", message: "hi" } as any)), "whatsapp es");

// Pronóstico y aviso del nivel Baja
const fc = { location: "Córdoba", now: { temp_c: 21, conditions: "soleado" }, daily: [{ date: "2026-10-09", conditions: "sol", min_c: 12, max_c: 24, rain_chance_pct: 10 }, { date: "2026-10-10", min_c: 11, max_c: 22 }, { date: "2026-10-11" }] };
const fes = forecastTemplate(fc)!, fen = en(() => forecastTemplate(fc))!;
ok(/Pronóstico en Córdoba:/.test(fes) && /Hoy: sol, 12 a 24 °C, lluvia 10 %/.test(fes) && /Mañana/.test(fes) && /sin temperatura/.test(fes), "pronóstico es");
ok(/Forecast in Córdoba:/.test(fen) && /Today: sol, 12 to 24 °C, rain 10 %/.test(fen) && /Tomorrow/.test(fen) && /no temperature/.test(fen) && /Sunday/.test(fen), "pronóstico en");
eq(lowNeedsMoreStepsText(), LOW_NEEDS_MORE_STEPS, "aviso Baja es");
ok(/Answer level to Medium/.test(en(() => lowNeedsMoreStepsText())), "aviso Baja en");

// Frami de punta a punta: el modelo recibe la regla de idioma y el texto final sale en inglés
const bodies: any[] = [];
const json = (b: any) => new Response(JSON.stringify(b), { status: 200, headers: { "content-type": "application/json" } });
(globalThis as any).fetch = async (url: any, init?: any) => {
  const u = String(url);
  if (u.includes("generativelanguage")) {
    const body = JSON.parse(init?.body ?? "{}"); bodies.push(body);
    return json({ candidates: [{ content: { role: "model", parts: [{ text: "Sure." }] } }] });
  }
  throw new Error("URL inesperada " + u);
};
const input = (lang: "es" | "en") => ({ userId: "u1", message: "what can you do?", timeZone: "America/Argentina/Buenos_Aires", settings: { ...DEFAULT_SETTINGS, language: lang } } as any);
await runWithLang("en", () => sendMessageToGemini(input("en")));
const sysEn = JSON.stringify(bodies.at(-1).systemInstruction ?? bodies.at(-1).system_instruction ?? {});
ok(/IDIOMA: responde en inglés/.test(sysEn) && !/Responde en español neutro/.test(sysEn), "prompt en inglés lleva la regla de idioma");
await runWithLang("es", () => sendMessageToGemini(input("es")));
const sysEs = JSON.stringify(bodies.at(-1).systemInstruction ?? bodies.at(-1).system_instruction ?? {});
ok(/Responde en español neutro/.test(sysEs) && !/IDIOMA: responde en inglés/.test(sysEs), "prompt en español");

console.log(fails ? `${fails} FALLAS` : "lang-check: todo bien");
process.exit(fails ? 1 : 0);
})();
