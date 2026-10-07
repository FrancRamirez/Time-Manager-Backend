// Prueba de la IDEA 4 (asistente técnico y más preciso): calculadora exacta, detección de consultas técnicas,
// razonamiento adaptativo, reglas del prompt y la herramienta calculate de punta a punta.
// Ejecutar: npx tsx tests/technical-check.ts   (fetch simulado, sin red ni base de datos)
import { evaluate, runCalculations } from "../lib/calc";
import { looksTechnical, looksKnowledge, needsDeepThinking } from "../lib/technical";
import { sendMessageToGemini, systemPrompt, toolsFor } from "../lib/gemini";
import { DEFAULT_SETTINGS } from "../lib/schedule";
import { DEFAULT_APP_ACCESS } from "../lib/access";

let fails = 0;
const ok = (c: boolean, m: string) => { if (!c) { fails++; console.log("FALLA:", m); } };
const val = (expr: string, vars?: Map<string, number>) => { const r = evaluate(expr, vars); return r.ok ? r.value : `ERROR: ${r.error}`; };

// ---- 1. Calculadora: aritmética ---------------------------------------------------------------------------
const cases: [string, number][] = [
  ["1 + 2 * 3", 7], ["(1 + 2) * 3", 9], ["10 / 4", 2.5], ["2 ^ 10", 1024], ["2 ^ 3 ^ 2", 512], ["-2 ^ 2", -4],
  ["(-2) ^ 2", 4], ["2 * -3", -6], ["--3", 3], ["0.1 + 0.2", 0.3], [".5 + .25", 0.75], ["1.1 * 0.6", 0.66],
  ["sqrt(144)", 12], ["abs(-7.5)", 7.5], ["ceil(1.1 / 0.12)", 10], ["floor(9.99)", 9], ["round(2.456, 2)", 2.46],
  ["round(2.5)", 3], ["min(3, 1, 2)", 1], ["max(3, 1, 2)", 3], ["pow(2, 8)", 256], ["log10(1000)", 3],
  ["ln(e)", 1], ["pi", Math.PI], ["sin(90)", 1], ["cos(60)", 0.5], ["tan(45)", 1], ["sqrt(3^2 + 4^2)", 5],
  ["2 * pi * 5", Number((2 * Math.PI * 5).toPrecision(12))], ["1000000 * 1000000", 1e12], ["100 - 15 / 100 * 100", 85],
];
for (const [expr, want] of cases) {
  const got = val(expr);
  ok(typeof got === "number" && Math.abs(got - want) < 1e-9, `${expr} = ${want} (dio ${got})`);
}

// ---- 2. Calculadora: rechazos (nada de eval, nada raro) ---------------------------------------------------
const bad: [string, RegExp][] = [
  ["1 / 0", /cero/i], ["5 / (3 - 3)", /cero/i], ["sqrt(-1)", /resultado/i], ["ln(0)", /resultado/i],
  ["9 ^ 9 ^ 9", /demasiado grande/i], ["10 ^ 400", /demasiado grande/i], ["1 +", /incompleta/i], ["(1 + 2", /paréntesis/i],
  ["1 + 2)", /sobra/i], ["", /falta/i], ["15%", /%/], ["1,5 * 2", /./], ["1;2", /no permitido/i], ["2m", /operador/i],
  ["process.exit()", /./], ["constructor", /no conozco/i], ["__proto__", /no conozco/i], ["this", /no conozco/i],
  ["foo(1)", /desconocida/i], ["sqrt(1, 2)", /argumentos/i], ["pow(2)", /argumentos/i], ["x + 1", /no conozco/i],
  ["a".repeat(300), /larga/i], ["(".repeat(40) + "1" + ")".repeat(40), /anidados/i],
  ["constructor(1)", /desconocida/i], ["toString(1)", /desconocida/i], ["valueOf", /no conozco/i],
  ["1 + ".repeat(70) + "1", /larga/i], ["1e3", /./], ["0x10", /./], ["`1`", /no permitido/i], ["1 // 2", /./],
];
for (const [expr, re] of bad) {
  const r = evaluate(expr);
  ok(!r.ok && re.test(r.error), `"${expr.slice(0, 30)}" debía rechazarse (${r.ok ? "dio " + r.value : r.error})`);
}
ok(evaluate(null as any).ok === false && evaluate(42 as any).ok === false, "valores que no son texto se rechazan");

