// Comprueba que, tras agrupar los endpoints en pocas funciones, TODAS las URLs de siempre siguen llegando a
// su handler, y que el número de funciones respeta el límite de Vercel Hobby. Ejecutar: npx tsx tests/routes-check.ts
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { dispatcher } from "../lib/dispatch";

let fails = 0;
const ok = (c: boolean, m: string) => { if (!c) { fails++; console.log("FALLA:", m); } };

// 1. Límite de funciones (cada archivo de api/ que no empiece con "_" es una función)
const fnFiles: string[] = [];
(function walk(dir: string) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) { if (!name.startsWith("_")) walk(p); continue; }
    if (/\.(ts|js)$/.test(name) && !name.startsWith("_")) fnFiles.push(p);
  }
})("api");
ok(fnFiles.length <= 12, `Vercel Hobby admite 12 funciones y hay ${fnFiles.length}: ${fnFiles.join(", ")}`);

function fakeRes() {
  const r: any = { status: 0, body: undefined, headers: {} };
  r.setHeader = (k: string, v: string) => { r.headers[k] = v; };
  r.status = (c: number) => { r.code = c; return r; };
  r.json = (b: any) => { r.body = b; return r; };
  return r;
}
async function call(fn: any, method: string, url: string, extra: any = {}) {
  const res = fakeRes();
  const req: any = { method, url, headers: {}, query: {}, body: {}, ...extra };
  await fn(req, res);
  return { code: res.code as number, body: res.body, req };
}

(async () => {
  process.env.JWT_SECRET = "s".repeat(40);
  const loads = {
    auth: (await import("../api/auth/[...slug]")).default,
    ai: (await import("../api/ai/[...slug]")).default,
    calendar: (await import("../api/calendar/[...slug]")).default,
    devices: (await import("../api/devices/[...slug]")).default,
    billing: (await import("../api/billing/confirm-onboarding")).default,
    settings: (await import("../api/settings")).default,
    cron: (await import("../api/cron/scan")).default,
  };

  // 2. Cada URL que usa la app (y el planificador) llega a SU handler real: sin sesión responde 400/401/503, nunca 404
  const urls: [keyof typeof loads, string, string][] = [
    ["auth", "POST", "/api/auth/google"], ["auth", "GET", "/api/auth/me"], ["auth", "POST", "/api/auth/refresh"],
    ["ai", "POST", "/api/ai/chat"], ["ai", "GET", "/api/ai/usage"], ["ai", "POST", "/api/ai/actions/3f2a9c1e-77aa-4b1c-9d0e-123456789abc/confirm"],
    ["calendar", "GET", "/api/calendar/events?days=7"], ["calendar", "DELETE", "/api/calendar/events/abc123def456"],
    ["calendar", "POST", "/api/calendar/scan"], ["calendar", "GET", "/api/calendar/suggestions"], ["calendar", "POST", "/api/calendar/suggestions/abc123def456"],
    ["devices", "POST", "/api/devices/register"], ["devices", "POST", "/api/devices/unregister"],
    ["billing", "POST", "/api/billing/confirm-onboarding"], ["settings", "GET", "/api/settings"], ["cron", "POST", "/api/cron/scan"],
  ];
  for (const [group, method, url] of urls) {
    const { code } = await call(loads[group], method, url);
    ok([400, 401, 403, 503].includes(code), `${method} ${url} debe llegar a su handler (devolvió ${code})`);
  }

  // 3. Un método equivocado llega al handler y recibe 405 (prueba de que el despacho funciona)
  ok((await call(loads.auth, "GET", "/api/auth/google")).code === 405, "GET /api/auth/google = 405 del propio handler");
  ok((await call(loads.ai, "GET", "/api/ai/chat")).code === 405, "GET /api/ai/chat = 405");

  // 4. Rutas inexistentes = 404 (no llegan a ningún handler)
  for (const [group, url] of [["ai", "/api/ai/nope"], ["ai", "/api/ai/actions/abc"], ["ai", "/api/ai/actions/abc/confirm/extra"],
    ["calendar", "/api/calendar/events/a/b"], ["auth", "/api/auth/"], ["devices", "/api/devices/otra"]] as const) {
    ok((await call(loads[group], "GET", url)).code === 404, `${url} = 404`);
  }
  ok((await call(loads.calendar, "GET", "/api/calendar/events/%E0%A4%A")).code === 404, "un % mal formado = 404 (no revienta)");

  // 5. Parámetros de ruta con handlers de prueba: llegan a req.query y el valor de la ruta manda sobre el del cliente
  const seen: any[] = [];
  const stub = dispatcher("/api/x/", {
    plain: async (req) => { seen.push(["plain", req.query]); },
    "items/:itemId": async (req) => { seen.push(["item", req.query]); },
    "a/:p/b/:q": async (req) => { seen.push(["ab", req.query]); },
  });
  await call(stub, "GET", "/api/x/items/real?itemId=falso&otro=1", { query: { itemId: "falso", otro: "1" } });
  ok(seen[0][1].itemId === "real" && seen[0][1].otro === "1", "el parámetro de la ruta pisa al del cliente y se conserva el resto");
  await call(stub, "GET", "/api/x/items/a%20b");
  ok(seen[1][1].itemId === "a b", "se decodifica el segmento");
  await call(stub, "GET", "/api/x/a/1/b/2");
  ok(seen[2][1].p === "1" && seen[2][1].q === "2", "varios parámetros");
  await call(stub, "GET", "/otra/cosa", { query: { slug: ["items", "z"] } });
  ok(seen[3]?.[1].itemId === "z", "respaldo: si la URL no trae el prefijo se usa el parámetro slug (lista)");
  await call(stub, "GET", "/otra/cosa", { query: { slug: "plain" } });
  ok(seen[4]?.[0] === "plain", "respaldo: slug como texto");

  // req.query de solo lectura (getter sin setter, como una propiedad perezosa): los parámetros llegan igual
  const ro: any = { method: "GET", url: "/api/x/items/xyz", headers: {}, body: {} };
  const cached = { itemId: "falso" };
  Object.defineProperty(ro, "query", { get: () => cached, configurable: true, enumerable: true });
  const before = seen.length;
  await stub(ro, fakeRes());
  ok(seen.length === before + 1 && seen.at(-1)[1].itemId === "xyz", "funciona con req.query de solo lectura");

  console.log(fails === 0 ? "TODO OK" : `${fails} fallas`);
})();
