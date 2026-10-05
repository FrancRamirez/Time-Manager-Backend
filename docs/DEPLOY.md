# Despliegue en Vercel: el límite de 12 funciones

**El plan gratuito (Hobby) de Vercel admite como máximo 12 funciones serverless por despliegue**, y cada
archivo de `api/` cuenta como una. Si se pasa, el despliegue **falla y Vercel sigue sirviendo la versión
anterior**, sin avisar en la app: el backend parece "no actualizarse".

## Cómo comprobar si te pasó
1. Vercel > tu proyecto > **Deployments**: ¿el último está en **Error**? El log dice
   *"No more than 12 Serverless Functions can be added to a Deployment on the Hobby plan"*.
2. Prueba rápida (sin sesión): abre `https://TU-PROYECTO.vercel.app/api/settings`.
   - Responde `401` con un JSON (`Falta el token de sesión`) → el despliegue es el actual.
   - Responde `404` → sigue en línea una versión antigua.

## Cómo está resuelto
Los handlers viven en `lib/routes/` (no cuentan) y 4 funciones agrupadas los reparten, con las **mismas
URLs de siempre** (la app no cambia):

| Función | Rutas |
|---|---|
| `api/auth/[...slug].ts` | `/api/auth/google`, `/me`, `/refresh` |
| `api/ai/[...slug].ts` | `/api/ai/chat`, `/usage`, `/diagnose`, `/actions/:actionId/confirm` |
| `api/calendar/[...slug].ts` | `/api/calendar/events[/:eventId]`, `/scan`, `/suggestions[/:eventId]` |
| `api/devices/[...slug].ts` | `/api/devices/register`, `/unregister` |
| `api/billing/confirm-onboarding.ts`, `api/settings.ts`, `api/cron/scan.ts` | una cada una |

Total: **7 funciones** (margen de 5).

## Para actualizar
1. Copia el contenido del zip sobre el repositorio del backend.
2. **Borra los archivos antiguos**: copiar no los elimina y seguirían contando.
   `powershell -ExecutionPolicy Bypass -File scripts/remove-old-functions.ps1`
3. `npm run check:functions` debe mostrar **7 funciones**.
4. `git add -A`, `git commit`, `git push`. En Deployments espera a **Ready** y repite la prueba rápida.

## Regla para el futuro
**No crees archivos nuevos en `api/`.** Escribe el handler en `lib/routes/<grupo>/` y regístralo en
`lib/routes/index.ts`. `npm run check:functions` y `tests/routes-check.ts` fallan si se pasa del límite.