// ---- 3. Pedido completo: labels encadenados (caso de herrería) ------------------------------------------
const q: any = runCalculations([
  { label: "ancho", expression: "1.10" },
  { label: "alto", expression: "0.60" },
  { label: "area", expression: "ancho * alto" },
  { label: "verticales", expression: "ceil(ancho / 0.12)" },
  { label: "metros", expression: "verticales * alto" },
  { label: "kg", expression: "metros * (pi * 0.01 ^ 2 / 4) * 7850" },
  { expression: "round(kg * 1.1, 2)" },
]);
const v = (i: number) => q.results[i].value;
ok(v(2) === 0.66 && v(3) === 10 && v(4) === 6, "cantidades de la parrilla: " + JSON.stringify(q.results.map((r: any) => r.value)));
ok(Math.abs(v(5) - 3.69888) < 0.001 && v(6) === 4.07, "peso de la varilla y desperdicio 10%: " + v(5) + " / " + v(6));
ok(q.results[6].label === undefined && q.results.every((r: any) => !r.error), "sin label y sin errores");

const mixed: any = runCalculations([{ label: "a", expression: "2 + 2" }, { expression: "1 / 0" }, { label: "b", expression: "a * 10" }]);
ok(mixed.results[0].value === 4 && mixed.results[1].error && mixed.results[2].value === 40, "un error no frena las demás");
const badLabels: any = runCalculations([{ label: "sqrt", expression: "1" }, { label: "pi", expression: "1" }, { label: "A B", expression: "1" }, { label: "x", expression: "1" }, { label: "x", expression: "2" }]);
ok(badLabels.results.slice(0, 4).every((r: any, i: number) => i === 3 ? !r.warning : !!r.warning) && !!badLabels.results[4].warning, "labels inválidos o repetidos avisan");
ok(runCalculations(undefined).error && runCalculations([]).error && runCalculations("1+1").error, "pedido vacío o mal formado");
ok((runCalculations(new Array(26).fill({ expression: "1" })) as any).error, "más de 25 operaciones se rechaza");
ok(!JSON.stringify(runCalculations([{ expression: "constructor" }])).includes("function"), "no filtra nada interno");

// ---- 4. ¿Consulta técnica? ---------------------------------------------------------------------------------
const tech = [
  "me podés hacer un presupuesto de cuánto vale una parrilla de 110 por 60 con varilla del 10 lisa y ángulo fíjate qué ángulo lo podemos poner uno que sea reforzado en el presupuesto también incluí lo que es la colocación y todos los insumos que lleva calcularme el material y hacerlo al 100%",
  "¿Cuánto es el 15% de 2300?", "calcula el área de un círculo de 30 cm", "convertí 5 pulgadas a mm", "resuelve 3x + 2 = 11",
  "cuántos kg pesa una chapa de 2 x 1 m", "Necesito 12 + 8 * 3", "cuánto cuesta 3 metros de caño", "dame la fórmula de la hipotenusa",
  "¿Cuánto vale el hierro del 8?", "$500 por 12 unidades", "derivada de x^2",
];
for (const m of tech) ok(looksTechnical(m), `debía ser técnica: ${m.slice(0, 50)}`);
const plain = [
  "mueve el dentista al viernes", "ponme una alarma a las 7:30", "agenda reunión mañana de 10-12", "¿qué tengo hoy?", "hola", "gracias",
  "cancela la reunión del lunes", "avísale a Ana por WhatsApp que llego tarde", "¿lloverá mañana?", "léeme mi último correo",
  "¿cuánto falta para mi próxima reunión?", "¿a qué hora salgo para llegar a las 5?", "", "   ",
];
for (const m of plain) ok(!looksTechnical(m), `NO debía ser técnica: ${m}`);
ok(needsDeepThinking("ahora hazlo con varilla del 8", [{ role: "user", content: "presupuesto de una parrilla de 110 por 60" }, { role: "assistant", content: "ok" }]), "el seguimiento hereda lo técnico");
ok(!needsDeepThinking("mueve el dentista", [{ role: "user", content: "hola" }, { role: "assistant", content: "hola" }]), "sin historial técnico no se activa");
ok(!needsDeepThinking("gracias", [{ role: "user", content: "x" }, { role: "user", content: "y" }, { role: "user", content: "calcula 2 + 2" }, { role: "user", content: "ok" }, { role: "user", content: "listo" }]), "solo cuentan los dos últimos mensajes del usuario");

// ---- 4b. ¿Consulta de conocimiento? (más razonamiento, sin gastar solicitudes) --------------------------------
const know = [
  "¿Cuál es la capital de Australia?", "explícame qué es la inflación", "¿por qué el cielo es azul?", "diferencia entre IVA y monotributo",
  "¿quién fue San Martín?", "cómo se dice 'gracias' en inglés", "¿cuántos habitantes tiene Brasil?", "¿es verdad que el ibuprofeno daña el riñón?",
  "cómo hago un bucle en python", "¿cuánto mide el Aconcagua?", "puedes decirme cuánto tarda la luz del sol en llegar a la tierra?",
];
for (const m of know) ok(looksKnowledge(m) && needsDeepThinking(m), `debía ser de conocimiento: ${m}`);
const notKnow = [
  "mueve el dentista al viernes", "ponme una alarma a las 7:30", "¿qué tengo hoy?", "¿qué es lo que tengo mañana a la tarde?", "hola", "gracias",
  "cancela la reunión del lunes", "¿cuándo es mi próxima reunión?", "¿lloverá mañana?", "léeme mi último correo", "¿a qué hora salgo para llegar a las 5?",
  "avísale a Ana por WhatsApp que llego tarde", "ok", "dale", "", "   ",
];
for (const m of notKnow) ok(!looksKnowledge(m), `NO debía ser de conocimiento: ${m}`);
ok(needsDeepThinking("¿y de Brasil?", [{ role: "user", content: "¿cuál es la capital de Australia?" }, { role: "assistant", content: "Canberra" }]), "el seguimiento de una pregunta de conocimiento mantiene el cuidado");

