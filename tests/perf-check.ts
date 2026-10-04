// Prueba de la IDEA 4C: medición, caché del token de Google y campos mínimos de Calendar.
// Ejecutar: npx tsx tests/perf-check.ts
import Module from "module";

let fails = 0;
const ok = (c: boolean, m: string) => { if (!c) { fails++; console.log("FALLA:", m); } };

// ---- base de datos y cifrado simulados (solo importaciones relativas) --------------------------
let dbCalls = 0;
let userExists = true;
const fakeDb = {
  query: async () => { dbCalls++; return userExists ? [{ google_refresh_token_enc: "rt" }] : []; },
  exec: async () => ({ affectedRows: 1 }),
};
const orig = (Module as any)._load;
(Module as any)._load = function (req: string, ...rest: any[]) {
  if (/^\.\.?\/(.*\/)?db$/.test(req)) return fakeDb;
  if (/^\.\.?\/(.*\/)?crypto$/.test(req)) return { decrypt: (s: string) => s };
  return orig.call(this, req, ...rest);
};

// ---- red simulada ---------------------------------------------------------------------------
let oauthCalls = 0, tokenSeq = 0, expiresIn = 3600, oauthMode: "ok" | "invalid_grant" | "down" = "ok";
const urls: string[] = [];
let calendarStatus = 200;
const json = (b: any, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
(globalThis as any).fetch = async (url: any) => {
  const u = String(url instanceof URL ? url.href : url);
  urls.push(u);
  if (u === "https://oauth2.googleapis.com/token") {
    oauthCalls++;
    await new Promise((r) => setTimeout(r, 5));
    if (oauthMode === "invalid_grant") return json({ error: "invalid_grant" }, 400);
    if (oauthMode === "down") return json({ error: "temporarily_unavailable" }, 503);
    return json({ access_token: `A${++tokenSeq}`, expires_in: expiresIn, token_type: "Bearer" });
  }
  if (u.startsWith("https://www.googleapis.com/calendar/")) return json({ items: [] }, calendarStatus);
  return json({});
};
process.env.GOOGLE_WEB_CLIENT_ID = "id"; process.env.GOOGLE_WEB_CLIENT_SECRET = "secret"; process.env.JWT_SECRET = "s".repeat(40);

const realNow = Date.now;

(async () => {
  const T = await import("../lib/timing");
  const { route, HttpError } = await import("../lib/http");
  const tokens = await import("../lib/tokens");
  const { listUpcomingEvents, LIST_FIELDS } = await import("../lib/google");
  const { listEventsBetween, WINDOW_FIELDS } = await import("../lib/schedule");
  const { toPlannerEvent } = await import("../lib/conflicts");

  // 0. Registro real de tokens.ts: un 401 de Calendar a un token guardado lo hace renovar (se prueba ANTES
  //    de que la sección 3 sustituya el manejador).
  tokens.clearGoogleTokenCache(); oauthCalls = 0; tokenSeq = 0; dbCalls = 0;
  const tk = await tokens.getGoogleAccessTokenForUser("u1");
  calendarStatus = 401; await T.tfetch("https://www.googleapis.com/calendar/v3/x", { headers: { Authorization: `Bearer ${tk}` } }); calendarStatus = 200;
  ok(await tokens.getGoogleAccessTokenForUser("u1") === "A2" && oauthCalls === 2, "tras un 401 de Calendar el token guardado se renueva");
  tokens.clearGoogleTokenCache(); oauthCalls = 0; tokenSeq = 0;

  // 1. Clasificación de URLs
  const cls: [string, string][] = [
    ["https://oauth2.googleapis.com/token", "google_token"], ["https://www.googleapis.com/oauth2/v3/tokeninfo?id_token=x", "google_token"],
    ["https://www.googleapis.com/calendar/v3/calendars/primary/events", "calendar"], ["https://gmail.googleapis.com/gmail/v1/users/me/messages", "gmail"],
    ["https://generativelanguage.googleapis.com/v1beta/models/x:generateContent", "gemini"], ["https://fcm.googleapis.com/v1/projects/p/messages:send", "fcm"],
    ["https://api.open-meteo.com/v1/forecast", "weather"], ["https://customer-api.open-meteo.com/v1/forecast", "weather"], ["https://otro.com/x", "http"], ["no es url", "http"],
  ];
  for (const [u, want] of cls) ok(T.classifyUrl(u) === want, `classifyUrl ${u} -> ${T.classifyUrl(u)} (esperado ${want})`);

  // 2. Acumulación y aislamiento entre requests simultáneos
  const a: any = new Map(), b: any = new Map();
  await Promise.all([
    T.runWithTiming(a, async () => { await T.timed("db", async () => { await new Promise((r) => setTimeout(r, 20)); }); await T.timed("db", async () => {}); }),
    T.runWithTiming(b, async () => { await T.timed("gemini", async () => { await new Promise((r) => setTimeout(r, 10)); }); }),
  ]);
  ok(a.get("db").n === 2 && a.get("db").ms >= 15 && !a.has("gemini"), "request A: 2 pasos de base de datos y nada de Gemini");
  ok(b.get("gemini").n === 1 && !b.has("db"), "request B aislado de A");
  let threw = false; const c: any = new Map();
  try { await T.runWithTiming(c, () => T.timed("db", async () => { throw new Error("x"); })); } catch { threw = true; }
  ok(threw && c.get("db").n === 1, "un paso que falla igual queda medido y el error se propaga");
  T.record("db", 5); // fuera de un contexto: no debe lanzar

  // 3. tfetch: mide y olvida el token ante un 401 de Calendar/Gmail
  const seen: string[] = []; T.setUnauthorizedHandler((t) => seen.push(t));
  const m1: any = new Map(); calendarStatus = 401;
  await T.runWithTiming(m1, async () => {
    await T.tfetch("https://www.googleapis.com/calendar/v3/x", { headers: { Authorization: "Bearer TOK1" } });
    await T.tfetch("https://www.googleapis.com/calendar/v3/x", { headers: new Headers({ authorization: "Bearer TOK2" }) });
    await T.tfetch("https://www.googleapis.com/calendar/v3/x", { headers: [["Authorization", "Bearer TOK3"]] });
    await T.tfetch("https://www.googleapis.com/calendar/v3/x");                       // sin cabecera: nada que olvidar
  });
  calendarStatus = 200;
  ok(m1.get("calendar").n === 4 && seen.join() === "TOK1,TOK2,TOK3", "401 de Calendar: se informa el token (3 formas de cabecera): " + seen.join());
  seen.length = 0; calendarStatus = 401;
  await T.tfetch("https://generativelanguage.googleapis.com/x", { headers: { Authorization: "Bearer K" } });
  calendarStatus = 200; ok(seen.length === 0, "un 401 de otro servicio no toca la caché de tokens");
  T.setUnauthorizedHandler(null);

  // 4. Ruta normalizada: sin ids ni parámetros
  ok(T.normalizeRoute("/api/calendar/events/abcdefghijklmnop1234?days=7") === "/api/calendar/events/:id", "evento de Calendar -> :id y sin query");
  ok(T.normalizeRoute("/api/ai/actions/123e4567-e89b-12d3-a456-426614174000") === "/api/ai/actions/:id", "uuid -> :id");
  ok(T.normalizeRoute("/api/calendar/scan") === "/api/calendar/scan" && T.normalizeRoute(undefined) === "/", "rutas fijas intactas");

  // 5. route(): una línea JSON por request
  const lines: string[] = []; const origLog = console.log, origWarn = console.warn;
  console.log = (l: string) => { lines.push(l); }; console.warn = (l: string) => { lines.push("WARN " + l); };
  const res = () => { const r: any = { statusCode: 200, setHeader() {}, status(c: number) { r.statusCode = c; return r; }, json() { return r; } }; return r; };
  const handler = route(["GET"], async (_req: any, r: any) => {
    await T.timed("db", async () => {}); await T.timed("db", async () => {});
    await T.tfetch("https://www.googleapis.com/calendar/v3/events");
    r.status(200).json({});
  });
  await handler({ method: "GET", url: "/api/calendar/events/abcdefghijklmnop1234?days=7&token=secreto" } as any, res());
  await route(["GET"], async () => { throw new HttpError(401, "no"); })({ method: "GET", url: "/api/x" } as any, res());
  await route(["GET"], async () => { throw new Error("boom"); })({ method: "GET", url: "/api/y" } as any, res());
  await handler({ method: "DELETE", url: "/api/z" } as any, res());
  process.env.PERF_LOG = "0";
  await handler({ method: "GET", url: "/api/off" } as any, res());
  delete process.env.PERF_LOG;
  T.logPerf({ method: "POST", url: "/api/lenta", status: 200, ms: 6000, ctx: new Map() });
  console.log = origLog; console.warn = origWarn;
  const perf = lines.filter((l) => l.includes('"perf":1') || l.startsWith("WARN"));
  const first = JSON.parse(perf[0]);
  ok(first.perf === 1 && first.route === "/api/calendar/events/:id" && first.method === "GET" && first.status === 200 && typeof first.ms === "number", "línea de la ruta correcta: " + perf[0]);
  ok(first.steps.db.n === 2 && first.steps.calendar.n === 1, "pasos db x2 y calendar x1");
  ok(!perf[0].includes("secreto") && !perf[0].includes("abcdefghijklmnop1234") && !perf[0].includes("days="), "la línea no filtra ids ni parámetros");
  ok(JSON.parse(perf[1]).status === 401 && JSON.parse(perf[2]).status === 500 && JSON.parse(perf[3]).status === 405, "también se registran 401, 500 y 405");
  ok(!lines.some((l) => l.includes("/api/off")), "PERF_LOG=0 apaga el registro");
  ok(perf[4].startsWith("WARN") && JSON.parse(perf[4].slice(5)).ms === 6000, "una petición de más de 5 s sube a warn");

  // 6. Caché del token de Google
  const reset = () => { tokens.clearGoogleTokenCache(); oauthCalls = 0; dbCalls = 0; tokenSeq = 0; expiresIn = 3600; oauthMode = "ok"; userExists = true; Date.now = realNow; };
  reset();
  const t1 = await tokens.getGoogleAccessTokenForUser("u1"); const t2 = await tokens.getGoogleAccessTokenForUser("u1");
  ok(t1 === "A1" && t2 === "A1" && oauthCalls === 1 && dbCalls === 1, `segundo uso sin base ni Google: oauth=${oauthCalls} db=${dbCalls}`);
  ok(await tokens.getGoogleAccessTokenForUser("u2") === "A2" && oauthCalls === 2, "otro usuario tiene su propio token");

  reset();
  const many = await Promise.all(Array.from({ length: 6 }, () => tokens.getGoogleAccessTokenForUser("u1")));
  ok(new Set(many).size === 1 && oauthCalls === 1 && dbCalls === 1, `6 peticiones simultáneas comparten una renovación: oauth=${oauthCalls}`);

  reset(); await tokens.getGoogleAccessTokenForUser("u1");
  Date.now = () => realNow() + 49 * 60_000; await tokens.getGoogleAccessTokenForUser("u1");
  ok(oauthCalls === 1, "a los 49 min todavía se reutiliza");
  Date.now = () => realNow() + 51 * 60_000; const renewed = await tokens.getGoogleAccessTokenForUser("u1");
  ok(oauthCalls === 2 && renewed === "A2", "a los 51 min se renueva");

  reset(); expiresIn = 200; await tokens.getGoogleAccessTokenForUser("u1"); await tokens.getGoogleAccessTokenForUser("u1");
  ok(oauthCalls === 2, "un token que vence en menos del margen no se guarda");

  reset(); oauthMode = "invalid_grant"; let code = "";
  for (let i = 0; i < 2; i++) { try { await tokens.getGoogleAccessTokenForUser("u1"); } catch (e: any) { code = e.extra?.code; } }
  ok(code === "google_reauth" && oauthCalls === 2, "un fallo no se guarda: se reintenta y sigue avisando google_reauth");
  oauthMode = "ok"; ok(await tokens.getGoogleAccessTokenForUser("u1") === "A1", "tras recuperarse, funciona");

  reset(); oauthMode = "down"; let status = 0;
  try { await tokens.getGoogleAccessTokenForUser("u1"); } catch (e: any) { status = e.status; }
  ok(status === 502, "caída de Google = 502 (no cierra sesión)");

  reset(); userExists = false; let st = 0; try { await tokens.getGoogleAccessTokenForUser("ux"); } catch (e: any) { st = e.status; }
  ok(st === 404, "usuario inexistente = 404");

  reset(); await tokens.getGoogleAccessTokenForUser("primero");
  for (let i = 0; i < 520; i++) await tokens.getGoogleAccessTokenForUser("u" + i);
  const before = oauthCalls; await tokens.getGoogleAccessTokenForUser("u519");
  ok(oauthCalls === before, "los usuarios recientes siguen en la caché");
  await tokens.getGoogleAccessTokenForUser("primero");
  ok(oauthCalls === before + 1, "la caché tiene tope: el más antiguo se descartó");

  // 7. Campos mínimos de Calendar
  reset(); urls.length = 0;
  await listUpcomingEvents("tok", 7); await listEventsBetween("tok", 0, 1000);
  const q = urls.map((u) => new URL(u).searchParams.get("fields"));
  ok(q[0] === LIST_FIELDS && q[1] === WINDOW_FIELDS, "ambas consultas piden `fields`");
  for (const f of ["id", "summary", "location", "status", "start(dateTime,date)", "end(dateTime,date)"]) ok(LIST_FIELDS.includes(f), "LIST_FIELDS incluye " + f);
  for (const f of ["transparency", "eventType", "recurringEventId", "guestsCanModify", "locked", "organizer(self)", "attendees(self,responseStatus)"]) ok(WINDOW_FIELDS.includes(f), "WINDOW_FIELDS incluye " + f);

  // Filtro de respuesta parcial (gramática de `fields`: a,b(c,d)) para comprobar que NADA cambia en el análisis
  function parse(s: string, i = 0): [any, number] {
    const out: any = {};
    while (i < s.length) {
      let name = ""; while (i < s.length && !",()".includes(s[i])) name += s[i++];
      let sub: any = true;
      if (s[i] === "(") { [sub, i] = parse(s, i + 1); i++; }
      if (name) out[name] = sub;
      if (s[i] === ",") i++; else if (s[i] === ")" || i >= s.length) break;
    }
    return [out, i];
  }
  const apply = (v: any, sel: any): any => {
    if (sel === true) return v;
    if (Array.isArray(v)) return v.map((x) => apply(x, sel));
    if (v && typeof v === "object") { const o: any = {}; for (const k of Object.keys(sel)) if (k in v) o[k] = apply(v[k], sel[k]); return o; }
    return v;
  };
  const sel = parse(WINDOW_FIELDS)[0].items;
  const t = (h: number, m = 0) => ({ dateTime: `2026-10-05T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00-03:00` });
  const junk = { description: "x".repeat(2000), htmlLink: "https://...", conferenceData: { a: 1 }, creator: { email: "a@b" }, reminders: { useDefault: true }, etag: "e", iCalUID: "u" };
  const full: any[] = [
    { id: "e1", summary: "Normal", status: "confirmed", start: t(9), end: t(10), ...junk },
    { id: "e2", summary: "Con invitados (soy organizador)", status: "confirmed", start: t(9), end: t(10), organizer: { self: true, email: "yo@x" }, attendees: [{ self: true, responseStatus: "accepted", email: "yo@x" }, { email: "otro@x", responseStatus: "accepted", displayName: "Otro" }], ...junk },
    { id: "e3", summary: "Con invitados (no organizo)", status: "confirmed", start: t(9), end: t(10), organizer: { self: false, email: "jefe@x" }, attendees: [{ self: true, responseStatus: "needsAction" }, { email: "jefe@x", organizer: true }], ...junk },
    { id: "e4", summary: "Invitados pueden modificar", status: "confirmed", start: t(9), end: t(10), organizer: { self: false }, guestsCanModify: true, attendees: [{ self: true, responseStatus: "accepted" }, { email: "z@x" }], ...junk },
    { id: "e5", summary: "Rechazado", status: "confirmed", start: t(9), end: t(10), attendees: [{ self: true, responseStatus: "declined" }], ...junk },
    { id: "e6", summary: "Recurrente", status: "confirmed", start: t(9), end: t(10), recurringEventId: "rec123", ...junk },
    { id: "e7", summary: "Foco", status: "confirmed", start: t(9), end: t(10), eventType: "focusTime", ...junk },
    { id: "e8", summary: "Ubicación de trabajo", status: "confirmed", start: t(9), end: t(10), eventType: "workingLocation", ...junk },
    { id: "e9", summary: "Disponible", status: "confirmed", start: t(9), end: t(10), transparency: "transparent", ...junk },
    { id: "e10", summary: "Todo el día", status: "confirmed", start: { date: "2026-10-05" }, end: { date: "2026-10-06" }, ...junk },
    { id: "e11", summary: "Tentativo", status: "tentative", start: t(9), end: t(10), ...junk },
    { id: "e12", summary: "Bloqueado", status: "confirmed", start: t(9), end: t(10), locked: true, ...junk },
    { id: "e13", status: "cancelled", start: t(9), end: t(10), ...junk },
    { id: "e14", summary: "Sin título explícito", status: "confirmed", start: t(11), end: t(12), location: "Sala 2", default: 1, ...junk },
  ];
  let same = 0;
  for (const ev of full) {
    const filtered = apply(ev, sel);
    const x = JSON.stringify(toPlannerEvent(ev)), y = JSON.stringify(toPlannerEvent(filtered));
    ok(x === y, `con campos mínimos el evento "${ev.summary ?? ev.id}" se analiza igual:\n   completo=${x}\n   filtrado=${y}`);
    if (x === y) same++;
  }
  const bytes = (o: any) => JSON.stringify(o).length;
  console.log(`Eventos equivalentes: ${same}/${full.length}. Tamaño: ${bytes(full)} B completo -> ${bytes(full.map((e) => apply(e, sel)))} B con fields (${Math.round((1 - bytes(full.map((e) => apply(e, sel))) / bytes(full)) * 100)}% menos)`);

  Date.now = realNow;
  console.log(fails === 0 ? "TODO OK" : `${fails} fallas`);
})();
