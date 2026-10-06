// Prueba de DiDi (open_didi) con Gemini simulado (sin red).
// Ejecutar: npx tsx tests/didi-check.ts
import { sendMessageToGemini, systemPrompt } from "../lib/gemini";
import { cleanDidiDestination, describeDidi } from "../lib/didi";
import { DEFAULT_SETTINGS } from "../lib/schedule";

let fails = 0;
const ok = (c: boolean, m: string) => { if (!c) { fails++; console.log("FALLA:", m); } };

const calls: { url: string; body?: any }[] = [];
let geminiScript: any[] = [];
const json = (b: any) => new Response(JSON.stringify(b), { status: 200, headers: { "content-type": "application/json" } });
(globalThis as any).fetch = async (url: any, init?: any) => {
  const u = String(url);
  calls.push({ url: u, body: init?.body ? JSON.parse(init.body) : undefined });
  if (u.includes("generativelanguage")) return json(geminiScript.shift());
  throw new Error("URL inesperada (DiDi no debe llamar a ninguna API): " + u);
};
const fnCall = (name: string, args: any = {}) => ({ candidates: [{ content: { role: "model", parts: [{ functionCall: { name, args } }] } }] });
const text = (t: string) => ({ candidates: [{ content: { role: "model", parts: [{ text: t }] } }] });
const gemini = () => calls.filter((c) => c.url.includes("generativelanguage"));
const lastTool = () => JSON.stringify(gemini().at(-1)!.body.contents.at(-1));
const reset = () => { calls.length = 0; };

process.env.GEMINI_API_KEY = "test";
const TZ = "America/Argentina/Buenos_Aires";
const base = { userId: "u1", message: "Pedime un DiDi a la oficina", timeZone: TZ };

(async () => {
  // 1. Validación pura
  ok(cleanDidiDestination("  Av.  Colón\n 100 ") === "Av. Colón 100", "limpia espacios y saltos de línea");
  ok(cleanDidiDestination("x") === null && cleanDidiDestination(5) === null, "rechaza texto corto o no texto");
  ok(describeDidi({ kind: "didi_open", destination: "Centro" }).includes("no se pide solo"), "la descripción aclara que no pide el viaje");

  // 2. Siempre con confirmación (también en Piloto Automático) y sin llamar a ninguna API
  for (const level of ["suggestion", "autopilot"] as const) {
    reset(); geminiScript = [fnCall("open_didi", { destination: "Av. Colón 100, Córdoba" }), text("Listo.")];
    const r = await sendMessageToGemini({ ...base, settings: { ...DEFAULT_SETTINGS, autonomyLevel: level } });
    const d = r.deviceAction as any;
    ok(d?.kind === "didi_open" && d.destination === "Av. Colón 100, Córdoba" && d.requiresConfirmation === true, `abre DiDi con confirmación (${level})`);
    ok(typeof d.description === "string" && d.description.includes("¿A dónde vas?"), "descripción armada por el servidor");
  }

  // 3. Sin destino: abre DiDi igual
  reset(); geminiScript = [fnCall("open_didi", {}), text("Listo.")];
  const d3 = (await sendMessageToGemini(base)).deviceAction as any;
  ok(d3?.kind === "didi_open" && d3.destination === undefined && d3.requiresConfirmation === true, "sin destino abre DiDi");

  // 4. Destino inválido: no abre nada
  reset(); geminiScript = [fnCall("open_didi", { destination: "x" }), text("Falta.")];
  ok((await sendMessageToGemini(base)).deviceAction === undefined && lastTool().includes("no es un texto válido"), "destino inválido no abre nada");

  // 5. Una sola acción de escritura por mensaje
  reset(); geminiScript = [fnCall("open_didi", { destination: "Centro" }), fnCall("open_maps_route", { destination: "Centro" }), text("ok")];
  ok(((await sendMessageToGemini(base)).deviceAction as any)?.kind === "didi_open", "solo una acción por mensaje (queda la primera)");

  // 6. DiDi bloqueado: ni se declara y el prompt lo explica; Maps sigue disponible
  reset(); geminiScript = [text("No puedo usar DiDi.")];
  await sendMessageToGemini({ ...base, settings: { ...DEFAULT_SETTINGS, appAccess: { ...DEFAULT_SETTINGS.appAccess, didi: "blocked" } } });
  const declared = JSON.stringify(gemini()[0].body.tools);
  ok(!declared.includes("open_didi") && declared.includes("open_maps_route"), "con DiDi bloqueado no se declara open_didi (Maps sigue)");
  ok(JSON.stringify(gemini()[0].body.systemInstruction).includes("DiDi: BLOQUEADA"), "el prompt informa la restricción");

  // 7. El prompt describe la capacidad y sus límites
  const prompt = systemPrompt(TZ, DEFAULT_SETTINGS, false);
  ok(prompt.includes("open_didi") && prompt.includes("No puedes pedir, cotizar ni cancelar viajes"), "el prompt explica DiDi y sus límites");

  if (fails) { console.log(`\n${fails} FALLA(S)`); process.exit(1); }
  console.log("TODO OK");
})();
