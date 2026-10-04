// Prueba del barrido, el envío FCM y los ajustes en el servidor (sin red ni base real).
// Ejecutar: npx tsx tests/sweep-check.ts
import Module from "module";
import { generateKeyPairSync } from "node:crypto";
import { jwtVerify, importSPKI } from "jose";

let fails = 0;
const ok = (c: boolean, m: string) => { if (!c) { fails++; console.log("FALLA:", m); } };

// ---- base de datos y scanUser simulados (se instalan ANTES de importar el código) ------------
const settingsTable = new Map<string, { settings: string; time_zone: string }>();
let userRows: any[] = [];                       // resultado de la selección del barrido
const claimable = new Set<string>();            // usuarios cuyo reclamo prospera
const devices = new Map<string, string[]>();    // user_id -> tokens
const deletedTokens: string[] = [];
const scanScript = new Map<string, any>();      // user_id -> ScanResult o Error
const scanned: string[] = [];

const fakeDb = {
  query: async (sql: string, p: any[] = []) => {
    if (sql.includes("FROM user_settings s")) return userRows;
    if (sql.includes("FROM devices WHERE user_id")) return (devices.get(p[0]) ?? []).map((t) => ({ fcm_token: t }));
    if (sql.includes("SELECT settings, time_zone FROM user_settings")) {
      const r = settingsTable.get(p[0]); return r ? [r] : [];
    }
    throw new Error("SQL inesperado: " + sql);
  },
  exec: async (sql: string, p: any[] = []) => {
    if (sql.includes("UPDATE user_settings SET last_scan_at")) return { affectedRows: claimable.has(p[0]) ? 1 : 0 };
    if (sql.includes("DELETE FROM devices")) { deletedTokens.push(p[0]); return { affectedRows: 1 }; }
    if (sql.includes("INSERT INTO user_settings")) { settingsTable.set(p[0], { settings: p[1], time_zone: p[2] }); return { affectedRows: 1 }; }
    throw new Error("SQL inesperado: " + sql);
  },
};
const fakeScan = {
  scanUser: async ({ userId }: any) => {
    scanned.push(userId);
    const r = scanScript.get(userId);
    if (r instanceof Error) throw r;
    return r ?? { created: [], applied: [], pending: 0, unresolved: 0 };
  },
};
const orig = (Module as any)._load;
(Module as any)._load = function (req: string, ...rest: any[]) {
  if (/(^|\/)db$/.test(req)) return fakeDb;
  if (/(^|\/)scan$/.test(req) && !req.includes("api")) return fakeScan;
  return orig.call(this, req, ...rest);
};

