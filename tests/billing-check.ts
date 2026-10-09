// Prueba del cobro preparado: acceso gratis/prueba, enforcement (402), verificación de compras con Google Play simulado.
// Ejecutar: npx tsx tests/billing-check.ts   (sin red ni base de datos reales)
import Module from "node:module";
import { generateKeyPairSync } from "node:crypto";

let fails = 0;
const ok = (c: boolean, m: string) => { if (!c) { fails++; console.log("FALLA:", m); } };
const eq = (a: unknown, b: unknown, m: string) => ok(JSON.stringify(a) === JSON.stringify(b), `${m}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`);

// ---- base de datos simulada ---------------------------------------------------------------------------------------
let users: Record<string, any> = {};
const execs: { sql: string; params: any[] }[] = [];
const fakeDb = {
  query: async (sql: string, params: any[] = []) => {
    if (/SELECT \* FROM users WHERE id = \?/.test(sql)) return users[params[0]] ? [users[params[0]]] : [];
    if (/SELECT \* FROM users WHERE id IN/.test(sql)) return params.map((id: string) => users[id]).filter(Boolean);
    if (/SELECT id FROM users WHERE play_(onboarding|subscription)_token = \?/.test(sql)) {
      const col = /play_subscription_token/.test(sql) ? "play_subscription_token" : "play_onboarding_token";
      return Object.values(users).filter((u: any) => u[col] === params[0] && u.id !== params[1]).map((u: any) => ({ id: u.id }));
    }
    return [];
  },
  exec: async (sql: string, params: any[] = []) => {
    execs.push({ sql, params });
    const id = params[params.length - 1];
    const u = users[id];
    if (u) {
      if (/SET onboarding_completed = 1, play_onboarding_token = \?/.test(sql)) { u.onboarding_completed = 1; u.play_onboarding_token = params[0]; }
      if (/SET subscription_active = 1, subscription_expires_at = \?, play_subscription_token = \?/.test(sql)) { u.subscription_active = 1; u.subscription_expires_at = params[0]; u.play_subscription_token = params[1]; }
      if (/SET subscription_active = 1, subscription_expires_at = \? WHERE/.test(sql)) { u.subscription_active = 1; u.subscription_expires_at = params[0]; }
      if (/SET subscription_active = 0/.test(sql)) u.subscription_active = 0;
    }
    return { insertId: 1, affectedRows: 1 };
  },
};
const orig = (Module as any)._load;
(Module as any)._load = function (req: string, ...rest: any[]) {
  if (/(^|\/)db$/.test(req)) return fakeDb;
  return orig.call(this, req, ...rest);
};
console.error = () => {};
console.warn = () => {};

// ---- Google Play simulado -----------------------------------------------------------------------------------------
const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
process.env.PLAY_PACKAGE_NAME = "com.framirez.timemanager";
process.env.PLAY_ONBOARDING_PRODUCT_ID = "onboarding_5usd";
process.env.PLAY_SUBSCRIPTION_ID = "monthly_sub";
process.env.PLAY_SERVICE_ACCOUNT_JSON = JSON.stringify({ client_email: "svc@x.iam.gserviceaccount.com", private_key: privateKey });
process.env.JWT_SECRET = "test-secret-test-secret";

