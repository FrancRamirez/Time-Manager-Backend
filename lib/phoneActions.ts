// ---------------------------------------------------------------------------
// SMS y llamadas "por intents" (redactar / abrir; sin permisos restringidos)
//
// El servidor solo valida y arma la acción; nunca envía ni llama. La app abre la app de mensajes con
// el número y el texto precargados, o el marcador con el número escrito, y es el usuario quien pulsa
// Enviar o Llamar. A diferencia de WhatsApp, aquí se aceptan números en formato local (no hace falta
// el código de país): son los que usa el teléfono para SMS y llamadas.
// ---------------------------------------------------------------------------

import { cleanContactName } from "./whatsapp";

export interface SmsBody {
  kind: "sms_send";
  /** Nombre que dijo el usuario; la app lo busca en los contactos del teléfono. */
  contactName?: string;
  /** Número ya validado (solo dígitos, con "+" inicial opcional). */
  phone?: string;
  message: string;
}

export interface CallBody {
  kind: "call_dial";
  contactName?: string;
  phone?: string;
}

/** Un SMS más largo se parte en varios; este tope evita mensajes de pantalla completa. */
export const MAX_SMS_CHARS = 640;

/**
 * Número para SMS o llamada. Acepta formato local o internacional con separadores (espacios,
 * guiones, puntos, paréntesis) y devuelve solo dígitos con "+" inicial si lo tenía.
 * Rechaza letras y también "*" y "#": con ellos se podrían armar códigos USSD/MMI del operador.
 */
export function parseDialablePhone(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const s = raw.trim();
  if (!/^\+?[\d\s().-]+$/.test(s)) return null;
  const digits = s.replace(/\D/g, "");
  if (digits.length < 3 || digits.length > 15) return null;
  return (s.startsWith("+") ? "+" : "") + digits;
}

export function cleanSmsMessage(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.replace(/\r\n/g, "\n").trim();
  if (!s || s.length > MAX_SMS_CHARS) return null;
  return s;
}

export { cleanContactName };

export function describeSms(b: SmsBody): string {
  const dest = b.contactName
    ? `para ${b.contactName}${b.phone ? ` (${b.phone})` : ""}`
    : b.phone
      ? `para ${b.phone}`
      : "(elegirás el contacto en tu app de mensajes)";
  return `Abrir tu app de mensajes con este SMS ${dest}:\n"${b.message}"\nTú decides si lo envías.`;
}

export function describeCall(b: CallBody): string {
  const dest = b.contactName
    ? `${b.contactName}${b.phone ? ` (${b.phone})` : ""}`
    : (b.phone ?? "");
  return `Abrir el marcador con el número de ${dest}. Tú pulsas Llamar: no se llama solo.`;
}
