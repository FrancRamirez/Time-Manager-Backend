import { HttpError } from "./http";
import { utcMsToLocal } from "./schedule";

// ---------------------------------------------------------------------------
// Gmail API (REST). Permiso necesario: gmail.modify (leer, redactar, enviar,
// archivar, etiquetar y mover a la papelera; no borra definitivamente).
//
// Nada de lo que se lee se guarda: se devuelve al modelo y se descarta.
// El contenido de los correos es texto NO confiable (lo escribe un tercero).
// ---------------------------------------------------------------------------

const BASE = "https://gmail.googleapis.com/gmail/v1/users/me";
const TIMEOUT_MS = 15_000;

export const MAX_SEARCH_RESULTS = 10;
export const MAX_BODY_CHARS = 3000; // lo que ve el modelo de un correo (cuida los tokens)
export const MAX_OUTGOING_BODY = 10_000;
export const MAX_SUBJECT = 200;
export const MAX_RECIPIENTS = 10;

// ---------------------------------------------------------------------------
// Llamadas HTTP
// ---------------------------------------------------------------------------

function mapError(status: number, detail: string): HttpError {
  if (status === 403 && /insufficientPermissions|ACCESS_TOKEN_SCOPE_INSUFFICIENT/i.test(detail)) {
    return new HttpError(
      403,
      "Falta el permiso de Gmail. Cierra sesión en la app y vuelve a entrar aceptando todos los permisos."
    );
  }
  if (status === 403 && /accessNotConfigured|SERVICE_DISABLED|has not been used/i.test(detail)) {
    return new HttpError(502, "La API de Gmail no está habilitada en el proyecto de Google Cloud.");
  }
  if (status === 401) {
    return new HttpError(502, "Gmail rechazó la sesión. Cierra sesión y vuelve a entrar.");
  }
  if (status === 404) return new HttpError(404, "No se encontró ese correo (puede haberse borrado).");
  if (status === 429 || (status === 403 && /rateLimit/i.test(detail))) {
    return new HttpError(429, "Gmail está limitando las peticiones. Intenta de nuevo en un momento.");
  }
  return new HttpError(502, "No se pudo completar la operación en Gmail");
}

async function gmail<T>(
  token: string,
  op: string,
  path: string,
  init: { method?: string; body?: unknown } = {}
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, {
      method: init.method ?? "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        ...(init.body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    console.error(`Gmail ${op} sin respuesta:`, (err as Error).message);
    throw new HttpError(502, "No se pudo conectar con Gmail");
  }
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    // El error de Google no incluye el contenido de los correos.
    console.error(`Gmail ${op} falló:`, res.status, detail.slice(0, 500));
    throw mapError(res.status, detail);
  }
  return (res.status === 204 ? null : await res.json()) as T;
}

// ---------------------------------------------------------------------------
// Tipos de Gmail y utilidades de texto
// ---------------------------------------------------------------------------

interface GPart {
  mimeType?: string;
  filename?: string;
  headers?: { name: string; value: string }[];
  body?: { data?: string; size?: number };
  parts?: GPart[];
}

interface GMessage {
  id: string;
  threadId: string;
  labelIds?: string[];
  snippet?: string;
  internalDate?: string;
  payload?: GPart;
}

export function isMessageId(v: unknown): v is string {
  return typeof v === "string" && /^[A-Za-z0-9_-]{6,64}$/.test(v);
}

function header(part: GPart | undefined, name: string): string {
  const h = part?.headers?.find((x) => x.name.toLowerCase() === name.toLowerCase());
  return h?.value ?? "";
}

export function clip(s: string, max: number): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const code = e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

function htmlToText(html: string): string {
  return decodeEntities(
    html
      .replace(/<(style|script|head)[\s\S]*?<\/\1>/gi, " ")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(p|div|tr|li|h[1-6]|table)>/gi, "\n")
      .replace(/<[^>]+>/g, " ")
  );
}

function decodeBody(part: GPart): string {
  const data = part.body?.data;
  if (!data) return "";
  const bytes = Buffer.from(data, "base64url");
  const charset = /charset="?([\w-]+)"?/i.exec(header(part, "Content-Type"))?.[1] ?? "utf-8";
  try {
    return new TextDecoder(charset).decode(bytes);
  } catch {
    return bytes.toString("utf8");
  }
}

function collect(part: GPart, plain: string[], html: string[], files: string[]) {
  if (part.filename) {
    files.push(part.filename.slice(0, 120));
    return; // los adjuntos no se leen
  }
  if (part.mimeType === "text/plain") plain.push(decodeBody(part));
  else if (part.mimeType === "text/html") html.push(decodeBody(part));
  for (const p of part.parts ?? []) collect(p, plain, html, files);
}

