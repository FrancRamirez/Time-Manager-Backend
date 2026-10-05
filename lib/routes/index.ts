// Tablas de rutas de cada grupo. Las usan las funciones de api/ y las pruebas.
import type { RouteHandler } from "../dispatch";
import google from "./auth/google";
import me from "./auth/me";
import refresh from "./auth/refresh";
import chat from "./ai/chat";
import usage from "./ai/usage";
import diagnose from "./ai/diagnose";
import confirm from "./ai/confirm";
import events from "./calendar/events";
import event from "./calendar/event";
import scan from "./calendar/scan";
import suggestions from "./calendar/suggestions";
import suggestion from "./calendar/suggestion";
import register from "./devices/register";
import unregister from "./devices/unregister";

export const authRoutes: Record<string, RouteHandler> = { google, me, refresh };

export const aiRoutes: Record<string, RouteHandler> = {
  chat,
  usage,
  diagnose,
  // Ruta de 2 segmentos (como /chat y /usage, que sabemos que llegan a la función): la app la usa y
  // manda el id en el cuerpo. La de 3 segmentos se conserva por compatibilidad con apps ya instaladas.
  confirm,
  "actions/:actionId/confirm": confirm,
};

export const calendarRoutes: Record<string, RouteHandler> = {
  events,
  "events/:eventId": event,
  scan,
  suggestions,
  "suggestions/:eventId": suggestion,
};

export const devicesRoutes: Record<string, RouteHandler> = { register, unregister };
