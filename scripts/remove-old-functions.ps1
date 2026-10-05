# Borra los archivos antiguos de api/ que ahora viven en lib/routes/ (Windows PowerShell).
# Copiar el zip por encima NO los borra, y mientras existan siguen contando como funciones de Vercel.
# Ejecutar desde la carpeta del backend:  powershell -ExecutionPolicy Bypass -File scripts/remove-old-functions.ps1
$old = @(
  "api/auth/google.ts", "api/auth/me.ts", "api/auth/refresh.ts",
  "api/ai/chat.ts", "api/ai/usage.ts", "api/ai/diagnose.ts", "api/ai/actions/[actionId]/confirm.ts",
  "api/calendar/events.ts", "api/calendar/events/[eventId].ts", "api/calendar/scan.ts",
  "api/calendar/suggestions.ts", "api/calendar/suggestions/[eventId].ts",
  "api/devices/register.ts", "api/devices/unregister.ts",
  "lib/chat.ts"   # copia suelta sin uso
)
# -LiteralPath: los corchetes de [actionId] y [eventId] son comodines en PowerShell
foreach ($f in $old) {
  if (Test-Path -LiteralPath $f) { Remove-Item -LiteralPath $f -Force; Write-Host "borrado  $f" }
}
foreach ($d in @("api/ai/actions/[actionId]", "api/ai/actions", "api/calendar/events", "api/calendar/suggestions")) {
  if (Test-Path -LiteralPath $d) { Remove-Item -LiteralPath $d -Recurse -Force -ErrorAction SilentlyContinue }
}
Write-Host ""
npm run check:functions
