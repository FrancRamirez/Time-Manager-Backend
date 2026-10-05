// Prueba del pronóstico con fetch simulado (sin red). Ejecutar: npx tsx tests/weather-check.ts
import { parseLocation, compactForecast, geocodeCity, fetchForecast, describeWeatherCode } from "../lib/weather";
import { sendMessageToGemini } from "../lib/gemini";

let fails = 0;
const ok = (c: boolean, m: string) => { if (!c) { fails++; console.log("FALLA:", m); } };

// ---- fetch simulado ----------------------------------------------------------------------
const calls: { url: string; body?: any }[] = [];
let geminiScript: any[] = [];
let geoResults: any[] = [];
const hours = Array.from({ length: 72 }, (_, i) => {
  const d = new Date(Date.UTC(2026, 9, 3, 0, 0) + i * 3600_000);
  return d.toISOString().slice(0, 13) + ":00";
});
const forecastBody = {
  timezone: "America/Argentina/Buenos_Aires",
  current: { time: "2026-10-03T19:15", temperature_2m: 18.46, apparent_temperature: 17.2, weather_code: 3, precipitation: 0 },
  hourly: {
    time: hours,
    temperature_2m: hours.map((_, i) => 10 + i / 10),
    precipitation_probability: hours.map((_, i) => (i === 21 ? null : i)),
    precipitation: hours.map(() => 0.04),
    weather_code: hours.map(() => 61),
  },
  daily: {
    time: ["2026-10-03", "2026-10-04", "2026-10-05", "2026-10-06"],
    weather_code: [3, 61, 0, 95],
    temperature_2m_max: [22.4, 19.6, 25, 28],
    temperature_2m_min: [11.2, 9.5, 12, 16],
    precipitation_probability_max: [10, 80, 0, 90],
    precipitation_sum: [0, 6.34, 0, 12],
  },
};
const json = (b: any) => new Response(JSON.stringify(b), { status: 200, headers: { "content-type": "application/json" } });
(globalThis as any).fetch = async (url: any, init?: any) => {
  const u = String(url);
  calls.push({ url: u, body: init?.body ? JSON.parse(init.body) : undefined });
  if (u.includes("generativelanguage")) return json(geminiScript.shift());
  if (u.includes("geocoding-api")) return json({ results: geoResults });
  if (u.startsWith("https://api.open-meteo.com") || u.startsWith("https://customer-api.open-meteo.com")) return json(forecastBody);
  throw new Error("URL inesperada " + u);
};
const fnCall = (name: string, args: any = {}) => ({ candidates: [{ content: { role: "model", parts: [{ functionCall: { name, args } }] } }] });
const text = (t: string) => ({ candidates: [{ content: { role: "model", parts: [{ text: t }] } }] });
const gemini = () => calls.filter((c) => c.url.includes("generativelanguage"));
const meteo = () => calls.filter((c) => c.url.startsWith("https://api.open-meteo.com"));
const reset = () => { calls.length = 0; };

process.env.GEMINI_API_KEY = "test";

