// Prueba de la alternativa gratuita (OpenStreetMap) y del selector de proveedor, con fetch simulado (sin red).
// Ejecutar: npx tsx tests/osm-check.ts
import { MapsError } from "../lib/maps";
import { searchPlacesOsm, getRouteOsm, distanceKm, _setOsmNoWait, _resetOsmThrottle } from "../lib/osm";
import { findPlaces, routeBetween, providerMode, openWith, mapsAvailable } from "../lib/mapsProvider";
import { sendMessageToGemini } from "../lib/gemini";
import { DEFAULT_SETTINGS } from "../lib/schedule";

let fails = 0;
const ok = (c: boolean, m: string) => { if (!c) { fails++; console.log("FALLA:", m); } };

const calls: { url: string; headers?: any; body?: any }[] = [];
const logged: string[] = [];
console.error = (...a: any[]) => { logged.push(a.map(String).join(" ")); };
let geminiScript: any[] = [];
let nominatim: (u: URL) => { status?: number; body: any } = () => ({ body: [] });
let osrm: (u: URL) => { status?: number; body: any } = () => ({ body: { code: "Ok", routes: [{ duration: 600, distance: 5000 }] } });
let googleStatus = 200;
let googlePlaces: any = { places: [{ displayName: { text: "Farmacia Google" }, formattedAddress: "Av. Colón 100, Córdoba" }] };

