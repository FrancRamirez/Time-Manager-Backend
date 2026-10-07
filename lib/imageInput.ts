// ---------------------------------------------------------------------------
// Imagen adjunta al chat (lectura de imágenes con Gemini multimodal)
// ---------------------------------------------------------------------------
//
// La app reduce la foto (lado máximo ~1280 px, JPEG) y la manda en base64 dentro del JSON del chat.
// El servidor NO la guarda: viaja a Gemini en esa misma solicitud y se descarta (igual que el texto).
//
// Límites: Vercel rechaza cuerpos de más de 4,5 MB, así que el tope de acá queda bien por debajo.
// Se valida lo que llega del cliente porque nada de lo que manda la app es de confianza:
// tipo declarado, base64 bien formado y firma real del archivo (que coincida con el tipo).

import { HttpError } from "./http";

export type ImageMime = "image/jpeg" | "image/png" | "image/webp";

export interface ChatImage {
  mimeType: ImageMime;
  /** Base64 puro (sin el prefijo "data:...;base64,"). */
  data: string;
}

/** Tope de caracteres base64 (~1,9 MB de imagen). La app manda mucho menos (cientos de KB). */
export const MAX_IMAGE_BASE64_CHARS = 2_500_000;

/** Qué se le pide al modelo cuando el usuario manda la imagen sin escribir nada. */
export const IMAGE_ONLY_REQUEST =
  "Mira esta imagen y cuéntame, en pocas líneas, qué contiene. Si trae fechas, horarios, lugares o eventos, " +
  "resúmelos y pregúntame si quiero agendarlos.";

const MIMES: ReadonlySet<string> = new Set(["image/jpeg", "image/png", "image/webp"]);
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

/** ¿Los primeros bytes del archivo corresponden al tipo declarado? */
function signatureMatches(mime: ImageMime, head: Buffer): boolean {
  switch (mime) {
    case "image/jpeg":
      return head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff;
    case "image/png":
      return (
        head.length >= 8 &&
        head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
      );
    case "image/webp":
      return (
        head.length >= 12 &&
        head.subarray(0, 4).toString("latin1") === "RIFF" &&
        head.subarray(8, 12).toString("latin1") === "WEBP"
      );
  }
}

/**
 * Valida el campo `image` del cuerpo del chat.
 * Devuelve null si no vino imagen; lanza HttpError 400/413 (con mensaje en español) si vino mal.
 */
export function parseImage(raw: unknown): ChatImage | null {
  if (raw === undefined || raw === null) return null;
  const bad = () => new HttpError(400, "La imagen adjunta no es válida. Prueba con otra.", { code: "image_invalid" });

  if (typeof raw !== "object" || Array.isArray(raw)) throw bad();
  const { mimeType, data } = raw as Record<string, unknown>;
  if (typeof mimeType !== "string" || !MIMES.has(mimeType)) throw bad();
  if (typeof data !== "string" || data.length === 0) throw bad();

  // Se mide ANTES de tocar el texto: un cuerpo enorme no debe gastar CPU en limpiarlo.
  if (data.length > MAX_IMAGE_BASE64_CHARS * 1.1) {
    throw new HttpError(413, "La imagen es demasiado pesada. Prueba con otra o más chica.", { code: "image_too_large" });
  }
  const clean = data.replace(/\s+/g, "");
  if (clean.length > MAX_IMAGE_BASE64_CHARS) {
    throw new HttpError(413, "La imagen es demasiado pesada. Prueba con otra o más chica.", { code: "image_too_large" });
  }
  if (clean.length % 4 !== 0 || !BASE64.test(clean)) throw bad();

  const head = Buffer.from(clean.slice(0, 24), "base64");
  if (!signatureMatches(mimeType as ImageMime, head)) throw bad();

  return { mimeType: mimeType as ImageMime, data: clean };
}
