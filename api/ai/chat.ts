import { route, bodyOf, HttpError } from "../../lib/http";
import { requireUser } from "../../lib/auth";
import { sendMessageToGemini } from "../../lib/gemini";

export default route(["POST"], async (req, res) => {
  await requireUser(req); // solo para exigir sesión; no guardamos el mensaje

  const body = bodyOf(req);
  if (typeof body.message !== "string" || !body.message.trim()) {
    throw new HttpError(400, "Falta message");
  }

  const result = await sendMessageToGemini(body.message);
  res.status(200).json(result);
});
