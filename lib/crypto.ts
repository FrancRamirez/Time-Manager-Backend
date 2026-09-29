import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { env } from "./http";

// AES-256-GCM. Formato guardado: base64( iv[12] | authTag[16] | ciphertext )

function getKey(): Buffer {
  const hex = env("TOKEN_ENCRYPTION_KEY");
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error("TOKEN_ENCRYPTION_KEY debe ser un hex de 64 caracteres (32 bytes)");
  }
  return Buffer.from(hex, "hex");
}

export function encrypt(plainText: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", getKey(), iv);
  const data = Buffer.concat([cipher.update(plainText, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, data]).toString("base64");
}

export function decrypt(payload: string): string {
  const buf = Buffer.from(payload, "base64");
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const data = buf.subarray(28);
  const decipher = createDecipheriv("aes-256-gcm", getKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
}
