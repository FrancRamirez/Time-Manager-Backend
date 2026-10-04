# Barrido de agenda con la app cerrada (IDEA 4A)

El servidor analiza la agenda y avisa por push (FCM) aunque la app esté cerrada. Todo gratuito.

## 1. Variables nuevas en Vercel
| Variable | Qué es |
|---|---|
| `FIREBASE_SERVICE_ACCOUNT` | JSON de una cuenta de servicio de Firebase (Consola de Firebase > Configuración del proyecto > Cuentas de servicio > Generar nueva clave privada). Pega el JSON completo o su versión en base64. |
| `CRON_SECRET` | Una clave larga al azar (mínimo 16 caracteres): `openssl rand -hex 32`. |

Sin `FIREBASE_SERVICE_ACCOUNT` el barrido **no analiza nada** a propósito: así la tarea del teléfono sigue
avisando como hasta ahora y ninguna sugerencia queda sin notificar.

## 2. Base de datos
Ejecuta en TiDB el bloque `user_settings` del final de `schema.sql`.

## 3. Quién llama al endpoint (elige uno)
- **GitHub Actions**: ya está en `.github/workflows/scan.yml`. Crea los secretos `SCAN_URL` y `CRON_SECRET`.
  Puede retrasarse y se desactiva tras 60 días sin actividad en repositorios públicos.
- **cron-job.org** (cuenta gratuita): URL `https://TU-PROYECTO.vercel.app/api/cron/scan`, cada 10-15 min,
  método POST, cabecera `Authorization: Bearer <CRON_SECRET>`.

## 4. Comprobar
`curl -X POST -H "Authorization: Bearer $CRON_SECRET" https://TU-PROYECTO.vercel.app/api/cron/scan`
devuelve un resumen: `fcmConfigured`, `selected`, `scanned`, `pushesSent`, `needsLogin`, `errors`...
