import { createHash, timingSafeEqual } from "node:crypto";
import { route, HttpError } from "../../lib/http";
import { runSweep } from "../../lib/sweep";

function sameSecret(given: string, expected: string): boolean {
  // Se comparan hashes para que la longitud no se filtre y la comparación sea de tiempo constante.
  const a = createHash("sha256").update(given).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

/**
 * Barrido de la agenda de todos los usuarios con la app cerrada (análisis + push por FCM).
 * Lo llama un planificador externo cada 10-15 min con "Authorization: Bearer <CRON_SECRET>".
 * Sin CRON_SECRET configurada el endpoint queda cerrado (nunca abierto por omisión).
 */
export default route(["GET", "POST"], async (req, res) => {
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret || secret.length < 16) {
    throw new HttpError(503, "El barrido no está configurado (falta CRON_SECRET, mínimo 16 caracteres)");
  }
  const header = req.headers.authorization ?? "";
  if (!header.startsWith("Bearer ") || !sameSecret(header.slice(7), secret)) {
    throw new HttpError(401, "No autorizado");
  }

  const summary = await runSweep();
  res.status(200).json(summary);
});