const playCalls: { url: string; method: string }[] = [];
let productState: any = { purchaseState: 0, acknowledgementState: 0, orderId: "GPA.1" };
let subState: any = null;
const json = (b: any, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
(globalThis as any).fetch = async (url: any, init?: any) => {
  const u = String(url);
  playCalls.push({ url: u, method: init?.method ?? "GET" });
  if (u.startsWith("https://oauth2.googleapis.com/token")) return json({ access_token: "play-token", expires_in: 3600 });
  if (u.includes("/purchases/products/") && !u.endsWith(":acknowledge")) return productState ? json(productState) : json({}, 404);
  if (u.includes("/purchases/subscriptionsv2/tokens/")) return subState ? json(subState) : json({}, 404);
  if (u.endsWith(":acknowledge")) return json({});
  throw new Error("URL inesperada " + u);
};

(async () => {
  const { computeAccess, parseFreeAccess, requireAccess, entitledUserIds } = await import("../lib/billing");
  const { toApiUser } = await import("../lib/users");
  const { signAccessToken } = await import("../lib/auth");
  const { verifyOnboardingPurchase, verifySubscription, clearPlayTokenCache } = await import("../lib/playBilling");
  const confirm = (await import("../api/billing/confirm-onboarding")).default as any;
  const chat = (await import("../lib/routes/ai/chat")).default as any;

  const NOW = Date.parse("2026-10-09T12:00:00Z");
  const fresh = { id: "u1", email: "nuevo@x.com", onboarding_completed: 0, subscription_active: 0 };

  // 1. Cobro APAGADO: nadie ve el pago, tampoco los usuarios nuevos.
  delete process.env.BILLING_ENABLED;
  eq(computeAccess(fresh, NOW), { access: "open", paywall: false, until: null }, "apagado: acceso abierto");
  const apiOff = toApiUser({ ...fresh, google_sub: "g", name: "N", photo_url: null, google_refresh_token_enc: "" } as any);
  ok(apiOff.onboardingCompleted === true && apiOff.access === "open", "apagado: onboardingCompleted=true (no sale la pantalla de pago)");

  // 2. Cobro ENCENDIDO
  process.env.BILLING_ENABLED = "true";
  process.env.FREE_ACCESS_EMAILS = "Yo@Mail.com, amigo@x.com:2026-12-31 ,vencido@x.com:2026-01-01, roto@x.com:mañana, nomail";
  eq(parseFreeAccess().map((e) => e.email), ["yo@mail.com", "amigo@x.com", "vencido@x.com"], "lista: correos válidos (fecha rota se ignora)");
  eq(computeAccess({ ...fresh, email: "yo@mail.com" }, NOW).access, "free", "tu correo (sin importar mayúsculas): gratis");
  const trial = computeAccess({ ...fresh, email: "amigo@x.com" }, NOW);
  ok(trial.access === "trial" && !trial.paywall && trial.until === "2026-12-31T23:59:59.999Z", "correo con fecha: prueba hasta esa fecha");
  eq(computeAccess({ ...fresh, email: "amigo@x.com" }, Date.parse("2027-01-01T00:00:00Z")).access, "payment_required", "la prueba vencida vuelve a pedir pago");
  eq(computeAccess({ ...fresh, email: "vencido@x.com" }, NOW).access, "payment_required", "entrada ya vencida: debe pagar");
  eq(computeAccess({ ...fresh, email: "roto@x.com" }, NOW).access, "payment_required", "fecha rota no regala acceso");
  eq(computeAccess(fresh, NOW).access, "payment_required", "usuario común nuevo: debe pagar");
  eq(computeAccess({ ...fresh, access_override: "free" }, NOW).access, "free", "override free en la base");
  eq(computeAccess({ ...fresh, access_override: "trial", access_until: "2026-10-31" }, NOW).access, "trial", "override trial vigente (texto)");
  eq(computeAccess({ ...fresh, access_override: "trial", access_until: new Date("2026-10-31") }, NOW).access, "trial", "override trial vigente (Date)");
  eq(computeAccess({ ...fresh, access_override: "trial", access_until: "2026-10-01" }, NOW).access, "payment_required", "override trial vencido");
  eq(computeAccess({ ...fresh, access_override: "trial" }, NOW).access, "payment_required", "trial sin fecha no regala acceso");
  eq(computeAccess({ ...fresh, onboarding_completed: 1, subscription_active: 1, subscription_expires_at: "2026-11-01 00:00:00" }, NOW).access, "paid", "pagó y suscripción vigente");
  eq(computeAccess({ ...fresh, onboarding_completed: 1, subscription_active: 1, subscription_expires_at: "2026-10-01 00:00:00" }, NOW).access, "payment_required", "suscripción vencida");
  eq(computeAccess({ ...fresh, onboarding_completed: 1, subscription_active: 0 }, NOW).access, "payment_required", "pagó la activación pero sin suscripción");
  eq(computeAccess({ ...fresh, onboarding_completed: 1, subscription_active: 1 }, NOW).access, "paid", "base sin migrar (sin vencimiento): se respeta lo guardado");
  const apiOn = toApiUser({ ...fresh, google_sub: "g", name: "N", photo_url: null, google_refresh_token_enc: "" } as any);
  ok(apiOn.onboardingCompleted === false && apiOn.access === "payment_required", "encendido: el usuario común sí ve el pago");
  const apiFree = toApiUser({ ...fresh, email: "yo@mail.com", google_sub: "g", name: "N", photo_url: null, google_refresh_token_enc: "" } as any);
  ok(apiFree.onboardingCompleted === true && apiFree.access === "free", "encendido: tu correo NO ve el pago");

  // 3. Enforcement (402) en el chat y en las confirmaciones
  users = {
    u1: { ...fresh, email: "nuevo@x.com" },
    u2: { id: "u2", email: "yo@mail.com", onboarding_completed: 0, subscription_active: 0 },
  };
  const reqFor = async (id: string, body: any = {}) => ({ method: "POST", headers: { authorization: `Bearer ${await signAccessToken(id)}` }, body, url: "/x", query: {} }) as any;
  const resMock = () => { const r: any = { code: 0, body: null, headers: {} }; r.setHeader = (k: string, v: string) => { r.headers[k] = v; }; r.status = (c: number) => { r.code = c; return r; }; r.json = (b: any) => { r.body = b; return r; }; return r; };

  const r1 = resMock(); await chat(await reqFor("u1", { message: "hola, qué tal" }), r1);
  ok(r1.code === 402 && r1.body.code === "payment_required", `chat: quien debe pagar recibe 402 (fue ${r1.code})`);
  const r2 = resMock(); await chat(await reqFor("u2", { message: "gracias" }), r2);
  ok(r2.code === 200, `chat: tu correo (gratis) pasa (fue ${r2.code})`);
  delete process.env.BILLING_ENABLED;
  const r3 = resMock(); await chat(await reqFor("u1", { message: "gracias" }), r3);
  ok(r3.code === 200, "chat: con el cobro apagado todos pasan (y sin consultar la base)");
  process.env.BILLING_ENABLED = "true";
  const ent = await entitledUserIds(["u1", "u2"]);
  ok(!ent.has("u1") && ent.has("u2"), "barrido: solo cuentas con acceso");

  // 4. Verificación de compras con Google Play
  clearPlayTokenCache();
  const TOKEN = "abcdefghijklmnopqrstuvwxyz.0123456789-_";
  playCalls.length = 0;
  let v: any = await verifyOnboardingPurchase(TOKEN);
  ok(v.ok === true && v.orderId === "GPA.1", "compra válida");
  ok(playCalls.some((c) => c.url.includes("/purchases/products/onboarding_5usd/tokens/") && c.method === "GET"), "consulta el producto configurado");
  ok(playCalls.some((c) => c.url.endsWith(":acknowledge") && c.method === "POST"), "confirma (acknowledge) la compra nueva");
  ok(playCalls.filter((c) => c.url.startsWith("https://oauth2")).length === 1, "pidió un token de Google");
  playCalls.length = 0; await verifyOnboardingPurchase(TOKEN);
  ok(!playCalls.some((c) => c.url.startsWith("https://oauth2")), "reutiliza el token de Google (memoria)");
  productState = { purchaseState: 1 }; v = await verifyOnboardingPurchase(TOKEN); ok(v.ok === false, "compra cancelada = rechazada");
  productState = { purchaseState: 2 }; v = await verifyOnboardingPurchase(TOKEN); ok(v.ok === false && /pendiente/.test(v.reason), "pago pendiente = rechazado");
  productState = null; v = await verifyOnboardingPurchase(TOKEN); ok(v.ok === false, "token desconocido = rechazado");
  productState = { purchaseState: 0, acknowledgementState: 1, orderId: "GPA.1" };
  v = await verifyOnboardingPurchase("../../etc/passwd"); ok(v.ok === false, "token con caracteres raros = rechazado sin consultar");

  const future = new Date(Date.now() + 20 * 86400_000).toISOString();
  subState = { subscriptionState: "SUBSCRIPTION_STATE_ACTIVE", acknowledgementState: "ACKNOWLEDGEMENT_STATE_PENDING", lineItems: [{ productId: "monthly_sub", expiryTime: future }] };
  playCalls.length = 0; let s: any = await verifySubscription(TOKEN);
  ok(s.ok === true && Math.abs(s.expiresAtMs - Date.parse(future)) < 1000, "suscripción activa");
  ok(playCalls.some((c) => c.url.includes("/purchases/subscriptions/monthly_sub/tokens/") && c.url.endsWith(":acknowledge")), "confirma la suscripción nueva");
  subState.subscriptionState = "SUBSCRIPTION_STATE_CANCELED"; s = await verifySubscription(TOKEN); ok(s.ok === true, "cancelada pero con tiempo pagado: sigue valiendo");
  subState.subscriptionState = "SUBSCRIPTION_STATE_EXPIRED"; s = await verifySubscription(TOKEN); ok(s.ok === false, "vencida = rechazada");
  subState.subscriptionState = "SUBSCRIPTION_STATE_ON_HOLD"; s = await verifySubscription(TOKEN); ok(s.ok === false, "en espera de pago = rechazada");
  subState = { subscriptionState: "SUBSCRIPTION_STATE_ACTIVE", lineItems: [{ productId: "otra_app", expiryTime: future }] };
  s = await verifySubscription(TOKEN); ok(s.ok === false, "suscripción de otro producto = rechazada");

  // 5. Endpoint de activación
  users = { u1: { ...fresh, email: "nuevo@x.com" }, u9: { id: "u9", email: "otro@x.com", onboarding_completed: 0, subscription_active: 0, play_onboarding_token: TOKEN } };
  productState = { purchaseState: 0, acknowledgementState: 1, orderId: "GPA.2" };
  let r = resMock(); await confirm(await reqFor("u1", {}), r);
  ok(r.code === 400, `sin compra no activa (fue ${r.code})`);
  ok(users.u1.onboarding_completed === 0, "sin compra no se marca nada");
  r = resMock(); await confirm(await reqFor("u1", { type: "onboarding", purchaseToken: TOKEN }), r);
  ok(r.code === 409, `un token usado por otra cuenta se rechaza (fue ${r.code})`);
  const TOKEN2 = "token-nuevo-0123456789";
  productState = { purchaseState: 1 };
  r = resMock(); await confirm(await reqFor("u1", { type: "onboarding", purchaseToken: TOKEN2 }), r);
  ok(r.code === 402 && users.u1.onboarding_completed === 0, "compra no válida: 402 y no activa");
  productState = { purchaseState: 0, acknowledgementState: 1, orderId: "GPA.3" };
  r = resMock(); await confirm(await reqFor("u1", { type: "onboarding", purchaseToken: TOKEN2 }), r);
  ok(r.code === 200 && users.u1.onboarding_completed === 1 && r.body.access === "payment_required", "pago único verificado: activa, pero aún falta la suscripción");
  subState = { subscriptionState: "SUBSCRIPTION_STATE_ACTIVE", acknowledgementState: "ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED", lineItems: [{ productId: "monthly_sub", expiryTime: future }] };
  const SUB = "sub-token-0123456789";
  r = resMock(); await confirm(await reqFor("u1", { type: "subscription", purchaseToken: SUB }), r);
  ok(r.code === 200 && r.body.access === "paid" && r.body.onboardingCompleted === true, "suscripción verificada: acceso pagado");
  // Renovación vencida -> sync la renueva
  users.u1.subscription_expires_at = new Date(Date.now() - 1000);
  r = resMock(); await confirm(await reqFor("u1", { type: "sync" }), r);
  ok(r.code === 200 && r.body.access === "paid", "sync: renueva con la suscripción guardada");
  subState = { subscriptionState: "SUBSCRIPTION_STATE_EXPIRED", lineItems: [{ productId: "monthly_sub", expiryTime: new Date(Date.now() - 86400_000).toISOString() }] };
  users.u1.subscription_expires_at = new Date(Date.now() - 1000);
  r = resMock(); await confirm(await reqFor("u1", { type: "sync" }), r);
  ok(r.code === 200 && r.body.access === "payment_required", "sync: suscripción vencida vuelve a pedir pago");
  // Cobro apagado: el endpoint solo informa y NO activa nada
  delete process.env.BILLING_ENABLED;
  users.u1.onboarding_completed = 0; execs.length = 0;
  r = resMock(); await confirm(await reqFor("u1", { purchaseToken: TOKEN2 }), r);
  ok(r.code === 200 && r.body.access === "open" && execs.length === 0, "apagado: informa el estado y no escribe nada");

  console.log(fails ? `${fails} FALLAS` : "billing-check: todo bien");
  process.exit(fails ? 1 : 0);
})();
