import { TOOLS, toolsFor, systemPrompt } from "../lib/gemini";
import { toolAllowed, toolRestriction, parseAppAccess, DEFAULT_APP_ACCESS, restrictionRules, actionApp, appAllows, GENERAL_TOOLS } from "../lib/access";
import { parseSettings, DEFAULT_SETTINGS } from "../lib/schedule";

let fails = 0;
const ok = (c: boolean, m: string) => { if (!c) { fails++; console.log("FALLA:", m); } };
const names = TOOLS.flatMap((g) => g.functionDeclarations).map((d) => d.name);
console.log("herramientas declaradas:", names.length);
// Con TODO permitido deben declararse todas: una herramienta sin mapear quedaría permitida y la restricción no se aplicaría.
ok(names.filter((n) => !GENERAL_TOOLS.includes(n)).every((n) => toolRestriction({ calendar: "blocked", gmail: "blocked", clock: "blocked", whatsapp: "blocked", sms: "blocked", calls: "blocked", forecast: "blocked", maps: "blocked", didi: "blocked" }, n) !== null), "toda herramienta declarada debe estar mapeada a una app");

// 1. Ninguna herramienta declarada puede escaparse del mapa: con todo bloqueado no debe quedar ninguna.
const allBlocked = { calendar: "blocked", gmail: "blocked", clock: "blocked", whatsapp: "blocked", sms: "blocked", calls: "blocked", forecast: "blocked", maps: "blocked", didi: "blocked" } as const;
const left = (toolsFor(allBlocked)?.[0].functionDeclarations ?? []).map((d) => d.name);
// Las herramientas generales (calculadora) no pertenecen a ninguna app: siempre se declaran, aunque todo esté bloqueado.
ok(JSON.stringify(left.filter((n) => !GENERAL_TOOLS.includes(n))) === "[]", `con todo bloqueado quedan herramientas sin mapear: ${left.join(", ")}`);
ok(JSON.stringify([...left].sort()) === JSON.stringify([...GENERAL_TOOLS].sort()), "con todo bloqueado solo quedan las herramientas generales");

// 2. Todo permitido = las 16 de siempre.
ok(toolsFor(DEFAULT_APP_ACCESS)![0].functionDeclarations.length === names.length, "por defecto deben declararse todas");

// 3. Solo lectura: quedan solo las de lectura.
const ro = { calendar: "read_only", gmail: "read_only", clock: "read_only", whatsapp: "allowed", sms: "allowed", calls: "allowed", forecast: "allowed", maps: "allowed", didi: "allowed" } as const;
const roNames = toolsFor(ro)![0].functionDeclarations.map((d) => d.name).sort();
console.log("solo lectura ->", roNames.join(", "));
const expectRO = ["list_events","search_emails","read_email","list_alarms","compose_whatsapp","compose_sms","compose_call","get_forecast","search_place","get_directions","open_maps_route","open_didi", ...GENERAL_TOOLS].sort();
ok(JSON.stringify(roNames) === JSON.stringify(expectRO), "solo lectura debe dejar exactamente las herramientas de lectura (+WhatsApp permitido)");

