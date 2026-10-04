#!/usr/bin/env node
// Resume las líneas {"perf":1,...} que escribe el backend (lib/timing.ts): una por request.
// Uso: pega o redirige los logs de Vercel (aceptan prefijos de fecha, etc.):
//   node scripts/perf-summary.mjs < logs.txt
//   cat logs.txt | node scripts/perf-summary.mjs
// Por ruta muestra: peticiones, mediana (p50), p95 y máximo del total, y por paso el tiempo medio por
// petición y cuántas llamadas hace (n). Así se ve qué paso domina antes de optimizar nada.

import { createInterface } from "node:readline";

const pct = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))];
const routes = new Map();

for await (const line of createInterface({ input: process.stdin })) {
  const from = line.indexOf('{"perf":1');
  const to = line.lastIndexOf("}");
  if (from < 0 || to < from) continue;
  let r;
  try { r = JSON.parse(line.slice(from, to + 1)); } catch { continue; }
  if (typeof r.route !== "string" || typeof r.ms !== "number") continue;

  const key = `${r.method} ${r.route}`;
  const agg = routes.get(key) ?? { ms: [], errors: 0, steps: new Map() };
  agg.ms.push(r.ms);
  if (r.status >= 500) agg.errors++;
  for (const [step, t] of Object.entries(r.steps ?? {})) {
    const s = agg.steps.get(step) ?? { ms: 0, n: 0 };
    s.ms += t.ms; s.n += t.n;
    agg.steps.set(step, s);
  }
  routes.set(key, agg);
}

if (routes.size === 0) {
  console.log("No se encontraron líneas de medición ({\"perf\":1,...}). ¿Está PERF_LOG en 0?");
  process.exit(0);
}

const rows = [...routes].sort((a, b) => b[1].ms.length - a[1].ms.length);
for (const [key, agg] of rows) {
  const sorted = [...agg.ms].sort((x, y) => x - y);
  const n = sorted.length;
  console.log(`\n${key}   (${n} peticiones${agg.errors ? `, ${agg.errors} con error 5xx` : ""})`);
  console.log(`  total: p50 ${pct(sorted, 50)} ms · p95 ${pct(sorted, 95)} ms · máx ${sorted[n - 1]} ms`);
  const steps = [...agg.steps].sort((a, b) => b[1].ms - a[1].ms);
  for (const [step, s] of steps) {
    console.log(`  ${step.padEnd(13)} ${(s.ms / n).toFixed(0).padStart(5)} ms/petición · ${(s.n / n).toFixed(1)} llamadas/petición`);
  }
}
console.log("\nNota: cada paso mide hasta recibir la respuesta; los pasos pueden solaparse, así que no tienen que sumar el total.");
