// Prueba de cotizaciones y conversión de monedas con fetch simulado (sin red). Ejecutar: npx tsx tests/finance-check.ts
import { parseFinanceRequest, parseAmount, normalizeCurrency, normalizeArType } from "../lib/financeText";
import { convertCurrency, runExchangeRates, runFinancePreload, clearFinanceCache, type ArQuote } from "../lib/finance";
import { planPreload, buildPreloadBlock } from "../lib/responseLevel";
import { toolsFor, TOOLS } from "../lib/gemini";
import { DEFAULT_APP_ACCESS } from "../lib/access";
import { sendMessageToGemini } from "../lib/gemini";

process.env.GEMINI_API_KEY = "test";

let fails = 0;
const ok = (c: boolean, m: string) => { if (!c) { fails++; console.log("FALLA:", m); } };
const eq = (a: unknown, b: unknown, m: string) => ok(JSON.stringify(a) === JSON.stringify(b), `${m}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`);

// ---- parser ------------------------------------------------------------------------------------------------
eq(parseAmount("1.500,50"), 1500.5, "1.500,50");
eq(parseAmount("1,500.50"), 1500.5, "1,500.50");
eq(parseAmount("2.500"), 2500, "2.500 = dos mil quinientos");
eq(parseAmount("0,5"), 0.5, "0,5");
eq(parseAmount("100"), 100, "100");
eq(parseAmount("abc"), null, "sin número");
eq(normalizeCurrency("Dólares"), "USD", "dólares");
eq(normalizeCurrency("eur"), "EUR", "eur");
eq(normalizeCurrency("pesos"), "ARS", "pesos");
eq(normalizeCurrency("blabla"), null, "desconocida");
eq(normalizeArType("dólar blue"), "blue", "blue");
eq(normalizeArType("MEP"), "bolsa", "mep");
eq(normalizeArType("ccl"), "contadoconliqui", "ccl");

eq(parseFinanceRequest("¿a cuánto está el dólar blue hoy?"), { arsType: "blue" }, "cotización blue");
eq(parseFinanceRequest("pasame 100 dólares blue a pesos")?.convert, { amount: 100, from: "USD", to: "ARS" }, "100 usd -> pesos");
eq(parseFinanceRequest("cuánto son 50.000 pesos en dólares")?.convert, { amount: 50000, from: "ARS", to: "USD" }, "50.000 pesos -> usd");
eq(parseFinanceRequest("convertí 200 euros a dólares")?.convert, { amount: 200, from: "EUR", to: "USD" }, "euros -> usd");
eq(parseFinanceRequest("cuánto es 1.500 usd en euros")?.convert, { amount: 1500, from: "USD", to: "EUR" }, "usd -> eur");
eq(parseFinanceRequest("a cuánto está el euro")?.convert, { amount: 1, from: "EUR", to: "ARS" }, "euro suelto");
eq(parseFinanceRequest("mueve el dentista al viernes"), null, "agenda no es finanzas");
eq(parseFinanceRequest("presupuesto de la parrilla en pesos, 110x60"), null, "presupuesto en pesos no es cotización");
eq(parseFinanceRequest("cuánto es el 15% de 2300"), null, "porcentaje no es cotización");
eq(parseFinanceRequest(""), null, "vacío");

// ---- conversión pura ---------------------------------------------------------------------------------------
const quotes: ArQuote[] = [
  { type: "oficial", name: "Oficial", buy: 1400, sell: 1450, updated: "2026-10-08T12:00:00.000Z" },
  { type: "blue", name: "Blue", buy: 1430, sell: 1450, updated: "2026-10-08T12:00:00.000Z" },
  { type: "bolsa", name: "MEP (Bolsa)", buy: 1440, sell: 1445, updated: null },
];
const usdRates = { USD: 1, EUR: 0.8, GBP: 0.75, BRL: 5 };
const c1: any = convertCurrency({ amount: 100, from: "USD", to: "ARS", arsType: "blue", quotes, usdRates });
eq(c1.result, 143000, "100 USD al blue = vender a la compra (1430)");
eq(c1.alternative.result, 145000, "alternativa a la venta (1450)");
const c2: any = convertCurrency({ amount: 145000, from: "ARS", to: "USD", arsType: "blue", quotes, usdRates });
eq(c2.result, 100, "145.000 ARS al blue = comprar a la venta (1450)");
const c3: any = convertCurrency({ amount: 100, from: "EUR", to: "USD", arsType: "oficial", quotes, usdRates });
eq(c3.result, 125, "100 EUR = 125 USD (EUR 0.8 por USD)");
const c4: any = convertCurrency({ amount: 80, from: "EUR", to: "ARS", arsType: "oficial", quotes, usdRates });
eq(c4.result, 140000, "80 EUR = 100 USD = 140.000 ARS oficial (compra)");
const c5: any = convertCurrency({ amount: 29000, from: "ARS", to: "EUR", arsType: "oficial", quotes, usdRates });
eq(c5.result, 16, "29.000 ARS = 20 USD = 16 EUR");
ok("error" in (convertCurrency({ amount: 1, from: "USD", to: "XYZ", arsType: "oficial", quotes, usdRates }) as any), "moneda sin cotización = error");
ok("error" in (convertCurrency({ amount: -5, from: "USD", to: "EUR", arsType: "oficial", quotes, usdRates }) as any), "cantidad negativa = error");
ok("error" in (convertCurrency({ amount: 1, from: "USD", to: "ARS", arsType: "cripto", quotes, usdRates }) as any), "tipo sin cotización = error");