// 4. Cada nivel por app, de forma aislada.
for (const [app, writes, reads] of [
  ["calendar", ["create_event","reschedule_event","cancel_event"], ["list_events"]],
  ["gmail", ["draft_email","send_email","modify_email","trash_email"], ["search_emails","read_email"]],
  ["clock", ["set_alarm","update_alarm","cancel_alarm","set_timer"], ["list_alarms"]],
] as const) {
  const ro1 = { ...DEFAULT_APP_ACCESS, [app]: "read_only" } as any;
  const bl1 = { ...DEFAULT_APP_ACCESS, [app]: "blocked" } as any;
  writes.forEach((t) => { ok(!toolAllowed(ro1, t), `${t} debe bloquearse en solo lectura`); ok(!toolAllowed(bl1, t), `${t} debe bloquearse`); });
  reads.forEach((t) => { ok(toolAllowed(ro1, t), `${t} debe permitirse en solo lectura`); ok(!toolAllowed(bl1, t), `${t} debe bloquearse`); });
}
ok(!toolAllowed({ ...DEFAULT_APP_ACCESS, whatsapp: "blocked" }, "compose_whatsapp"), "WhatsApp bloqueada");
ok(!toolAllowed({ ...DEFAULT_APP_ACCESS, sms: "blocked" }, "compose_sms") && toolAllowed({ ...DEFAULT_APP_ACCESS, sms: "blocked" }, "compose_call"), "SMS bloqueada no afecta a Llamadas");
ok(!toolAllowed({ ...DEFAULT_APP_ACCESS, calls: "blocked" }, "compose_call") && toolAllowed({ ...DEFAULT_APP_ACCESS, calls: "blocked" }, "compose_sms"), "Llamadas bloqueada no afecta a SMS");
ok(!toolAllowed({ ...DEFAULT_APP_ACCESS, forecast: "blocked" }, "get_forecast"), "Pronóstico bloqueado");
ok(toolAllowed(DEFAULT_APP_ACCESS, "get_forecast"), "Pronóstico permitido por defecto");
ok(parseAppAccess({ forecast: "read_only" }).forecast === "blocked", "forecast no admite solo lectura (inválido = bloqueado)");
for (const t of ["search_place", "get_directions", "open_maps_route"]) {
  ok(toolAllowed(DEFAULT_APP_ACCESS, t), `${t} permitido por defecto`);
  ok(!toolAllowed({ ...DEFAULT_APP_ACCESS, maps: "blocked" }, t), `${t} bloqueado con Maps bloqueado`);
}
ok(toolAllowed({ ...DEFAULT_APP_ACCESS, maps: "blocked" }, "get_forecast") && toolAllowed({ ...DEFAULT_APP_ACCESS, maps: "blocked" }, "compose_call"), "bloquear Maps no afecta a otras apps");
ok(parseAppAccess({ maps: "read_only" }).maps === "blocked", "maps no admite solo lectura (inválido = bloqueado)");
ok(parseAppAccess({}).maps === "allowed", "sin dato de maps = permitido (apps viejas)");
ok(toolAllowed(DEFAULT_APP_ACCESS, "open_didi") && !toolAllowed({ ...DEFAULT_APP_ACCESS, didi: "blocked" }, "open_didi"), "open_didi sigue a DiDi");
ok(toolAllowed({ ...DEFAULT_APP_ACCESS, didi: "blocked" }, "open_maps_route") && toolAllowed({ ...DEFAULT_APP_ACCESS, maps: "blocked" }, "open_didi"), "DiDi y Maps se restringen por separado");
ok(parseAppAccess({ didi: "read_only" }).didi === "blocked" && parseAppAccess({}).didi === "allowed", "didi: solo lectura inválido; ausente = permitido");

// 5. Validación del cliente: ausente = permitido; inválido = bloqueado (más seguro); WhatsApp no admite solo lectura.
ok(parseAppAccess(undefined).calendar === "allowed", "sin appAccess = permitido");
ok(parseAppAccess({ calendar: "hack" }).calendar === "blocked", "valor inválido = bloqueado");
ok(parseAppAccess({ whatsapp: "read_only" }).whatsapp === "blocked", "whatsapp read_only es inválido = bloqueado");
ok(parseAppAccess({ gmail: "read_only" }).gmail === "read_only", "gmail read_only válido");
ok(parseSettings({ appAccess: { gmail: "blocked" } }).appAccess.gmail === "blocked", "parseSettings conserva appAccess");
ok(parseSettings(undefined).appAccess.calendar === "allowed", "parseSettings por defecto");

// 6. Acciones pendientes ya propuestas.
ok(actionApp("email_send") === "gmail" && actionApp("reschedule") === "calendar", "mapa de acciones pendientes");
ok(!appAllows({ ...DEFAULT_APP_ACCESS, gmail: "read_only" }, actionApp("email_send")!, true), "confirmar envío con Gmail solo lectura debe rechazarse");

// 7. Prompt: sin restricciones no gasta tokens; con ellas informa.
ok(restrictionRules(DEFAULT_APP_ACCESS).length === 0, "sin restricciones no agrega reglas");
const p = systemPrompt("America/Argentina/Buenos_Aires", { ...DEFAULT_SETTINGS, appAccess: { ...DEFAULT_APP_ACCESS, gmail: "blocked" } }, false);
ok(p.includes("Gmail: BLOQUEADA"), "el prompt debe informar la restricción");
ok(p.indexOf("Gmail: BLOQUEADA") < p.indexOf("Personalidad"), "las restricciones van antes que la personalidad");
console.log(toolRestriction({ ...DEFAULT_APP_ACCESS, calendar: "read_only" }, "create_event"));
console.log(fails === 0 ? "TODO OK" : `${fails} fallas`);