const json = (b: any, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
(globalThis as any).fetch = async (url: any, init?: any) => {
  const u = String(url);
  calls.push({ url: u, headers: init?.headers, body: init?.body ? JSON.parse(init.body) : undefined });
  if (u.includes("generativelanguage")) return json(geminiScript.shift());
  if (u.startsWith("https://nominatim.openstreetmap.org/")) { const r = nominatim(new URL(u)); return json(r.body, r.status ?? 200); }
  if (u.startsWith("https://routing.openstreetmap.de/")) { const r = osrm(new URL(u)); return json(r.body, r.status ?? 200); }
  if (u.startsWith("https://places.googleapis.com/")) return googleStatus === 200 ? json(googlePlaces) : json({}, googleStatus);
  if (u.startsWith("https://routes.googleapis.com/"))
    return googleStatus === 200 ? json({ routes: [{ duration: "900s", staticDuration: "800s", distanceMeters: 7000, description: "Av. Colón" }] }) : json({}, googleStatus);
  throw new Error("URL inesperada " + u);
};
const fnCall = (name: string, args: any = {}) => ({ candidates: [{ content: { role: "model", parts: [{ functionCall: { name, args } }] } }] });
const text = (t: string) => ({ candidates: [{ content: { role: "model", parts: [{ text: t }] } }] });
const gemini = () => calls.filter((c) => c.url.includes("generativelanguage"));
const nomi = () => calls.filter((c) => c.url.startsWith("https://nominatim.openstreetmap.org/"));
const osrmCalls = () => calls.filter((c) => c.url.startsWith("https://routing.openstreetmap.de/"));
const google = () => calls.filter((c) => c.url.includes("googleapis.com"));
const reset = () => { calls.length = 0; logged.length = 0; };
const lastTool = () => JSON.stringify(gemini().at(-1)!.body.contents.at(-1));

const hit = (name: string, lat: number, lon: number, extra = "Córdoba, Argentina") => ({ name, display_name: `${name}, ${extra}`, lat: String(lat), lon: String(lon) });

process.env.GEMINI_API_KEY = "test";
_setOsmNoWait(true);
const TZ = "America/Argentina/Buenos_Aires";

(async () => {
  delete process.env.GOOGLE_MAPS_API_KEY;
  delete process.env.MAPS_PROVIDER;
  process.env.MAPS_REGION_CODE = "AR";

  // 1. Selección de proveedor
  ok(providerMode() === "auto" && mapsAvailable() && openWith() === "google", "por defecto: auto, disponible (OSM) y abre Google Maps");
  process.env.MAPS_PROVIDER = "google"; ok(!mapsAvailable(), "solo Google sin clave no está disponible");
  process.env.MAPS_PROVIDER = "osm"; ok(providerMode() === "osm" && openWith() === "any", "osm: abre el selector de mapas");
  process.env.MAPS_PROVIDER = "cualquiera"; ok(providerMode() === "auto", "valor inválido = auto");
  delete process.env.MAPS_PROVIDER;

  // 2. Distancia
  ok(Math.abs(distanceKm({ lat: -31.42, lon: -64.19 }, { lat: -31.42, lon: -64.19 })) < 0.001, "distancia 0");
  const d = distanceKm({ lat: -31.4, lon: -64.2 }, { lat: -31.5, lon: -64.2 });
  ok(d > 11 && d < 11.3, "0,1° de latitud ≈ 11,1 km: " + d);

  // 3. Búsqueda sin ubicación
  reset(); nominatim = () => ({ body: [hit("Hospital Italiano", -31.4, -64.18), hit("Otro", -31.5, -64.2)] });
  const p1 = await searchPlacesOsm("Hospital Italiano, Córdoba");
  const u1 = new URL(nomi()[0].url);
  ok(p1.length === 2 && p1[0].name === "Hospital Italiano" && p1[0].address.includes("Córdoba") && p1[0].distance_km === undefined, "devuelve nombre y dirección, sin distancia");
  ok(u1.searchParams.get("q") === "Hospital Italiano, Córdoba" && u1.searchParams.get("countrycodes") === "ar" && u1.searchParams.get("format") === "jsonv2" && !u1.searchParams.has("viewbox"), "parámetros: texto, país, formato, sin caja");
  ok(/TimeManager-Frami/.test(nomi()[0].headers["user-agent"]), "se identifica con User-Agent");
  ok(nomi().length === 1, "una sola consulta");

  // 4. Búsqueda cerca: caja acotada, ordena por cercanía, recorta a 3
  reset();
  nominatim = () => ({ body: [hit("Lejos", -31.50, -64.19), hit("Cerca", -31.421, -64.19), hit("Medio", -31.45, -64.19), hit("Muy lejos", -31.6, -64.19)] });
  const p2 = await searchPlacesOsm("farmacia", { lat: -31.42, lon: -64.19 });
  const u2 = new URL(nomi()[0].url);
  ok(u2.searchParams.get("bounded") === "1" && !!u2.searchParams.get("viewbox"), "cerca: caja acotada");
  ok(p2.length === 3 && p2[0].name === "Cerca" && p2[1].name === "Medio" && p2[0].distance_km! < p2[1].distance_km!, "ordena por cercanía y recorta a 3");
  ok(typeof p2[0].distance_km === "number", "incluye distance_km");
  const [l, t, r, b] = u2.searchParams.get("viewbox")!.split(",").map(Number);
  ok(l < -64.19 && r > -64.19 && t > -31.42 && b < -31.42, "la caja rodea al usuario");

  // 5. Cerca sin resultados: reintenta sin acotar
  reset(); let n = 0;
  nominatim = () => (++n === 1 ? { body: [] } : { body: [hit("Farmacia Lejana", -31.6, -64.2)] });
  const p3 = await searchPlacesOsm("farmacia", { lat: -31.42, lon: -64.19 });
  ok(nomi().length === 2 && new URL(nomi()[1].url).searchParams.get("bounded") === "0" && p3.length === 1, "segundo intento sin acotar");

  // 6. Errores HTTP -> tipos, y el log no revela datos
  for (const [status, kind] of [[400, "not_found"], [429, "quota"], [403, "quota"], [500, "other"]] as const) {
    reset(); nominatim = () => ({ status, body: {} });
    let e: unknown;
    try { await searchPlacesOsm("Calle Secreta 123"); } catch (x) { e = x; }
    ok(e instanceof MapsError && e.kind === kind, `HTTP ${status} -> ${kind}`);
    ok(logged.length === 1 && !logged.join(" ").includes("Secreta") && !logged.join(" ").includes("nominatim"), `el log de HTTP ${status} no lleva texto ni URL`);
  }

  // 7. Ruta en auto: geocodifica destino, usa origen por coordenadas, perfil de auto
  reset(); nominatim = () => ({ body: [hit("Destino", -31.43, -64.20)] });
  osrm = () => ({ body: { code: "Ok", routes: [{ duration: 905, distance: 7200 }] } });
  const NOW = Date.UTC(2026, 9, 6, 15, 0, 0);
  const r1 = await getRouteOsm({ origin: { coords: { lat: -31.42, lon: -64.19 } }, destination: "Av. Colón 100", mode: "drive", nowMs: NOW });
  ok(nomi().length === 1 && osrmCalls().length === 1, "1 geocodificación (destino) + 1 ruta");
  ok(osrmCalls()[0].url.includes("/routed-car/") && osrmCalls()[0].url.includes("-64.19,-31.42;-64.2,-31.43"), "perfil auto y orden lon,lat origen;destino");
  ok(r1.durationSec === 905 && r1.distanceM === 7200 && r1.typicalSec === undefined && r1.leaveByMs === undefined, "tiempo y distancia, sin tráfico ni hora de salida");

  // 8. Origen y destino por texto: 2 geocodificaciones; perfiles a pie y bici
  reset();
  await getRouteOsm({ origin: { address: "Plaza San Martín" }, destination: "Centro", mode: "walk", nowMs: NOW });
  ok(nomi().length === 2 && osrmCalls()[0].url.includes("/routed-foot/"), "origen y destino por texto: 2 geocodificaciones, perfil a pie");
  reset();
  await getRouteOsm({ origin: { address: "A1" }, destination: "Centro", mode: "bicycle", nowMs: NOW });
  ok(osrmCalls()[0].url.includes("/routed-bike/"), "perfil bicicleta");

  // 9. arrive_by: hora de salida = llegada - duración
  const ARRIVE = NOW + 2 * 3600_000;
  reset();
  const r9 = await getRouteOsm({ origin: { address: "A1" }, destination: "Centro", mode: "drive", arriveByMs: ARRIVE, nowMs: NOW });
  ok(r9.arriveByMs === ARRIVE && r9.leaveByMs === ARRIVE - 905_000, "calcula la salida");

  // 10. Transporte público: no soportado, sin consultar
  reset();
  let e10: unknown;
  try { await getRouteOsm({ origin: { address: "A1" }, destination: "Centro", mode: "transit", nowMs: NOW }); } catch (x) { e10 = x; }
  ok(e10 instanceof MapsError && e10.kind === "unsupported" && calls.length === 0, "transporte público: unsupported sin llamar a nadie");

  // 11. Dirección que no existe / ruta imposible
  reset(); nominatim = () => ({ body: [] });
  let e11: unknown;
  try { await getRouteOsm({ origin: { address: "A1" }, destination: "Zzzz", mode: "drive", nowMs: NOW }); } catch (x) { e11 = x; }
  ok(e11 instanceof MapsError && e11.kind === "not_found" && osrmCalls().length === 0, "dirección inexistente = not_found sin pedir ruta");
  nominatim = () => ({ body: [hit("D", -31.43, -64.20)] });
  osrm = () => ({ body: { code: "NoRoute", routes: [] } });
  let e11b: unknown;
  try { await getRouteOsm({ origin: { coords: { lat: -31.4, lon: -64.2 } }, destination: "Isla", mode: "drive", nowMs: NOW }); } catch (x) { e11b = x; }
  ok(e11b instanceof MapsError && e11b.kind === "not_found", "sin ruta posible = not_found");
  osrm = () => ({ body: { code: "Ok", routes: [{ duration: 600, distance: 5000 }] } });

  // 12. Ritmo de Nominatim: con la espera activa, dos consultas seguidas se separan >= 1 s
  _setOsmNoWait(false); _resetOsmThrottle();
  reset(); nominatim = () => ({ body: [hit("D", -31.43, -64.20)] });
  const stamps: number[] = [];
  const baseFetch = (globalThis as any).fetch;
  (globalThis as any).fetch = async (u: any, i?: any) => { if (String(u).includes("nominatim")) stamps.push(Date.now()); return baseFetch(u, i); };
  await searchPlacesOsm("uno"); await searchPlacesOsm("dos"); await searchPlacesOsm("tres");
  ok(stamps.length === 3 && stamps[1] - stamps[0] >= 1000 && stamps[2] - stamps[1] >= 1000, `espacia las consultas a >= 1 s (${stamps[1] - stamps[0]} ms, ${stamps[2] - stamps[1]} ms)`);
  (globalThis as any).fetch = baseFetch;
  _setOsmNoWait(true);

  // 13. Selector: auto sin clave -> solo OSM
  reset(); nominatim = () => ({ body: [hit("Farmacia OSM", -31.42, -64.19)] });
  const f1 = await findPlaces("farmacia");
  ok(f1.provider === "osm" && google().length === 0, "auto sin clave usa OSM y no toca Google");

  // 14. Selector: auto con clave -> Google primero
  process.env.GOOGLE_MAPS_API_KEY = "KEY-123";
  reset(); googleStatus = 200;
  const f2 = await findPlaces("farmacia");
  ok(f2.provider === "google" && f2.places[0].name === "Farmacia Google" && nomi().length === 0, "auto con clave usa Google y no toca OSM");

  // 15. Google falla (cuota / clave / error) -> cae a OSM
  for (const status of [429, 403, 500]) {
    reset(); googleStatus = status;
    const f = await findPlaces("farmacia");
    ok(f.provider === "osm" && f.places[0].name === "Farmacia OSM", `Google HTTP ${status}: respalda con OSM`);
  }
  reset(); googleStatus = 429;
  const rt = await routeBetween({ origin: { address: "A1" }, destination: "Centro", mode: "walk", nowMs: NOW });
  ok(rt.provider === "osm" && rt.route.durationSec === 600, "ruta: cuota de Google -> OSM");

  // 16. Google no encuentra nada -> prueba OSM; si ninguno, vacío
  reset(); googleStatus = 200; googlePlaces = { places: [] };
  const f3 = await findPlaces("algo raro");
  ok(f3.provider === "osm" && f3.places.length === 1, "Google vacío -> OSM");
  nominatim = () => ({ body: [] });
  const f4 = await findPlaces("nada");
  ok(f4.places.length === 0, "ninguno encuentra = lista vacía");
  googlePlaces = { places: [{ displayName: { text: "Farmacia Google" }, formattedAddress: "Av. Colón 100, Córdoba" }] };

  // 17. Google "no encontrado" (400) NO se reintenta: el usuario debe precisar
  reset(); googleStatus = 400;
  let e17: unknown;
  try { await routeBetween({ origin: { address: "A1" }, destination: "Zzzz", mode: "drive", nowMs: NOW }); } catch (x) { e17 = x; }
  ok(e17 instanceof MapsError && e17.kind === "not_found" && nomi().length === 0, "not_found de Google no cae a OSM");

  // 18. Transporte público con Google caído: se conserva el error de Google, no el 'unsupported'
  reset(); googleStatus = 429;
  let e18: unknown;
  try { await routeBetween({ origin: { address: "A1" }, destination: "Centro", mode: "transit", nowMs: NOW }); } catch (x) { e18 = x; }
  ok(e18 instanceof MapsError && e18.kind === "quota", "tránsito con Google sin cuota: error de Google");
  googleStatus = 200;

  // 19. Flujo del chat sin clave de Google: search_place y get_directions funcionan con OSM
  delete process.env.GOOGLE_MAPS_API_KEY;
  const base = { userId: "u1", message: "¿Dónde hay una farmacia?", timeZone: TZ };
  reset(); nominatim = () => ({ body: [hit("Farmacia del Pueblo", -31.421, -64.19)] });
  geminiScript = [fnCall("search_place", { query: "farmacia", near_me: true }), text("Hay una cerca.")];
  const c19 = await sendMessageToGemini({ ...base, location: { lat: -31.42, lon: -64.19 } });
  ok(!c19.locationRequest && lastTool().includes("Farmacia del Pueblo") && lastTool().includes("OpenStreetMap") && lastTool().includes("distance_km"), "search_place con OSM: datos, fuente y distancia llegan al modelo");
  reset(); geminiScript = [fnCall("search_place", { query: "farmacia", near_me: true })];
  ok((await sendMessageToGemini(base)).locationRequest === true && nomi().length === 0, "near_me sin ubicación la pide antes de consultar");

  reset(); nominatim = () => ({ body: [hit("Oficina", -31.43, -64.20)] });
  geminiScript = [fnCall("get_directions", { destination: "Av. Colón 100, Córdoba", mode: "walk" }), text("Unos 10 minutos.")];
  const c19b = await sendMessageToGemini({ ...base, location: { lat: -31.42, lon: -64.19 } });
  ok(!c19b.locationRequest && lastTool().includes("duration_min") && lastTool().includes("OpenStreetMap") && lastTool().includes("SIN tráfico") && !lastTool().includes("traffic_delay_min"), "get_directions con OSM: sin tráfico y lo aclara");

  reset(); geminiScript = [fnCall("get_directions", { destination: "Centro", origin: "Plaza", mode: "transit" }), text("No puedo.")];
  await sendMessageToGemini(base);
  ok(osrmCalls().length === 0 && lastTool().includes("transporte público") && lastTool().includes("open_maps_route"), "transporte público: lo explica y ofrece abrir la app de mapas");

  // 20. open_maps_route: "open_with" según el proveedor, siempre con confirmación
  for (const [mode, expected] of [[undefined, "google"], ["osm", "any"]] as const) {
    if (mode) process.env.MAPS_PROVIDER = mode; else delete process.env.MAPS_PROVIDER;
    reset(); geminiScript = [fnCall("open_maps_route", { destination: "Av. Colón 100, Córdoba" }), text("Listo.")];
    const c = await sendMessageToGemini({ ...base, settings: { ...DEFAULT_SETTINGS, autonomyLevel: "autopilot" } });
    const da = c.deviceAction as any;
    ok(da?.kind === "maps_open" && da.open_with === expected && da.requiresConfirmation === true, `open_with=${expected} con confirmación`);
    if (mode === "osm") ok(da.description.includes("app de mapas") && !da.description.includes("Google Maps"), "descripción neutral para 'any'");
  }
  delete process.env.MAPS_PROVIDER;

  // 21. Maps bloqueado: sigue cortando las 3 herramientas aunque haya proveedor gratuito
  reset(); geminiScript = [text("No puedo.")];
  await sendMessageToGemini({ ...base, settings: { ...DEFAULT_SETTINGS, appAccess: { ...DEFAULT_SETTINGS.appAccess, maps: "blocked" } } });
  const declared = JSON.stringify(gemini()[0].body.tools);
  ok(!declared.includes("search_place") && !declared.includes("get_directions") && !declared.includes("open_maps_route"), "bloqueado: no se declaran herramientas de mapas");

  if (fails) { console.log(`\n${fails} FALLA(S)`); process.exit(1); }
  console.log("TODO OK");
})();
