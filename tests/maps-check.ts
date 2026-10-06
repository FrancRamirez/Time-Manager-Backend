// Prueba de Google Maps (search_place, get_directions, open_maps_route) con fetch simulado (sin red).
// Ejecutar: npx tsx tests/maps-check.ts
import { cleanPlaceText, parseTravelMode, searchPlaces, getRoute, compactRoute, MapsError, mapsConfigured } from "../lib/maps";
import { sendMessageToGemini } from "../lib/gemini";
import { DEFAULT_SETTINGS, utcMsToLocal } from "../lib/schedule";

let fails = 0;
const ok = (c: boolean, m: string) => { if (!c) { fails++; console.log("FALLA:", m); } };

// ---- fetch y consola simulados ------------------------------------------------------------
const calls: { url: string; headers?: any; body?: any }[] = [];
let geminiScript: any[] = [];
let routeScript: (number | { status: number })[] = []; // segundos de duración o un error HTTP
let staticSec = 1200;
let placesBody: any = { places: [{ displayName: { text: "Farmacia Central" }, formattedAddress: "Av. Colón 100, Córdoba" }] };
const logged: string[] = [];
console.error = (...a: any[]) => { logged.push(a.map(String).join(" ")); };

const json = (b: any, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
(globalThis as any).fetch = async (url: any, init?: any) => {
  const u = String(url);
  calls.push({ url: u, headers: init?.headers, body: init?.body ? JSON.parse(init.body) : undefined });
  if (u.includes("generativelanguage")) return json(geminiScript.shift());
  if (u.startsWith("https://places.googleapis.com/")) return json(placesBody);
  if (u.startsWith("https://routes.googleapis.com/")) {
    const next = routeScript.shift() ?? 600;
    if (typeof next === "object") return json({ error: "x" }, next.status);
    return json({ routes: [{ duration: `${next}s`, staticDuration: `${staticSec}s`, distanceMeters: 12345, description: "Av. Colón" }] });
  }
  throw new Error("URL inesperada " + u);
};
const fnCall = (name: string, args: any = {}) => ({ candidates: [{ content: { role: "model", parts: [{ functionCall: { name, args } }] } }] });
const text = (t: string) => ({ candidates: [{ content: { role: "model", parts: [{ text: t }] } }] });
const gemini = () => calls.filter((c) => c.url.includes("generativelanguage"));
const routes = () => calls.filter((c) => c.url.startsWith("https://routes.googleapis.com/"));
const places = () => calls.filter((c) => c.url.startsWith("https://places.googleapis.com/"));
const reset = () => { calls.length = 0; logged.length = 0; };
const lastTool = () => JSON.stringify(gemini().at(-1)!.body.contents.at(-1));

process.env.GEMINI_API_KEY = "test";
const TZ = "America/Argentina/Buenos_Aires";

(async () => {
  // 1. Validaciones puras
  ok(cleanPlaceText("  Av.  Colón\n 100 ") === "Av. Colón 100", "limpia espacios y saltos de línea");
  ok(cleanPlaceText("a") === null && cleanPlaceText("") === null && cleanPlaceText(5) === null && cleanPlaceText("x".repeat(201)) === null, "rechaza vacío, 1 letra, no texto y demasiado largo");
  ok(cleanPlaceText("hola\u0000mundo") === "hola mundo", "quita caracteres de control");
  ok(parseTravelMode("walk") === "walk" && parseTravelMode("hack") === "drive" && parseTravelMode(undefined) === "drive", "modo inválido = auto");

  // 2. Sin clave: no se llama a Google
  delete process.env.GOOGLE_MAPS_API_KEY;
  ok(!mapsConfigured(), "sin clave no está configurado");
  reset();
  let err: unknown;
  try { await searchPlaces("farmacia"); } catch (e) { err = e; }
  ok(err instanceof MapsError && err.kind === "not_configured" && calls.length === 0, "sin clave falla sin llamar a Google");

  process.env.GOOGLE_MAPS_API_KEY = "KEY-123";
  process.env.MAPS_REGION_CODE = "AR";

  // 3. Búsqueda de lugares
  reset();
  const found = await searchPlaces("farmacia", { lat: -31.42, lon: -64.19 });
  ok(found.length === 1 && found[0].name === "Farmacia Central" && found[0].address.includes("Colón"), "devuelve nombre y dirección");
  const pc = places()[0];
  ok(pc.headers["X-Goog-Api-Key"] === "KEY-123" && pc.headers["X-Goog-FieldMask"] === "places.displayName,places.formattedAddress", "clave y máscara mínima");
  ok(pc.body.locationBias.circle.center.latitude === -31.42 && pc.body.pageSize === 3 && pc.body.regionCode === "AR" && pc.body.languageCode === "es", "sesgo de ubicación, 3 resultados, región e idioma");
  reset();
  await searchPlaces("Hospital");
  ok(places()[0].body.locationBias === undefined, "sin ubicación no hay sesgo");

  // 4. Ruta en auto: tráfico, origen por coordenadas, ahora
  const NOW = Date.UTC(2026, 9, 6, 15, 0, 0); // 12:00 en Buenos Aires
  const local = (ms: number) => utcMsToLocal(ms, TZ);
  reset(); routeScript = [1500]; staticSec = 1200;
  const r1 = await getRoute({ origin: { coords: { lat: -31.42, lon: -64.19 } }, destination: "Av. Colón 100, Córdoba", mode: "drive", nowMs: NOW });
  const b1 = routes()[0].body;
  ok(routes()[0].headers["X-Goog-FieldMask"] === "routes.duration,routes.staticDuration,routes.distanceMeters,routes.description", "máscara de la ruta");
  ok(b1.travelMode === "DRIVE" && b1.routingPreference === "TRAFFIC_AWARE" && b1.departureTime === undefined, "auto: con tráfico y sin hora = ahora");
  ok(b1.origin.location.latLng.latitude === -31.42 && b1.destination.address === "Av. Colón 100, Córdoba" && b1.units === "METRIC", "origen por coordenadas, destino por texto");
  const c1 = compactRoute(r1, { mode: "drive", from: "x", to: "y", nowMs: NOW, local }) as any;
  ok(c1.duration_min === 25 && c1.typical_duration_min === 20 && c1.traffic_delay_min === 5 && c1.distance_km === 12.3 && c1.departure === "ahora" && c1.via === "Av. Colón", "tiempo, demora por tráfico y distancia");
  ok(c1.leave_by === undefined, "sin arrive_by no hay hora de salida");

  // 5. Con salida futura
  reset(); routeScript = [1500];
  await getRoute({ origin: { address: "A" + "b" }, destination: "Centro", mode: "drive", departAtMs: NOW + 3600_000, nowMs: NOW });
  ok(routes()[0].body.departureTime === new Date(NOW + 3600_000).toISOString() && routes()[0].body.origin.address === "Ab", "salida futura y origen por texto");
  reset(); routeScript = [1500];
  await getRoute({ origin: { address: "Ab" }, destination: "Centro", mode: "drive", departAtMs: NOW - 5000, nowMs: NOW });
  ok(routes()[0].body.departureTime === undefined, "una salida ya pasada se manda como ahora");

  // 6. A qué hora salir (auto): 2 consultas para afinar el tráfico
  const ARRIVE = NOW + 2 * 3600_000;
  reset(); routeScript = [3600, 3000];
  const r6 = await getRoute({ origin: { address: "Ab" }, destination: "Centro", mode: "drive", arriveByMs: ARRIVE, nowMs: NOW });
  ok(routes().length === 2, "dos consultas cuando la primera estimación se aleja");
  ok(routes()[0].body.departureTime === new Date(ARRIVE - 30 * 60_000).toISOString(), "primera estimación: 30 min antes de la llegada");
  ok(routes()[1].body.departureTime === new Date(ARRIVE - 3600_000).toISOString(), "segunda consulta: a la hora de salida estimada");
  ok(r6.leaveByMs === ARRIVE - 3000_000, "sale 50 min antes (duración de la segunda consulta)");
  const c6 = compactRoute(r6, { mode: "drive", from: "x", to: "y", nowMs: NOW, local }) as any;
  ok(c6.leave_by === "2026-10-06T13:10" && c6.arrive_by === "2026-10-06T14:00" && c6.already_late === undefined, "hora de salida y llegada en la zona del usuario: " + c6.leave_by);

  reset(); routeScript = [1800];
  const r6b = await getRoute({ origin: { address: "Ab" }, destination: "Centro", mode: "drive", arriveByMs: ARRIVE, nowMs: NOW });
  ok(routes().length === 1 && r6b.leaveByMs === ARRIVE - 1800_000, "una sola consulta si la estimación ya coincide");

  // 7. Ya es tarde
  reset(); routeScript = [1800, 1800];
  const r7 = await getRoute({ origin: { address: "Ab" }, destination: "Centro", mode: "drive", arriveByMs: NOW + 10 * 60_000, nowMs: NOW });
  const c7 = compactRoute(r7, { mode: "drive", from: "x", to: "y", nowMs: NOW, local }) as any;
  ok(c7.already_late === true && c7.late_by_min === 20, "avisa que ya es tarde y por cuánto: " + c7.late_by_min);
  ok(routes().every((c) => c.body.departureTime === undefined || new Date(c.body.departureTime).getTime() > NOW), "nunca manda una salida en el pasado");

  // 8. Transporte público y a pie
  reset(); routeScript = [2400];
  const r8 = await getRoute({ origin: { address: "Ab" }, destination: "Centro", mode: "transit", arriveByMs: ARRIVE, nowMs: NOW });
  ok(routes().length === 1 && routes()[0].body.arrivalTime === new Date(ARRIVE).toISOString() && routes()[0].body.routingPreference === undefined && r8.leaveByMs === ARRIVE - 2400_000, "transporte público: usa arrivalTime y no pide tráfico");
  reset(); routeScript = [900];
  const r8b = await getRoute({ origin: { address: "Ab" }, destination: "Centro", mode: "walk", arriveByMs: ARRIVE, nowMs: NOW });
  ok(routes().length === 1 && routes()[0].body.travelMode === "WALK" && routes()[0].body.routingPreference === undefined && routes()[0].body.departureTime === undefined && r8b.typicalSec === undefined, "a pie: una consulta, sin tráfico");

  // 9. Errores de Google: tipos y privacidad del log
  for (const [status, kind] of [[400, "not_found"], [404, "not_found"], [429, "quota"], [403, "config"], [401, "config"], [500, "other"]] as const) {
    reset(); routeScript = [{ status }];
    let e: unknown;
    try { await getRoute({ origin: { address: "Calle Secreta 123" }, destination: "Destino Privado 456", mode: "drive", nowMs: NOW }); } catch (x) { e = x; }
    ok(e instanceof MapsError && e.kind === kind, `HTTP ${status} -> ${kind}`);
    ok(logged.length === 1 && !logged.join(" ").includes("Secreta") && !logged.join(" ").includes("Privado") && !logged.join(" ").includes("KEY-123"), `el log de HTTP ${status} no lleva direcciones ni clave`);
  }
  reset(); (globalThis as any).fetch = async () => ({ ok: true, json: async () => ({ routes: [] }) });
  let e0: unknown;
  try { await getRoute({ origin: { address: "Ab" }, destination: "Centro", mode: "transit", nowMs: NOW }); } catch (x) { e0 = x; }
  ok(e0 instanceof MapsError && e0.kind === "not_found", "sin rutas = no encontrada");
  // restaurar el fetch simulado
  (globalThis as any).fetch = async (url: any, init?: any) => {
    const u = String(url);
    calls.push({ url: u, headers: init?.headers, body: init?.body ? JSON.parse(init.body) : undefined });
    if (u.includes("generativelanguage")) return json(geminiScript.shift());
    if (u.startsWith("https://places.googleapis.com/")) return json(placesBody);
    if (u.startsWith("https://routes.googleapis.com/")) {
      const next = routeScript.shift() ?? 600;
      if (typeof next === "object") return json({ error: "x" }, next.status);
      return json({ routes: [{ duration: `${next}s`, staticDuration: `${staticSec}s`, distanceMeters: 12345, description: "Av. Colón" }] });
    }
    throw new Error("URL inesperada " + u);
  };

  // 10. Flujo del chat: get_directions sin origen y sin ubicación -> se pide a la app
  const base = { userId: "u1", message: "¿Cuánto tardo en llegar a la oficina?", timeZone: TZ };
  reset(); geminiScript = [fnCall("get_directions", { destination: "Av. Colón 100, Córdoba" })];
  const c10 = await sendMessageToGemini(base);
  ok(c10.locationRequest === true && routes().length === 0 && gemini().length === 1, "pide la ubicación sin consultar a Google");

  // 11. Con ubicación: una consulta y el modelo recibe los datos
  reset(); routeScript = [1500]; geminiScript = [fnCall("get_directions", { destination: "Av. Colón 100, Córdoba" }), text("Unos 25 minutos.")];
  const c11 = await sendMessageToGemini({ ...base, location: { lat: -31.42, lon: -64.19 } });
  ok(!c11.locationRequest && c11.reply.content.includes("25") && routes().length === 1, "responde con el tiempo");
  ok(lastTool().includes("duration_min") && lastTool().includes("traffic_delay_min") && lastTool().includes("ubicación aproximada"), "el modelo recibe los datos compactados");

  // 12. Con origen escrito no hace falta ubicación
  reset(); routeScript = [900]; geminiScript = [fnCall("get_directions", { origin: "Plaza San Martín, Córdoba", destination: "Av. Colón 100, Córdoba", mode: "walk" }), text("15 minutos a pie.")];
  const c12 = await sendMessageToGemini(base);
  ok(!c12.locationRequest && routes().length === 1 && routes()[0].body.origin.address === "Plaza San Martín, Córdoba" && routes()[0].body.travelMode === "WALK", "con origin consulta directo");

  // 13. Ubicación no disponible: el modelo debe pedir el origen
  reset(); geminiScript = [fnCall("get_directions", { destination: "Centro" }), text("¿Desde dónde sales?")];
  const c13 = await sendMessageToGemini({ ...base, locationUnavailable: true, locationReason: "denied" });
  ok(!c13.locationRequest && routes().length === 0 && lastTool().includes("how_to_proceed") && lastTool().includes("no dio el permiso"), "explica el motivo y pide el origen");

  // 14. arrive_by: formato inválido, hora pasada y flujo correcto (zona del usuario)
  reset(); geminiScript = [fnCall("get_directions", { destination: "Centro", origin: "Ab", arrive_by: "mañana 9" }), text("ok")];
  await sendMessageToGemini(base);
  ok(routes().length === 0 && lastTool().includes("formato"), "arrive_by inválido no consulta");
  reset(); geminiScript = [fnCall("get_directions", { destination: "Centro", origin: "Ab", arrive_by: "2020-01-01T10:00:00" }), text("ok")];
  await sendMessageToGemini(base);
  ok(routes().length === 0 && lastTool().includes("ya pasó"), "arrive_by en el pasado no consulta");
  const arriveLocal = utcMsToLocal(Date.now() + 3 * 3600_000, TZ);
  reset(); routeScript = [1800]; geminiScript = [fnCall("get_directions", { destination: "Centro", origin: "Ab", arrive_by: arriveLocal }), text("Sal a las 15.")];
  await sendMessageToGemini(base);
  ok(lastTool().includes("leave_by") && lastTool().includes("arrive_by"), "devuelve hora de salida");

  // 15. Errores de Google llegan al modelo como instrucciones, sin romper el chat
  reset(); routeScript = [{ status: 400 }]; geminiScript = [fnCall("get_directions", { destination: "Zzzz", origin: "Ab" }), text("No la encontré.")];
  const c15 = await sendMessageToGemini(base);
  ok(c15.reply.content.includes("No la encontré") && lastTool().includes("con más detalle"), "dirección no encontrada -> pide más detalle");
  // Modo "solo Google" y sin clave: no hay consultas y se sugiere abrir la ruta en la app (comportamiento original)
  delete process.env.GOOGLE_MAPS_API_KEY;
  process.env.MAPS_PROVIDER = "google";
  reset(); geminiScript = [fnCall("get_directions", { destination: "Centro", origin: "Ab" }), text("Puedo abrir Maps.")];
  await sendMessageToGemini(base);
  ok(routes().length === 0 && lastTool().includes("open_maps_route"), "sin clave (solo Google) sugiere abrir la ruta en la app de mapas");
  delete process.env.MAPS_PROVIDER;
  process.env.GOOGLE_MAPS_API_KEY = "KEY-123";

  // 16. search_place: con near_me pide ubicación; sin near_me no
  reset(); geminiScript = [fnCall("search_place", { query: "farmacia", near_me: true })];
  ok((await sendMessageToGemini(base)).locationRequest === true && places().length === 0, "near_me sin ubicación la pide");
  reset(); geminiScript = [fnCall("search_place", { query: "farmacia", near_me: true }), text("Hay una en Colón.")];
  await sendMessageToGemini({ ...base, location: { lat: -31.42, lon: -64.19 } });
  ok(places().length === 1 && places()[0].body.locationBias && lastTool().includes("Farmacia Central"), "near_me con ubicación busca cerca");
  reset(); geminiScript = [fnCall("search_place", { query: "Hospital Italiano, Córdoba" }), text("ok")];
  await sendMessageToGemini(base);
  ok(places().length === 1 && !places()[0].body.locationBias, "sin near_me no usa la ubicación");
  reset(); placesBody = { places: [] }; geminiScript = [fnCall("search_place", { query: "zzzz" }), text("Nada.")];
  await sendMessageToGemini(base);
  ok(lastTool().includes("No encontré resultados"), "sin resultados lo informa");
  placesBody = { places: [{ displayName: { text: "Farmacia Central" }, formattedAddress: "Av. Colón 100, Córdoba" }] };

  // 17. open_maps_route: acción del dispositivo, SIEMPRE con confirmación (también en Piloto Automático)
  for (const level of ["suggestion", "autopilot"] as const) {
    reset(); geminiScript = [fnCall("open_maps_route", { destination: "Av. Colón 100, Córdoba", mode: "transit" }), text("Listo.")];
    const c17 = await sendMessageToGemini({ ...base, settings: { ...DEFAULT_SETTINGS, autonomyLevel: level } });
    const d = c17.deviceAction as any;
    ok(d?.kind === "maps_open" && d.destination === "Av. Colón 100, Córdoba" && d.mode === "transit" && d.requiresConfirmation === true, `abre Maps con confirmación (${level})`);
    ok(routes().length === 0 && places().length === 0, "abrir la ruta no usa la API de Google");
    ok(typeof d.description === "string" && d.description.includes("transporte público") && d.description.includes("tu ubicación"), "descripción armada por el servidor");
  }
  reset(); geminiScript = [fnCall("open_maps_route", { destination: "x" }), text("Falta.")];
  ok((await sendMessageToGemini(base)).deviceAction === undefined, "destino inválido no abre nada");
  reset(); geminiScript = [fnCall("open_maps_route", { destination: "Centro", mode: "hack" }), text("ok")];
  ok(((await sendMessageToGemini(base)).deviceAction as any)?.mode === "drive", "modo inválido = auto");
  // Es una acción de escritura: no se combina con otra en el mismo mensaje
  reset(); geminiScript = [fnCall("open_maps_route", { destination: "Centro" }), fnCall("compose_call", { phone: "1123456789" }), text("ok")];
  const c17b = await sendMessageToGemini(base);
  ok((c17b.deviceAction as any)?.kind === "maps_open", "solo una acción por mensaje (queda la primera)");

  // 18. Maps bloqueado: las 3 herramientas ni se declaran y el prompt lo explica
  reset(); geminiScript = [text("No puedo usar Maps.")];
  await sendMessageToGemini({ ...base, settings: { ...DEFAULT_SETTINGS, appAccess: { ...DEFAULT_SETTINGS.appAccess, maps: "blocked" } } });
  const declared = JSON.stringify(gemini()[0].body.tools);
  ok(!declared.includes("search_place") && !declared.includes("get_directions") && !declared.includes("open_maps_route") && declared.includes("list_events") && declared.includes("get_forecast"), "con Maps bloqueado no se declaran sus herramientas");
  ok(JSON.stringify(gemini()[0].body.systemInstruction).includes("Mapas: BLOQUEADA"), "el prompt informa la restricción");

  // 19. El prompt describe la capacidad y sus límites
  const { systemPrompt } = await import("../lib/gemini");
  const prompt = systemPrompt(TZ, DEFAULT_SETTINGS, false);
  ok(prompt.includes("get_directions") && prompt.includes("arrive_by") && prompt.includes("open_maps_route") && prompt.includes("estimaciones"), "el prompt explica cómo usar los mapas");

  if (fails) { console.log(`\n${fails} FALLA(S)`); process.exit(1); }
  console.log("TODO OK");
})();