function cleanBody(text: string): { text: string; truncated: boolean } {
  const lines = text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .filter((l) => !/^\s*>/.test(l)) // citas de respuestas anteriores
    .map((l) => l.replace(/[ \t]+/g, " ").trimEnd());
  const joined = lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  return joined.length > MAX_BODY_CHARS
    ? { text: joined.slice(0, MAX_BODY_CHARS), truncated: true }
    : { text: joined, truncated: false };
}

// ---------------------------------------------------------------------------
// Direcciones
// ---------------------------------------------------------------------------

const EMAIL_RE =
  /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+$/;

/** "Ana <ana@x.com>" o "ana@x.com" -> "ana@x.com"; null si no es una dirección válida. */
export function parseAddress(raw: string): string | null {
  const angle = /<([^<>\s]+)>/.exec(raw);
  const candidate = (angle ? angle[1] : raw).trim();
  return candidate.length <= 254 && EMAIL_RE.test(candidate) ? candidate : null;
}

/** Acepta un arreglo de direcciones o un texto separado por comas / punto y coma. */
export function parseRecipients(raw: unknown): { emails: string[]; invalid: string[] } {
  const items: string[] = Array.isArray(raw)
    ? raw.filter((x): x is string => typeof x === "string")
    : typeof raw === "string"
      ? raw.split(/[;,]/)
      : [];
  const emails: string[] = [];
  const invalid: string[] = [];
  for (const item of items) {
    if (!item.trim()) continue;
    const email = parseAddress(item);
    if (!email) invalid.push(item.trim().slice(0, 80));
    else if (!emails.some((e) => e.toLowerCase() === email.toLowerCase())) emails.push(email);
  }
  return { emails, invalid };
}

// ---------------------------------------------------------------------------
// Leer
// ---------------------------------------------------------------------------

export interface EmailSummary {
  id: string;
  threadId: string;
  from: string;
  subject: string;
  receivedLocal: string;
  snippet: string;
  unread: boolean;
}

function summarize(m: GMessage, tz: string): EmailSummary {
  const ms = Number(m.internalDate);
  return {
    id: m.id,
    threadId: m.threadId,
    from: clip(header(m.payload, "From"), 80),
    subject: clip(decodeEntities(header(m.payload, "Subject")), 120) || "(sin asunto)",
    receivedLocal: Number.isFinite(ms) ? utcMsToLocal(ms, tz) : "",
    snippet: clip(decodeEntities(m.snippet ?? ""), 140),
    unread: m.labelIds?.includes("UNREAD") ?? false,
  };
}

const META_HEADERS = ["From", "Subject", "Date"]
  .map((h) => `metadataHeaders=${h}`)
  .join("&");

export async function searchEmails(
  token: string,
  q: string,
  max: number,
  tz: string
): Promise<EmailSummary[]> {
  const n = Math.min(MAX_SEARCH_RESULTS, Math.max(1, Math.floor(max)));
  const list = await gmail<{ messages?: { id: string }[] }>(
    token,
    "search",
    `/messages?${new URLSearchParams({ q, maxResults: String(n) }).toString()}`
  );
  const ids = (list.messages ?? []).map((m) => m.id);
  const metas = await Promise.all(
    ids.map((id) =>
      gmail<GMessage>(token, "metadata", `/messages/${id}?format=metadata&${META_HEADERS}`)
    )
  );
  return metas.map((m) => summarize(m, tz));
}

export interface EmailFull extends EmailSummary {
  to: string;
  cc: string;
  body: string;
  truncated: boolean;
  attachments: string[];
}

export async function getEmail(token: string, id: string, tz: string): Promise<EmailFull> {
  const m = await gmail<GMessage>(token, "read", `/messages/${id}?format=full`);
  const plain: string[] = [];
  const html: string[] = [];
  const attachments: string[] = [];
  if (m.payload) collect(m.payload, plain, html, attachments);
  const raw = plain.join("\n").trim() || htmlToText(html.join("\n"));
  const { text, truncated } = cleanBody(raw);
  return {
    ...summarize(m, tz),
    to: clip(header(m.payload, "To"), 200),
    cc: clip(header(m.payload, "Cc"), 200),
    body: text,
    truncated,
    attachments: attachments.slice(0, 10),
  };
}

export interface EmailMeta {
  id: string;
  threadId: string;
  from: string;
  replyTo: string;
  subject: string;
  messageId: string;
  references: string;
}

