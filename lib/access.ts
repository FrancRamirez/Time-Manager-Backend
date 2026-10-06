// ---------------------------------------------------------------------------
// Restringir aplicaciones: qué puede tocar el asistente en cada integración
// ---------------------------------------------------------------------------
//
// El usuario elige un nivel por app en Ajustes (la app lo manda en cada request, dentro de
// `settings.appAccess`). Es una restricción del asistente: no revoca permisos de Android ni el
// acceso OAuth de Google. Se hace cumplir en varias capas: las herramientas no permitidas ni
// siquiera se le declaran al modelo, runTool las rechaza igual, y scan / aceptar sugerencias /
// confirmar acciones lo revisan por su cuenta.

export type AccessLevel = "allowed" | "read_only" | "blocked";
export type AppId = "calendar" | "gmail" | "clock" | "whatsapp" | "sms" | "calls" | "forecast" | "maps" | "didi";
export type AppAccess = Record<AppId, AccessLevel>;

export const DEFAULT_APP_ACCESS: AppAccess = {
  calendar: "allowed",
  gmail: "allowed",
  clock: "allowed",
  whatsapp: "allowed",
  sms: "allowed",
  calls: "allowed",
  forecast: "allowed",
  maps: "allowed",
  didi: "allowed",
};

/** Niveles válidos por app: "Solo lectura" existe únicamente donde hay lectura Y escritura. */
export const APP_LEVELS: Record<AppId, AccessLevel[]> = {
  calendar: ["allowed", "read_only", "blocked"],
  gmail: ["allowed", "read_only", "blocked"],
  clock: ["allowed", "read_only", "blocked"],
  whatsapp: ["allowed", "blocked"],
  sms: ["allowed", "blocked"],
  calls: ["allowed", "blocked"],
  forecast: ["allowed", "blocked"],
  maps: ["allowed", "blocked"],
  didi: ["allowed", "blocked"],
};

export const APP_NAMES: Record<AppId, string> = {
  calendar: "Google Calendar",
  gmail: "Gmail",
  clock: "Reloj",
  whatsapp: "WhatsApp",
  sms: "SMS",
  calls: "Llamadas",
  forecast: "Pronóstico",
  maps: "Mapas",
  didi: "DiDi",
};

/** A qué app pertenece cada herramienta y si escribe (crea, cambia, envía o borra). */
const TOOL_APP: Record<string, { app: AppId; write: boolean }> = {
  list_events: { app: "calendar", write: false },
  create_event: { app: "calendar", write: true },
  reschedule_event: { app: "calendar", write: true },
  cancel_event: { app: "calendar", write: true },
  search_emails: { app: "gmail", write: false },
  read_email: { app: "gmail", write: false },
  draft_email: { app: "gmail", write: true },
  send_email: { app: "gmail", write: true },
  modify_email: { app: "gmail", write: true },
  trash_email: { app: "gmail", write: true },
  list_alarms: { app: "clock", write: false },
  set_alarm: { app: "clock", write: true },
  update_alarm: { app: "clock", write: true },
  cancel_alarm: { app: "clock", write: true },
  set_timer: { app: "clock", write: true },
  compose_whatsapp: { app: "whatsapp", write: true },
  compose_sms: { app: "sms", write: true },
  compose_call: { app: "calls", write: true },
  get_forecast: { app: "forecast", write: false },
  search_place: { app: "maps", write: false },
  get_directions: { app: "maps", write: false },
  open_maps_route: { app: "maps", write: true },
  open_didi: { app: "didi", write: true },
};

/** Tipo de acción pendiente (pending_actions.type) -> app que toca. */
const ACTION_APP: Record<string, AppId> = {
  create: "calendar",
  reschedule: "calendar",
  cancel: "calendar",
  email_draft: "gmail",
  email_send: "gmail",
  email_modify: "gmail",
  email_trash: "gmail",
};

export function actionApp(type: string): AppId | null {
  return ACTION_APP[type] ?? null;
}

export function appAllows(access: AppAccess, app: AppId, write: boolean): boolean {
  const level = access[app];
  if (level === "allowed") return true;
  if (level === "read_only") return !write;
  return false;
}

/** Las herramientas que no se conocen (p. ej. futuras) no se bloquean desde acá. */
export function toolAllowed(access: AppAccess, tool: string): boolean {
  const t = TOOL_APP[tool];
  return t ? appAllows(access, t.app, t.write) : true;
}

/** Texto para el modelo o el usuario cuando una herramienta está restringida; null si se puede usar. */
export function toolRestriction(access: AppAccess, tool: string): string | null {
  const t = TOOL_APP[tool];
  if (!t || appAllows(access, t.app, t.write)) return null;
  return restrictionText(t.app, access[t.app]);
}

export function restrictionText(app: AppId, level: AccessLevel): string {
  const name = APP_NAMES[app];
  const state = level === "blocked" ? "bloqueada" : "en modo solo lectura";
  return (
    `${name} está ${state} para el asistente: el usuario lo eligió en Ajustes > Restringir aplicaciones. ` +
    "No hagas esto ni busques rodeos; explícale que puede cambiarlo en esa pantalla."
  );
}

/**
 * Valida lo que llega del cliente. Una app que no viene definida queda "allowed" (comportamiento
 * anterior); un valor que sí viene pero es inválido para esa app se trata como "blocked", porque
 * ante la duda es más seguro restringir que permitir.
 */
export function parseAppAccess(raw: unknown): AppAccess {
  const out: AppAccess = { ...DEFAULT_APP_ACCESS };
  if (typeof raw !== "object" || raw === null) return out;
  const r = raw as Record<string, unknown>;
  for (const app of Object.keys(APP_LEVELS) as AppId[]) {
    const v = r[app];
    if (v === undefined) continue;
    out[app] = APP_LEVELS[app].includes(v as AccessLevel) ? (v as AccessLevel) : "blocked";
  }
  return out;
}

/** Reglas para el prompt del sistema; vacío si no hay nada restringido (no gasta tokens). */
export function restrictionRules(access: AppAccess): string[] {
  const restricted = (Object.keys(APP_LEVELS) as AppId[]).filter((a) => access[a] !== "allowed");
  if (!restricted.length) return [];
  return [
    "Restricciones del usuario sobre las apps (las eligió en Ajustes y el servidor las hace cumplir):",
    ...restricted.map(
      (a) =>
        `- ${APP_NAMES[a]}: ` +
        (access[a] === "blocked"
          ? "BLOQUEADA. No puedes usarla para nada."
          : "SOLO LECTURA. Puedes consultar, pero no crear, cambiar, enviar ni borrar nada.")
    ),
    "- Si el pedido choca con una restricción, dilo con claridad y explica que puede cambiarla en Ajustes > Restringir aplicaciones. No busques rodeos para saltártela (por ejemplo, no uses otra app para hacer lo que una app bloqueada haría) ni insistas.",
  ];
}
