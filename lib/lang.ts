// ---------------------------------------------------------------------------
// Idioma de la solicitud (Español / Inglés)
// ---------------------------------------------------------------------------
//
// La app manda su idioma en el encabezado X-App-Language (y dentro de los ajustes: settings.language, que el servidor
// guarda para los avisos con la app cerrada). `route()` lo lee y deja el idioma disponible para TODO lo que se ejecute
// durante esa solicitud: así los textos que arma el servidor (confirmaciones, avisos, pronóstico) usan `tr(es, en)`
// sin pasar el idioma por cada función. Sin idioma (versiones viejas de la app, pruebas) se usa Español.

import { AsyncLocalStorage } from "node:async_hooks";

export type Lang = "es" | "en";

const storage = new AsyncLocalStorage<{ lang: Lang }>();

/** "en", "en-US", "EN" -> "en"; cualquier otra cosa o nada -> "es". */
export function parseLang(value: unknown): Lang {
  return typeof value === "string" && /^en(?:[-_]|$)/i.test(value.trim()) ? "en" : "es";
}

export function runWithLang<T>(lang: Lang, fn: () => T): T {
  return storage.run({ lang }, fn);
}

export function currentLang(): Lang {
  return storage.getStore()?.lang ?? "es";
}

/** El texto en el idioma de la solicitud en curso. */
export function tr(es: string, en: string): string {
  return currentLang() === "en" ? en : es;
}

/** Nombre del idioma para el prompt del modelo. */
export function langName(lang: Lang = currentLang()): string {
  return lang === "en" ? "English" : "español";
}