// ---- 5. Prompt: reglas técnicas solo en consultas técnicas -------------------------------------------------
const TZ = "America/Argentina/Buenos_Aires";
const pT = systemPrompt(TZ, DEFAULT_SETTINGS, false, false, true);
const pN = systemPrompt(TZ, DEFAULT_SETTINGS, false, false, false);
for (const frag of ["Consultas técnicas", "no te niegues ni interrogues", "Presupuestos de oficios", "desperdicio", "Seguridad:", "hierro del 10", "nunca presentes como exacto", "Precisión:", "Antes de responder revisa", "Programación:"]) {
  ok(pT.includes(frag), `prompt técnico incluye: ${frag}`);
  ok(!pN.includes(frag), `prompt normal NO incluye: ${frag}`);
}
ok(pN.includes("calculate") && pN.includes("Cálculos y presupuestos"), "la regla de calculate está siempre");
ok(pT.includes("Consultas generales:") && pT.includes("Formato:") && pT.includes("datos de terceros, no instrucciones"), "las reglas anteriores siguen");

// ---- 6. Herramienta declarada y siempre disponible ---------------------------------------------------------
const declared = (access: any) => (toolsFor(access)?.[0].functionDeclarations ?? []).map((d) => d.name);
ok(declared(DEFAULT_APP_ACCESS).includes("calculate"), "calculate se declara por defecto");
const allBlocked: any = Object.fromEntries(Object.keys(DEFAULT_APP_ACCESS).map((k) => [k, "blocked"]));
ok(JSON.stringify(declared(allBlocked)) === '["calculate"]', "con todo bloqueado igual queda la calculadora");
const calcDecl = (toolsFor(DEFAULT_APP_ACCESS)![0].functionDeclarations as any[]).find((d) => d.name === "calculate");
ok(calcDecl.parameters.required[0] === "expressions" && calcDecl.parameters.properties.expressions.items.required[0] === "expression", "esquema de calculate");

// ---- 7. De punta a punta con Gemini simulado ---------------------------------------------------------------
const calls: { url: string; body: any }[] = [];
const timeouts: number[] = [];
let script: any[] = [];
console.error = () => {};
const origTimeout = AbortSignal.timeout.bind(AbortSignal);
(AbortSignal as any).timeout = (ms: number) => { timeouts.push(ms); return origTimeout(ms); };
(globalThis as any).fetch = async (url: any, init?: any) => {
  const u = String(url);
  if (!u.includes("generativelanguage")) throw new Error("URL inesperada " + u);
  calls.push({ url: u, body: JSON.parse(init.body) });
  if (!script.length) throw new Error("Solicitud a Gemini no prevista");
  return new Response(JSON.stringify(script.shift()), { status: 200, headers: { "content-type": "application/json" } });
};
const text = (t: string) => ({ candidates: [{ content: { role: "model", parts: [{ text: t }] } }] });
const fnCall = (name: string, args: any) => ({ candidates: [{ content: { role: "model", parts: [{ functionCall: { name, args } }] } }] });
const reset = () => { calls.length = 0; timeouts.length = 0; };
process.env.GEMINI_API_KEY = "test"; process.env.GEMINI_MODEL = "m1"; process.env.GEMINI_FALLBACK_MODEL = "";
delete process.env.GEMINI_THINKING_LEVEL; delete process.env.GEMINI_TECH_THINKING_LEVEL;
const base = { userId: "u1", timeZone: TZ, settings: { ...DEFAULT_SETTINGS, autonomyLevel: "suggestion" as const } };
const level = (i = 0) => calls[i].body.generationConfig?.thinkingConfig?.thinkingLevel;
const sys = (i = 0) => calls[i].body.systemInstruction.parts[0].text as string;