// ---- herramienta con fetch simulado ------------------------------------------------------------------------
const urls: string[] = [];
let failAr = false, failFrank = false, failEr = false;
const dolares = [
  { moneda: "USD", casa: "oficial", nombre: "Oficial", compra: 1400, venta: 1450, fechaActualizacion: "2026-10-08T12:00:00.000Z" },
  { moneda: "USD", casa: "blue", nombre: "Blue", compra: 1430, venta: 1450, fechaActualizacion: "2026-10-08T12:00:00.000Z" },
  { moneda: "USD", casa: "otra", nombre: "X", compra: 1, venta: 1, fechaActualizacion: "" },
];
const geminiBodies: any[] = [];
globalThis.fetch = (async function (input: any, init?: any) {
  const url = typeof input === "string" ? input : input.url ?? String(input);
  urls.push(url);
  const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
  if (url.includes("generativelanguage")) { geminiBodies.push(JSON.parse(init?.body ?? "{}")); return json({ candidates: [{ content: { role: "model", parts: [{ text: "Son $143.000 al blue." }] } }] }); }
  if (url.startsWith("https://dolarapi.com/v1/dolares")) return failAr ? json({}, 500) : json(dolares);
  if (url.startsWith("https://api.frankfurter.dev/v1/latest")) return failFrank ? json({}, 500) : json({ base: "USD", date: "2026-10-07", rates: { EUR: 0.8, GBP: 0.75, BRL: 5, JPY: 150, CAD: 1.4 } });
  if (url.startsWith("https://open.er-api.com/v6/latest/USD")) return failEr ? json({}, 500) : json({ result: "success", time_last_update_utc: "Thu, 08 Oct 2026 00:02:31 +0000", rates: { USD: 1, EUR: 0.81, VES: 40, AED: 3.67 } });
  throw new Error("URL inesperada: " + url);
}) as any;

