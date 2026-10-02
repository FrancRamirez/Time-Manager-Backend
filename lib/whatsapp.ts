// ---------------------------------------------------------------------------
// WhatsApp (por enlaces wa.me / whatsapp://send)
//
// No existe API para leer, enviar ni modificar chats personales. Lo único
// posible sin violar los términos de WhatsApp es PREPARAR un mensaje: la app
// abre WhatsApp con el contacto y el texto ya escritos y el usuario pulsa
// Enviar. El servidor solo valida y arma la acción; nunca envía nada.
// ---------------------------------------------------------------------------

export interface WhatsappBody {
  kind: "whatsapp_send";
  /** Nombre que dijo el usuario; la app lo busca en los contactos del teléfono. */
  contactName?: string;
  /** Solo dígitos, con código de país (sin "+"). Si falta, la app resuelve el contacto. */
  phone?: string;
  message: string;
}

export const MAX_WHATSAPP_CHARS = 1000;
const MAX_NAME = 60;

/**
 * Número en formato internacional -> solo dígitos. Exige "+" o "00" al inicio:
 * sin código de país no se puede saber a qué número corresponde.
 */
export function parseInternationalPhone(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const s = raw.trim();
  let digits: string;
  if (s.startsWith("+")) digits = s.replace(/\D/g, "");
  else if (s.startsWith("00")) digits = s.replace(/\D/g, "").slice(2);
  else return null;
  if (!/^[1-9]\d{7,14}$/.test(digits)) return null;
  return digits;
}

export function cleanContactName(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const s = v.replace(/[\r\n]+/g, " ").trim().slice(0, MAX_NAME);
  return s || undefined;
}

export function cleanWhatsappMessage(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.replace(/\r\n/g, "\n").trim();
  if (!s || s.length > MAX_WHATSAPP_CHARS) return null;
  return s;
}

export function describeWhatsapp(b: WhatsappBody): string {
  const dest = b.contactName
    ? `para ${b.contactName}`
    : b.phone
      ? `para +${b.phone}`
      : "(elegirás el contacto en WhatsApp)";
  return `Abrir WhatsApp con este mensaje ${dest}:\n"${b.message}"\nTú decides si lo envías.`;
}
