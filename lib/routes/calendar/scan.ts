import { route, bodyOf } from "../../http";
import { requireUser } from "../../auth";
import { parseSettings, safeTimeZone } from "../../schedule";
import { scanUser } from "../../scan";

/**
 * Analiza la agenda del usuario en busca de conflictos y genera sugerencias.
 * La app lo llama al abrir la Agenda y desde la tarea en segundo plano; los
 * ajustes (buffer, franjas, autonomía) viajan en el body, igual que en el chat.
 */
export default route(["POST"], async (req, res) => {
  const userId = await requireUser(req);
  const body = bodyOf(req);

  const result = await scanUser({
    userId,
    tz: safeTimeZone(typeof body.timeZone === "string" ? body.timeZone : undefined),
    settings: parseSettings(body.settings),
  });
  res.status(200).json(result);
});