// ---- FCM simulado -------------------------------------------------------------------------
const { publicKey, privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048, publicKeyEncoding: { type: "spki", format: "pem" }, privateKeyEncoding: { type: "pkcs8", format: "pem" },
});
const SA = { project_id: "proj-test", client_email: "bot@proj-test.iam.gserviceaccount.com", private_key: privateKey };
const fcmCalls: { token: string; body: any; auth: string }[] = [];
let oauthCalls = 0; let lastAssertion = "";
const json = (b: any, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
(globalThis as any).fetch = async (url: any, init?: any) => {
  const u = String(url);
  if (u === "https://oauth2.googleapis.com/token") {
    oauthCalls++; lastAssertion = new URLSearchParams(String(init.body)).get("assertion") ?? "";
    return json({ access_token: "tok-abc", expires_in: 3600 });
  }
  if (u === "https://fcm.googleapis.com/v1/projects/proj-test/messages:send") {
    const body = JSON.parse(init.body);
    fcmCalls.push({ token: body.message.token, body, auth: init.headers.Authorization });
    if (body.message.token === "dead") return json({ error: { status: "NOT_FOUND", details: [{ errorCode: "UNREGISTERED" }] } }, 404);
    if (body.message.token === "flaky") return json({ error: { status: "UNAVAILABLE" } }, 503);
    return json({ name: "projects/proj-test/messages/1" });
  }
  throw new Error("URL inesperada " + u);
};

process.env.JWT_SECRET = "s".repeat(40);
const reset = () => { fcmCalls.length = 0; deletedTokens.length = 0; scanned.length = 0; scanScript.clear(); claimable.clear(); devices.clear(); userRows = []; };

(async () => {
  const { buildScanPush, runSweep } = await import("../lib/sweep");
  const { readServiceAccount, sendPush } = await import("../lib/fcm");
  const { default: cron } = await import("../api/cron/scan");
  const { default: settingsApi } = await import("../api/settings");
  const { signAccessToken } = await import("../lib/auth");

  // 1. Contenido del push
  ok(buildScanPush({ created: [], applied: [] }) === null, "sin novedades no hay push");
  const one = buildScanPush({ created: [{ eventId: "ev1", reason: "Se solapa con X" }], applied: [] })!;
  ok(one.type === "scan" && one.n === "1" && one.e === "ev1" && one.r === "Se solapa con X" && one.a === "[]", "1 sugerencia: lleva eventId y motivo");
  const many = buildScanPush({ created: Array.from({ length: 5 }, (_, i) => ({ eventId: "e" + i, reason: "r" })), applied: [] })!;
  ok(many.n === "5" && many.e === undefined && many.r === undefined, "varias: solo la cantidad");
  const huge = buildScanPush({
    created: [{ eventId: "e".repeat(900), reason: "r".repeat(900) }],
    applied: Array.from({ length: 9 }, () => ({ eventId: "x", title: "t", from: "", to: "", description: "d".repeat(900) })),
  })!;
  ok(JSON.parse(huge.a).length === 3, "máximo 3 cambios automáticos");
  ok(Object.values(huge).every((v) => typeof v === "string"), "todos los valores son texto (requisito de FCM)");
  ok(Buffer.byteLength(JSON.stringify(huge)) < 3500, "el mensaje queda muy por debajo de 4 KB: " + Buffer.byteLength(JSON.stringify(huge)));

  // 2. Cuenta de servicio
  delete process.env.FIREBASE_SERVICE_ACCOUNT;
  ok(readServiceAccount() === null, "sin variable = no configurada");
  process.env.FIREBASE_SERVICE_ACCOUNT = JSON.stringify(SA);
  ok(readServiceAccount()?.project_id === "proj-test", "acepta el JSON tal cual");
  process.env.FIREBASE_SERVICE_ACCOUNT = Buffer.from(JSON.stringify(SA)).toString("base64");
  ok(readServiceAccount()?.client_email === SA.client_email, "acepta base64");
  process.env.FIREBASE_SERVICE_ACCOUNT = JSON.stringify({ ...SA, private_key: SA.private_key.replace(/\n/g, "\\n") });
  ok(readServiceAccount()?.private_key.includes("\n-----END") === true, "repara los \\n literales de la clave");
  for (const bad of ["no es json", JSON.stringify({ project_id: "x" })]) {
    process.env.FIREBASE_SERVICE_ACCOUNT = bad;
    let threw = false; try { readServiceAccount(); } catch { threw = true; }
    ok(threw, "cuenta inválida lanza error: " + bad.slice(0, 20));
  }
  process.env.FIREBASE_SERVICE_ACCOUNT = JSON.stringify(SA);
  const sa = readServiceAccount()!;

  // 3. Envío: JWT firmado de verdad, token reutilizado, resultados
  reset();
  ok(await sendPush(sa, "good", { type: "scan" }) === "sent", "envío correcto");
  ok(await sendPush(sa, "good2", { type: "scan" }) === "sent", "segundo envío");
  ok(oauthCalls === 1, "el token OAuth se reutiliza: " + oauthCalls + " llamadas");
  const { payload, protectedHeader } = await jwtVerify(lastAssertion, await importSPKI(publicKey, "RS256"), { audience: "https://oauth2.googleapis.com/token" });
  ok(protectedHeader.alg === "RS256" && payload.iss === SA.client_email && payload.scope === "https://www.googleapis.com/auth/firebase.messaging", "JWT bien formado y con firma válida");
  ok(fcmCalls[0].auth === "Bearer tok-abc" && fcmCalls[0].body.message.android.priority === "HIGH" && fcmCalls[0].body.message.data.type === "scan" && !fcmCalls[0].body.message.notification, "mensaje solo de datos, prioridad alta");
  ok(await sendPush(sa, "dead", {}) === "unregistered", "404 UNREGISTERED -> unregistered");
  ok(await sendPush(sa, "flaky", {}) === "failed", "503 -> failed (no se borra el token)");

  // 4. Barrido SIN FCM: no analiza nada (no debe "gastar" las sugerencias nuevas)
  reset(); delete process.env.FIREBASE_SERVICE_ACCOUNT; userRows = [{ user_id: "u1", settings: "{}", time_zone: "UTC" }]; claimable.add("u1");
  let s = await runSweep();
  ok(!s.fcmConfigured && scanned.length === 0 && s.scanned === 0, "sin FCM no se analiza a nadie");

  // 5. Barrido con FCM
  process.env.FIREBASE_SERVICE_ACCOUNT = JSON.stringify(SA);
  reset();
  userRows = ["u1", "u2", "u3", "u4", "u5"].map((id) => ({ user_id: id, settings: JSON.stringify({ autonomyLevel: "autopilot" }), time_zone: "America/Argentina/Buenos_Aires" }));
  for (const id of ["u1", "u2", "u3", "u5"]) claimable.add(id);               // u4: otro barrido ya lo atendió
  devices.set("u1", ["good", "dead"]);                                       // un token vivo y uno muerto
  scanScript.set("u1", { created: [{ eventId: "ev1", reason: "Conflicto" }], applied: [], pending: 1, unresolved: 0 });
  scanScript.set("u2", Object.assign(new Error("venció"), { name: "HttpError", status: 401, extra: { code: "google_reauth" } }));
  scanScript.set("u3", new Error("falló Calendar"));
  devices.set("u5", ["good"]);                                               // u5 sin novedades: no se manda nada
  const { HttpError } = await import("../lib/http");
  scanScript.set("u2", new HttpError(401, "venció", { code: "google_reauth" }));
  s = await runSweep();
  ok(s.fcmConfigured && s.selected === 5 && s.scanned === 2 + 0 + 0 && s.skipped === 1, `contadores: ${JSON.stringify(s)}`);
  ok(s.needsLogin === 1 && s.errors === 1, "google_reauth se cuenta aparte de los errores");
  ok(s.notified === 1 && s.pushesSent === 1 && s.tokensRemoved === 1 && deletedTokens[0] === "dead", "push al token vivo; el muerto se borra");
  ok(!scanned.includes("u4"), "el usuario reclamado por otro barrido no se analiza");
  ok(fcmCalls.length === 2 && fcmCalls.every((c) => c.body.message.data.e === "ev1"), "solo u1 recibe push (2 tokens)");
  ok(fcmCalls.every((c) => !JSON.stringify(c.body).includes("Authorization")), "el cuerpo no filtra credenciales");

  // 6. Presupuesto de tiempo
  reset(); userRows = [{ user_id: "u1", settings: "{}", time_zone: "UTC" }]; claimable.add("u1"); devices.set("u1", ["good"]);
  s = await runSweep({ budgetMs: -1 });
  ok(s.timeBudgetReached && scanned.length === 0, "con el presupuesto agotado no empieza otro usuario");

  // 7. Endpoint del barrido: protegido
  const call = async (headers: Record<string, string>, method = "POST") => {
    let status = 0; let out: any;
    const res: any = { setHeader() {}, status(c: number) { status = c; return this; }, json(b: any) { out = b; return this; } };
    await cron({ method, headers, body: {} } as any, res);
    return { status, out };
  };
  delete process.env.CRON_SECRET;
  ok((await call({ authorization: "Bearer x" })).status === 503, "sin CRON_SECRET queda cerrado (503)");
  process.env.CRON_SECRET = "corta";
  ok((await call({ authorization: "Bearer corta" })).status === 503, "una CRON_SECRET demasiado corta no se acepta");
  process.env.CRON_SECRET = "s3creto-largo-de-prueba-123456";
  ok((await call({})).status === 401, "sin cabecera = 401");
  ok((await call({ authorization: "Bearer otra-cosa-distinta" })).status === 401, "clave incorrecta = 401");
  ok((await call({ authorization: "Basic s3creto-largo-de-prueba-123456" })).status === 401, "esquema distinto de Bearer = 401");
  ok((await call({ authorization: "Bearer s3creto-largo-de-prueba-123456" }, "DELETE")).status === 405, "método no permitido = 405");
  delete process.env.FIREBASE_SERVICE_ACCOUNT;
  const good = await call({ authorization: "Bearer s3creto-largo-de-prueba-123456" });
  ok(good.status === 200 && good.out.fcmConfigured === false, "clave correcta = 200 con resumen");
  ok((await call({ authorization: "Bearer s3creto-largo-de-prueba-123456" }, "GET")).status === 200, "GET también (Vercel Cron usa GET)");

  // 8. Ajustes en el servidor
  const token = await signAccessToken("user-1");
  const api = async (method: string, body?: any, auth = true) => {
    let status = 0; let out: any;
    const res: any = { setHeader() {}, status(c: number) { status = c; return this; }, json(b: any) { out = b; return this; } };
    await settingsApi({ method, headers: auth ? { authorization: `Bearer ${token}` } : {}, body } as any, res);
    return { status, out };
  };
  ok((await api("GET", undefined, false)).status === 401, "ajustes exigen sesión");
  ok((await api("GET")).out.settings === null, "GET sin ajustes guardados");
  const put = await api("PUT", {
    timeZone: "America/Argentina/Buenos_Aires",
    settings: { autonomyLevel: "hack", bufferMinutes: 99999, dailyActionLimit: 0, appAccess: { gmail: "blocked", calendar: "raro", sms: "read_only" },
      blockedHours: [{ dayOfWeek: 9, startTime: "09:00", endTime: "10:00" }, { dayOfWeek: 1, startTime: "09:00", endTime: "13:00", label: "Foco" }] },
  });
  const st = put.out.settings;
  ok(put.status === 200 && st.autonomyLevel === "suggestion" && st.bufferMinutes === 240 && st.dailyActionLimit === 1, "valores fuera de rango se corrigen");
  ok(st.appAccess.gmail === "blocked" && st.appAccess.calendar === "blocked" && st.appAccess.sms === "blocked", "appAccess inválido = bloqueado");
  ok(st.blockedHours.length === 1 && st.blockedHours[0].label === "Foco", "franjas inválidas se descartan");
  const back = await api("GET");
  ok(back.out.timeZone === "America/Argentina/Buenos_Aires" && back.out.settings.appAccess.gmail === "blocked", "GET devuelve lo guardado");
  const badTz = await api("PUT", { settings: {}, timeZone: "Marte/Olimpo" });
  ok(badTz.out.timeZone !== "Marte/Olimpo", "zona horaria inválida se reemplaza: " + badTz.out.timeZone);

  console.log(fails === 0 ? "TODO OK" : `${fails} fallas`);
})();
