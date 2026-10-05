#!/usr/bin/env node
// Cuenta las funciones serverless de api/ y falla si se pasa del límite del plan gratuito de Vercel (12).
// Cada archivo .ts/.js de api/ es una función (salvo los que empiezan con "_"). Uso: npm run check:functions
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const LIMIT = 12;
const files = [];
(function walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) { if (!name.startsWith("_")) walk(p); continue; }
    if (/\.(ts|js|mjs|cjs)$/.test(name) && !name.startsWith("_")) files.push(p);
  }
})("api");

files.sort().forEach((f) => console.log("  " + f));
console.log(`\n${files.length} funciones (límite del plan gratuito: ${LIMIT})`);
if (files.length > LIMIT) {
  console.error(`\nERROR: Vercel rechazará el despliegue y seguirá sirviendo la versión anterior.`);
  process.exit(1);
}
if (files.length > LIMIT - 2) console.warn("Aviso: queda muy poco margen; agrupa endpoints en lib/routes antes de añadir más.");