(async () => {
  const r1: any = await runExchangeRates({});
  eq(r1.argentina_dollars.length, 2, "solo los tipos conocidos de dolarapi");
  ok(!("conversion" in r1), "sin par no hay conversión");
  ok(r1.sources.includes("dolarapi.com"), "cita la fuente");

  const r2: any = await runExchangeRates({ amount: 100, from: "usd", to: "pesos", ars_type: "blue" });
  eq(r2.conversion.result, 143000, "herramienta: 100 USD blue");
  ok(!r2.notes.some((n: string) => n.includes("OFICIAL")), "con tipo indicado no avisa del oficial");

  const r3: any = await runExchangeRates({ amount: 100, from: "USD", to: "ARS" });
  ok(r3.notes.some((n: string) => n.includes("OFICIAL")), "sin tipo avisa que usó el oficial");
  eq(r3.conversion.ars_type, "oficial", "usó oficial");

  const r4: any = await runExchangeRates({ amount: 10, from: "EUR", to: "GBP" });
  eq(r4.conversion.result, 9.38, "10 EUR -> GBP (0.75/0.8)");
  ok(!("argentina_dollars" in r4), "sin pesos no trae el dólar argentino");
  ok(r4.sources.some((s: string) => s.includes("Frankfurter")), "fuente Frankfurter");

  const before = urls.length;
  await runExchangeRates({ amount: 10, from: "EUR", to: "GBP" });
  eq(urls.length, before, "segunda consulta usa la memoria (sin red)");

  const r5: any = await runExchangeRates({ amount: 10, from: "USD", to: "AED" });
  eq(r5.conversion.result, 36.7, "AED sale de ExchangeRate-API (Frankfurter no la tiene)");
  ok(r5.sources.some((s: string) => s.includes("ExchangeRate-API")), "cita ExchangeRate-API");

  ok("error" in (await runExchangeRates({ from: "USD", to: "???" })), "moneda inválida = error");
  ok("error" in (await runExchangeRates({ amount: "abc", from: "USD", to: "EUR" })), "monto inválido = error");
  ok("error" in (await runExchangeRates({ from: "USD", to: "ARS", ars_type: "nada" })), "tipo inválido = error");

  // Caída de los servicios.
  clearFinanceCache(); failAr = true;
  const e1: any = await runExchangeRates({ amount: 1, from: "USD", to: "ARS" });
  ok("error" in e1, "dolarapi caído y sin memoria = error claro");
  failAr = false; await runExchangeRates({}); // llena la memoria
  failAr = true; clearFinanceCache(); // (limpia: prueba abajo con memoria vieja)
  failAr = false; await runExchangeRates({}); failAr = true;
  // Memoria vigente: no llama a la red.
  const s1: any = await runExchangeRates({});
  ok(!("error" in s1), "con memoria vigente responde aunque el servicio esté caído");

  // Frankfurter caído: usa ExchangeRate-API.
  clearFinanceCache(); failAr = false; failFrank = true;
  const f1: any = await runExchangeRates({ amount: 10, from: "USD", to: "EUR" });
  eq(f1.conversion.result, 8.1, "Frankfurter caído: respaldo ExchangeRate-API");
  failFrank = false;

  // Todo caído.
  clearFinanceCache(); failFrank = true; failEr = true;
  const f2: any = await runExchangeRates({ amount: 10, from: "USD", to: "EUR" });
  ok("error" in f2, "todo caído = error");
  failFrank = false; failEr = false; clearFinanceCache();

  // ---- pre-carga ---------------------------------------------------------------------------------------
  const plan = planPreload({ message: "pasame 100 dólares blue a pesos", level: "low" });
  ok(plan.finance?.convert?.amount === 100, "planPreload detecta la conversión");
  ok(planPreload({ message: "pasame 100 dólares blue a pesos" }).agendaDays === null, "una conversión no lee la agenda aunque diga \"pasame\"");
ok(planPreload({ message: "pasame el dentista al viernes" }).agendaDays !== null, "mover un evento sigue leyendo la agenda");
ok(planPreload({ message: "mueve el dentista al viernes" }).finance === null, "agenda: sin pre-carga de cotizaciones");
  ok(planPreload({ message: "100 dólares a pesos", hasImage: true }).finance === null, "con imagen no se adelanta nada");

  const p1: any = await runFinancePreload(plan.finance!);
  eq(p1.conversions.length, 1, "tipo nombrado: una conversión");
  eq(p1.conversions[0].result, 143000, "pre-carga: 100 USD blue");
  const p2: any = await runFinancePreload({ convert: { amount: 100, from: "USD", to: "ARS" }, arsType: null });
  eq(p2.conversions.length, 2, "sin tipo: oficial y blue");
  const p3: any = await runFinancePreload({ arsType: null });
  ok(p3 && p3.argentina_dollars.length === 2, "solo cotizaciones");

  const block = buildPreloadBlock({ finance: p1 });
  ok(block.includes("COTIZACIONES EN TIEMPO REAL") && block.includes("143000"), "el bloque incluye cotizaciones y la cuenta hecha");

  // ---- de punta a punta: el modelo recibe las cotizaciones y la cuenta hecha, en UNA sola solicitud ------------
  for (const level of ["low", "medium"] as const) {
    geminiBodies.length = 0;
    const reply = await sendMessageToGemini({
      userId: "u1",
      message: "pasame 100 dólares blue a pesos",
      timeZone: "America/Argentina/Buenos_Aires",
      settings: { ...(await import("../lib/schedule")).DEFAULT_SETTINGS, responseLevel: level },
    } as any);
    ok(geminiBodies.length === 1, `${level}: una sola solicitud a la IA (fueron ${geminiBodies.length})`);
    const sent = JSON.stringify(geminiBodies[0] ?? {});
    ok(sent.includes("COTIZACIONES EN TIEMPO REAL") && sent.includes("143000"), `${level}: el modelo recibe las cotizaciones y la cuenta hecha`);
    ok(reply.reply.content.includes("143.000"), `${level}: la respuesta llega al usuario`);
  }

  // ---- herramientas declaradas -------------------------------------------------------------------------
  const all = toolsFor(DEFAULT_APP_ACCESS, "medium")![0].functionDeclarations.map((d) => d.name);
  ok(all.includes("get_exchange_rates"), "Media declara la herramienta");
  const low = toolsFor(DEFAULT_APP_ACCESS, "low")![0].functionDeclarations.map((d) => d.name);
  ok(!low.includes("get_exchange_rates"), "Baja no la declara (usa la pre-carga)");
  ok(TOOLS.flatMap((g) => g.functionDeclarations).some((d) => d.name === "get_exchange_rates"), "está en TOOLS");

  console.log(fails ? `${fails} FALLAS` : "finance-check: todo bien");
  process.exit(fails ? 1 : 0);
})();
