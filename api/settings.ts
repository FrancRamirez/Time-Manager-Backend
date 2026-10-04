import { route, bodyOf } from "../lib/http";
import { requireUser } from "../lib/auth";
import { loadUserSettings, saveUserSettings } from "../lib/userSettings";

/**
 * Copia de los ajustes del asistente en el servidor. El teléfono sigue siendo la fuente de verdad:
 * la app envía los ajustes cada vez que cambian (PUT) para que el servidor pueda actuar con la app
 * cerrada. Las peticiones interactivas (chat, confirmar acciones) siguen usando los ajustes que
 * viajan en cada request.
 */
export default route(["GET", "PUT"], async (req, res) => {
  const userId = await requireUser(req);

  if (req.method === "GET") {
    const saved = await loadUserSettings(userId);
    res.status(200).json(saved ?? { settings: null, timeZone: null });
    return;
  }

  const body = bodyOf(req);
  const saved = await saveUserSettings(userId, body.settings, body.timeZone);
  res.status(200).json({ ok: true, ...saved });
});