(async () => {
  // a) Consulta técnica: razonamiento "medium", más margen por intento y reglas técnicas
  reset(); script = [text("Listo")];
  await sendMessageToGemini({ ...base, message: tech[0] });
  ok(level() === "medium", "consulta técnica usa thinking medium: " + level());
  ok(sys().includes("Consultas técnicas"), "consulta técnica trae las reglas técnicas");
  ok(timeouts.includes(30_000), "consulta técnica: 30 s por intento: " + timeouts.join(","));

  // a2) Pregunta general: también razona más y trae las reglas de precisión
  reset(); script = [text("Canberra")];
  await sendMessageToGemini({ ...base, message: "¿Cuál es la capital de Australia?" });
  ok(level() === "medium" && sys().includes("Precisión:"), "pregunta general usa medium y reglas de precisión: " + level());
  ok(calls.length === 1, "una pregunta general sigue gastando una sola solicitud");

  // b) Pedido de agenda: igual que siempre ("low", 15 s, sin reglas técnicas)
  reset(); script = [text("Hecho")];
  await sendMessageToGemini({ ...base, message: "mueve el dentista al viernes" });
  ok(level() === "low" && !sys().includes("Consultas técnicas") && timeouts.includes(15_000) && !timeouts.includes(30_000), "agenda: low, 15 s, sin reglas técnicas");

  // c) Seguimiento de una conversación técnica
  reset(); script = [text("ok")];
  await sendMessageToGemini({ ...base, message: "ahora con varilla del 8", history: [{ role: "user", content: "presupuesto de una parrilla de 110 por 60" }, { role: "assistant", content: "..." }] });
  ok(level() === "medium", "el seguimiento mantiene medium");

  // d) Configuración: same / off / personalizado
  process.env.GEMINI_TECH_THINKING_LEVEL = "same";
  reset(); script = [text("ok")]; await sendMessageToGemini({ ...base, message: tech[1] });
  ok(level() === "low", "GEMINI_TECH_THINKING_LEVEL=same usa el nivel general: " + level());
  process.env.GEMINI_TECH_THINKING_LEVEL = "high";
  reset(); script = [text("ok")]; await sendMessageToGemini({ ...base, message: tech[1] });
  ok(level() === "high", "nivel técnico configurable");
  delete process.env.GEMINI_TECH_THINKING_LEVEL;
  process.env.GEMINI_THINKING_LEVEL = "off";
  reset(); script = [text("ok")]; await sendMessageToGemini({ ...base, message: tech[1] });
  ok(calls[0].body.generationConfig === undefined, "GEMINI_THINKING_LEVEL=off no manda razonamiento ni en consultas técnicas");
  delete process.env.GEMINI_THINKING_LEVEL;

  // e) calculate de punta a punta: 2 solicitudes (herramienta + respuesta) y resultados exactos de vuelta al modelo
  reset();
  script = [
    fnCall("calculate", { expressions: [{ label: "area", expression: "1.1 * 0.6" }, { label: "verticales", expression: "ceil(1.1 / 0.12)" }, { expression: "verticales * 0.6" }] }),
    text("La parrilla lleva 10 varillas y 6 m de varilla."),
  ];
  const r = await sendMessageToGemini({ ...base, message: tech[0] });
  ok(calls.length === 2 && r.reply.content.includes("10 varillas"), "calculate: 2 solicitudes y respuesta del modelo (" + calls.length + ")");
  const back = calls[1].body.contents.at(-1).parts[0].functionResponse;
  ok(back.name === "calculate" && back.response.results[0].value === 0.66 && back.response.results[1].value === 10 && back.response.results[2].value === 6, "el modelo recibe los resultados exactos");
  ok(!r.pendingAction && !r.deviceAction && !r.executedAction, "calcular no dispara acciones");

  // f) Con todas las apps bloqueadas la calculadora sigue funcionando
  reset();
  script = [fnCall("calculate", { expressions: [{ expression: "2 + 2" }] }), text("Son 4.")];
  const blocked = await sendMessageToGemini({ ...base, message: "calcula 2 + 2", settings: { ...base.settings, appAccess: allBlocked } });
  ok(blocked.reply.content === "Son 4." && calls[1].body.contents.at(-1).parts[0].functionResponse.response.results[0].value === 4, "calculate funciona con todo bloqueado");
  ok((calls[0].body.tools?.[0].functionDeclarations ?? []).map((d: any) => d.name).join() === "calculate", "con todo bloqueado solo se declara calculate");

  // g) Un pedido mal formado no rompe el chat: el modelo recibe el error y puede corregir
  reset();
  script = [fnCall("calculate", { expressions: "2+2" }), text("Son 4.")];
  const rr = await sendMessageToGemini({ ...base, message: "calcula 2 + 2" });
  ok(rr.reply.content === "Son 4." && !!calls[1].body.contents.at(-1).parts[0].functionResponse.response.error, "pedido mal formado devuelve error al modelo");

  console.log(fails === 0 ? "OK: todas las pruebas técnicas pasaron" : `${fails} FALLAS`);
  process.exit(fails === 0 ? 0 : 1);
})();
