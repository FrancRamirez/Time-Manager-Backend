import { route, bodyOf, HttpError } from "../../lib/http";
import { requireUser } from "../../lib/auth";
import { exec, query } from "../../lib/db";
import { billingEnabled, computeAccess } from "../../lib/billing";
import { verifyOnboardingPurchase, verifySubscription, validPurchaseToken } from "../../lib/playBilling";
import { toApiUser, type UserRow } from "../../lib/users";

/**
 * Activación de la cuenta. Ya NO confía en el cliente: la compra se verifica contra Google Play.
 *
 * Cuerpo: { type: "onboarding" | "subscription" | "sync", purchaseToken? }
 *   - onboarding: pago único de activación.
 *   - subscription: suscripción mensual.
 *   - sync: vuelve a consultar la suscripción guardada (renovación) o solo devuelve el estado actual.
 * Siempre responde con el usuario (incluye access / onboardingCompleted), que la app mezcla con el suyo.
 *
 * Con BILLING_ENABLED apagado no cambia nada: devuelve el estado (acceso abierto).
 */
export default route(["POST"], async (req, res) => {
  const userId = await requireUser(req);
  const body = bodyOf(req);

  const load = async () => {
    const rows = await query<UserRow>("SELECT * FROM users WHERE id = ?", [userId]);
    if (!rows[0]) throw new HttpError(401, "Sesión no válida", { code: "session_expired" });
    return rows[0];
  };

  if (!billingEnabled()) {
    res.status(200).json(toApiUser(await load()));
    return;
  }

  const type = body.type === "subscription" || body.type === "sync" ? body.type : "onboarding";
  const row = await load();
  const stored = (row as UserRow & { play_subscription_token?: string | null }).play_subscription_token ?? null;

  if (type === "sync") {
    // Renovación: se vuelve a preguntar a Google por la suscripción guardada. Sin ella, solo se informa el estado.
    if (stored && computeAccess(row).access === "payment_required") {
      const v = await verifySubscription(stored);
      if (v.ok) {
        await exec("UPDATE users SET subscription_active = 1, subscription_expires_at = ? WHERE id = ?", [new Date(v.expiresAtMs), userId]);
      } else {
        await exec("UPDATE users SET subscription_active = 0 WHERE id = ?", [userId]);
      }
    }
    res.status(200).json(toApiUser(await load()));
    return;
  }

  const token = body.purchaseToken;
  if (!validPurchaseToken(token)) throw new HttpError(400, "Falta la compra a verificar", { code: "invalid_purchase" });

  // Una compra pertenece a una sola cuenta: el mismo token no puede activar a otro usuario.
  const column = type === "subscription" ? "play_subscription_token" : "play_onboarding_token";
  const used = await query<{ id: string }>(`SELECT id FROM users WHERE ${column} = ? AND id <> ? LIMIT 1`, [token, userId]);
  if (used.length) throw new HttpError(409, "Esa compra ya está asociada a otra cuenta.", { code: "purchase_in_use" });

  if (type === "subscription") {
    const v = await verifySubscription(token);
    if (!v.ok) throw new HttpError(402, v.reason, { code: "payment_not_verified" });
    await exec(
      "UPDATE users SET subscription_active = 1, subscription_expires_at = ?, play_subscription_token = ? WHERE id = ?",
      [new Date(v.expiresAtMs), token, userId]
    );
  } else {
    const v = await verifyOnboardingPurchase(token);
    if (!v.ok) throw new HttpError(402, v.reason, { code: "payment_not_verified" });
    await exec("UPDATE users SET onboarding_completed = 1, play_onboarding_token = ? WHERE id = ?", [token, userId]);
  }

  res.status(200).json(toApiUser(await load()));
});