/** Encabezados mínimos para responder, archivar o describir un correo. */
export async function getEmailMeta(token: string, id: string): Promise<EmailMeta> {
  const hs = ["From", "Reply-To", "Subject", "Message-ID", "References"]
    .map((h) => `metadataHeaders=${h}`)
    .join("&");
  const m = await gmail<GMessage>(token, "meta", `/messages/${id}?format=metadata&${hs}`);
  return {
    id: m.id,
    threadId: m.threadId,
    from: header(m.payload, "From"),
    replyTo: header(m.payload, "Reply-To"),
    subject: decodeEntities(header(m.payload, "Subject")),
    messageId: header(m.payload, "Message-ID"),
    references: header(m.payload, "References"),
  };
}

// ---------------------------------------------------------------------------
// Redactar / enviar
// ---------------------------------------------------------------------------

export interface OutgoingEmail {
  to: string[];
  cc: string[];
  subject: string;
  body: string;
  threadId?: string;
  inReplyTo?: string;
  references?: string;
}

const noBreaks = (s: string) => s.replace(/[\r\n\0]+/g, " ").trim();

/** Solo deja identificadores del tipo <algo@dominio>: vienen de un correo ajeno. */
export function cleanMessageIds(s: string): string {
  return (s.match(/<[^<>\s]+>/g) ?? []).slice(-10).join(" ");
}

function encodeSubject(subject: string): string {
  const s = noBreaks(subject);
  if (/^[\x20-\x7E]*$/.test(s)) return s;
  const words: string[] = [];
  let chunk = "";
  for (const ch of Array.from(s)) {
    if (Buffer.byteLength(chunk + ch, "utf8") > 42) {
      words.push(chunk);
      chunk = "";
    }
    chunk += ch;
  }
  if (chunk) words.push(chunk);
  return words
    .map((w) => `=?UTF-8?B?${Buffer.from(w, "utf8").toString("base64")}?=`)
    .join("\r\n ");
}

/** Arma el mensaje RFC 2822 en base64url, listo para drafts.create / messages.send. */
export function buildRaw(mail: OutgoingEmail): string {
  const lines = [
    `To: ${mail.to.map(noBreaks).join(", ")}`,
    ...(mail.cc.length ? [`Cc: ${mail.cc.map(noBreaks).join(", ")}`] : []),
    `Subject: ${encodeSubject(mail.subject)}`,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
  ];
  const inReplyTo = mail.inReplyTo ? cleanMessageIds(mail.inReplyTo) : "";
  const references = mail.references ? cleanMessageIds(mail.references) : "";
  if (inReplyTo) lines.push(`In-Reply-To: ${inReplyTo}`);
  if (references) lines.push(`References: ${references}`);

  const body = Buffer.from(mail.body.replace(/\r?\n/g, "\r\n"), "utf8").toString("base64");
  const wrapped = (body.match(/.{1,76}/g) ?? []).join("\r\n");
  return Buffer.from(`${lines.join("\r\n")}\r\n\r\n${wrapped}`, "utf8").toString("base64url");
}

export async function createDraft(token: string, mail: OutgoingEmail): Promise<void> {
  await gmail(token, "draft", "/drafts", {
    method: "POST",
    body: { message: { raw: buildRaw(mail), ...(mail.threadId ? { threadId: mail.threadId } : {}) } },
  });
}

export async function sendEmail(token: string, mail: OutgoingEmail): Promise<void> {
  await gmail(token, "send", "/messages/send", {
    method: "POST",
    body: { raw: buildRaw(mail), ...(mail.threadId ? { threadId: mail.threadId } : {}) },
  });
}

// ---------------------------------------------------------------------------
// Organizar
// ---------------------------------------------------------------------------

export const MODIFY_ACTIONS = {
  archive: { label: "Archivar", add: [], remove: ["INBOX"] },
  mark_read: { label: "Marcar como leído", add: [], remove: ["UNREAD"] },
  mark_unread: { label: "Marcar como no leído", add: ["UNREAD"], remove: [] },
  star: { label: "Destacar con estrella", add: ["STARRED"], remove: [] },
  unstar: { label: "Quitar la estrella de", add: [], remove: ["STARRED"] },
} as const satisfies Record<string, { label: string; add: readonly string[]; remove: readonly string[] }>;

export type ModifyAction = keyof typeof MODIFY_ACTIONS;

export async function modifyLabels(
  token: string,
  id: string,
  add: string[],
  remove: string[]
): Promise<void> {
  await gmail(token, "modify", `/messages/${id}/modify`, {
    method: "POST",
    body: { addLabelIds: add, removeLabelIds: remove },
  });
}

/** Mueve a la papelera (Gmail la vacía a los 30 días). No borra definitivamente. */
export async function trashEmail(token: string, id: string): Promise<void> {
  await gmail(token, "trash", `/messages/${id}/trash`, { method: "POST" });
}
