import { route } from "../../lib/http";
import { requireUser } from "../../lib/auth";
import { exec } from "../../lib/db";

/**
 * TODO: esto asume que el pago ya se validó del lado del cliente con el
 * SDK de Google Play Billing. Falta validar server-side el purchase token
 * contra la Play Developer API antes de habilitar la cuenta en un
 * lanzamiento real — así como está, cualquiera con una sesión válida
 * podría llamar este endpoint sin haber pagado.
 */
export default route(["POST"], async (req, res) => {
  const userId = await requireUser(req);

  await exec("UPDATE users SET onboarding_completed = 1 WHERE id = ?", [userId]);

  res.status(200).json({ onboardingCompleted: true });
});