(async () => {
  // 1. Validación de ubicación
  const L = parseLocation({ lat: -31.420123, lon: -64.188776 });
  ok(L?.lat === -31.42 && L?.lon === -64.19, "redondea a 2 decimales");
  for (const bad of [null, undefined, "x", {}, { lat: "1", lon: 2 }, { lat: 91, lon: 0 }, { lat: 0, lon: 181 }, { lat: NaN, lon: 0 }, { lat: 1, lon: null }])
    ok(parseLocation(bad) === null, "ubicación inválida: " + JSON.stringify(bad));

  // 2. Compactado
  ok(describeWeatherCode(61) === "lluvia débil" && describeWeatherCode(99) === "tormenta con granizo" && describeWeatherCode(null) === "sin datos", "códigos WMO");
  const c = compactForecast(forecastBody as any, { label: "X", days: 2, hours: 3 });
  ok(c.daily.length === 2 && c.daily[1].rain_chance_pct === 80 && c.daily[1].rain_mm === 6.3, "días recortados y redondeados");
  ok(c.hourly?.length === 3 && c.hourly[0].time === "2026-10-03T19:00", "por horas arranca en la hora actual del lugar: " + c.hourly?.[0].time);
  const nul = compactForecast(forecastBody as any, { days: 1, hours: 4 }).hourly!;
  ok(nul.length === 4, "4 horas");
  ok(compactForecast(forecastBody as any, { days: 1, hours: 0 }).hourly === undefined, "sin hours no hay detalle horario");
  ok(c.now?.temp_c === 18 && c.now?.conditions === "nublado", "condiciones actuales");
  const idx21 = compactForecast(forecastBody as any, { days: 1, hours: 48 }).hourly!.find((h) => h.time === hours[21]);
  ok(idx21?.rain_chance_pct === null, "null de la API se conserva como null");

  // 3. Geocodificación
  reset(); geoResults = [
    { name: "Córdoba", latitude: 37.88, longitude: -4.77, country: "España", country_code: "ES", admin1: "Andalucía" },
    { name: "Córdoba", latitude: -31.4135, longitude: -64.18105, country: "Argentina", country_code: "AR", admin1: "Córdoba" },
  ];
  const g1 = await geocodeCity("Córdoba, Argentina");
  ok(g1?.lat === -31.41 && g1.label === "Córdoba, Argentina", "elige el resultado del país indicado: " + g1?.label);
  ok(new URL(calls[0].url).searchParams.get("name") === "Córdoba", "busca solo el nombre, sin el país");
  const g2 = await geocodeCity("Córdoba");
  ok(g2?.lat === 37.88, "sin pista toma el primero");
  geoResults = [];
  ok((await geocodeCity("Nowhereville")) === null, "ciudad inexistente = null");
  ok((await geocodeCity("x")) === null && (await geocodeCity(42)) === null, "entradas inválidas = null");

  // 4. URL del pronóstico
  reset();
  await fetchForecast({ lat: -31.420123, lon: -64.188776 }, { days: 3, hours: 30 });
  const u = new URL(meteo()[0].url);
  ok(u.searchParams.get("latitude") === "-31.42" && u.searchParams.get("longitude") === "-64.19", "la URL lleva coordenadas redondeadas");
  ok(u.searchParams.get("timezone") === "auto", "timezone=auto");
  ok(u.searchParams.get("forecast_days") === "3", "forecast_days cubre las horas pedidas: " + u.searchParams.get("forecast_days"));
  ok(!!u.searchParams.get("hourly"), "pide horario cuando hours>0");
  reset(); await fetchForecast({ lat: 1, lon: 1 }, { days: 99, hours: 0 });
  const u2 = new URL(meteo()[0].url);
  ok(u2.searchParams.get("forecast_days") === "7" && !u2.searchParams.get("hourly"), "días limitados a 7 y sin horario");

  // 5. Flujo del chat: sin ubicación -> se corta y se pide a la app
  const base = { userId: "u1", message: "¿Va a llover mañana?", timeZone: "America/Argentina/Buenos_Aires" };
  reset(); geminiScript = [fnCall("get_forecast", { days: 2 })];
  const r1 = await sendMessageToGemini(base);
  ok(r1.locationRequest === true, "pide ubicación");
  ok(gemini().length === 1 && meteo().length === 0, "una sola llamada a Gemini y ninguna al clima");

  // 6. Con ubicación -> consulta y responde
  reset(); geminiScript = [fnCall("get_forecast", { days: 2, hours: 6 }), text("Mañana hay 80% de lluvia, 20 °C.")];
  const r2 = await sendMessageToGemini({ ...base, location: { lat: -31.42, lon: -64.19 } });
  ok(!r2.locationRequest && r2.reply.content.includes("80%"), "responde con el pronóstico");
  ok(meteo().length === 1 && gemini().length === 2, "una consulta al clima y dos a Gemini");
  const toolMsg = JSON.stringify(gemini()[1].body.contents.at(-1));
  ok(toolMsg.includes("rain_chance_pct") && toolMsg.includes("Open-Meteo"), "el modelo recibe los datos compactados");

  // 7. Ubicación no disponible -> el modelo debe preguntar la ciudad
  reset(); geminiScript = [fnCall("get_forecast"), text("¿De qué ciudad quieres el pronóstico?")];
  const r3 = await sendMessageToGemini({ ...base, locationUnavailable: true });
  ok(!r3.locationRequest && meteo().length === 0, "sin permiso no hay consulta ni nuevo pedido");
  ok(JSON.stringify(gemini()[1].body.contents.at(-1)).includes("how_to_proceed"), "se le indica preguntar la ciudad");

  // 7b. El modelo recibe el MOTIVO real del fallo (permiso, ubicación apagada, tiempo agotado...)
  const reasons: [string, string][] = [
    ["denied", "no dio el permiso"], ["blocked", "desactivado para la app"], ["services_off", "ubicación del teléfono está apagada"],
    ["timeout", "no logró fijar"], ["error", "No se pudo obtener la ubicación en este teléfono"],
  ];
  for (const [reason, expected] of reasons) {
    reset(); geminiScript = [fnCall("get_forecast"), text("ok")];
    await sendMessageToGemini({ ...base, locationUnavailable: true, locationReason: reason as any });
    const sent = JSON.stringify(gemini()[1].body.contents.at(-1));
    ok(sent.includes(expected) && sent.includes("ni digas que no puedes consultar el clima"), `motivo "${reason}" llega al modelo`);
  }
  reset(); geminiScript = [fnCall("get_forecast"), text("ok")];
  await sendMessageToGemini({ ...base, locationUnavailable: true });
  ok(JSON.stringify(gemini()[1].body.contents.at(-1)).includes("sin permiso o con la ubicación apagada"), "sin motivo (apps viejas): texto genérico de siempre");
  const { parseLocationReason } = await import("../lib/weather");
  ok(parseLocationReason("blocked") === "blocked" && parseLocationReason("hack") === undefined && parseLocationReason(5) === undefined, "el motivo se valida contra una lista cerrada");

  // 7c. El prompt describe TODAS las capacidades y prohíbe negar el acceso sin intentar la herramienta
  const { systemPrompt } = await import("../lib/gemini");
  const { DEFAULT_SETTINGS } = await import("../lib/schedule");
  const prompt = systemPrompt("America/Argentina/Buenos_Aires", DEFAULT_SETTINGS, false);
  ok(/consultar el clima/.test(prompt.split("\n")[0]) && /SMS/.test(prompt.split("\n")[0]) && /marcador/.test(prompt.split("\n")[0]), "la presentación incluye clima, SMS y llamadas");
  ok(prompt.includes("Nunca digas que no puedes consultar el clima"), "el prompt prohíbe negar el clima sin llamar a la herramienta");

  // 8. Con ciudad no hace falta ubicación
  reset(); geoResults = [{ name: "Mendoza", latitude: -32.89, longitude: -68.83, country: "Argentina", admin1: "Mendoza" }];
  geminiScript = [fnCall("get_forecast", { city: "Mendoza" }), text("En Mendoza: soleado.")];
  const r4 = await sendMessageToGemini(base);
  ok(!r4.locationRequest && meteo().length === 1, "con city consulta directo");
  ok(new URL(meteo()[0].url).searchParams.get("latitude") === "-32.89", "usa las coordenadas de la ciudad");

  // 9. Ciudad inexistente -> error para el modelo, sin consulta al clima
  reset(); geoResults = [];
  geminiScript = [fnCall("get_forecast", { city: "Zzzzz" }), text("No encontré esa ciudad.")];
  await sendMessageToGemini(base);
  ok(meteo().length === 0, "no consulta el clima si no halla la ciudad");

  // 10. Pronóstico bloqueado en Restringir aplicaciones: la herramienta ni se declara
  reset(); geminiScript = [text("No tengo acceso al clima.")];
  const blocked = { autonomyLevel: "suggestion", dailyActionLimit: 100, bufferMinutes: 0, blockedHours: [],
    appAccess: { calendar: "allowed", gmail: "allowed", clock: "allowed", whatsapp: "allowed", forecast: "blocked" } } as any;
  await sendMessageToGemini({ ...base, settings: blocked });
  const declared = JSON.stringify(gemini()[0].body.tools);
  ok(!declared.includes("get_forecast") && declared.includes("list_events"), "con Pronóstico bloqueado no se declara get_forecast");

  // 11. Plan de pago: con OPEN_METEO_API_KEY se usan los servidores de cliente y la clave; sin ella, los gratuitos
  reset(); await fetchForecast({ lat: 1, lon: 1 }, { days: 1, hours: 0 });
  ok(calls[0].url.startsWith("https://api.open-meteo.com/") && !calls[0].url.includes("apikey"), "sin clave: servidor gratuito y sin apikey");
  process.env.OPEN_METEO_API_KEY = "  clave-de-prueba ";
  reset(); await fetchForecast({ lat: 1, lon: 1 }, { days: 1, hours: 0 });
  const paid = new URL(calls[0].url);
  ok(paid.host === "customer-api.open-meteo.com" && paid.searchParams.get("apikey") === "clave-de-prueba", "con clave: customer-api + apikey (sin espacios)");
  reset(); geoResults = [{ name: "Rosario", country: "Argentina", latitude: -32.95, longitude: -60.64, admin1: "Santa Fe" }];
  await geocodeCity("Rosario");
  const paidGeo = new URL(calls[0].url);
  ok(paidGeo.host === "customer-geocoding-api.open-meteo.com" && paidGeo.searchParams.get("apikey") === "clave-de-prueba", "con clave: geocodificación de cliente");
  delete process.env.OPEN_METEO_API_KEY;

  console.log(fails === 0 ? "TODO OK" : `${fails} fallas`);
})();
