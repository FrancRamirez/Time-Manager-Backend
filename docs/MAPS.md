# Google Maps (IDEA 1)

Frami tiene tres herramientas de mapas:

| Herramienta | Qué hace | Usa la API de Google |
|---|---|---|
| `search_place` | Busca lugares o direcciones (hasta 3 resultados con nombre y dirección). | Sí: Places API (New) |
| `get_directions` | Distancia, tiempo de viaje y tráfico. Con `arrive_by` calcula a qué hora salir. | Sí: Routes API |
| `open_maps_route` | Abre la app Google Maps con la ruta lista; el usuario inicia la navegación. | No |

`open_maps_route` funciona aunque no haya clave: es un enlace que abre la app del teléfono.

## Activarlo (una sola vez)

1. En Google Cloud Console, en el mismo proyecto de GCP de la app, habilita **Places API (New)** y **Routes API**.
2. Vincula una cuenta de facturación al proyecto (Google la exige para estas dos APIs). Google da un cupo
   gratis mensual por tipo de consulta y cobra solo lo que lo supere.
3. Crea una **clave de API** (APIs y servicios > Credenciales) y restríngela a esas dos APIs. No se puede
   restringir por app Android porque la clave vive en el servidor, no en el teléfono.
4. Fija **cuotas diarias** en la consola (Places API (New) y Routes API) para que un error o un abuso no
   genere un cobro inesperado.
5. En Vercel agrega la variable `GOOGLE_MAPS_API_KEY` (y, si quieres, `MAPS_REGION_CODE=AR`) y vuelve a desplegar.

## Cómo se usa cada consulta

- Se piden solo los campos necesarios (nombre y dirección; duración, distancia y nombre de la ruta), que
  es lo que mantiene bajo el costo por consulta.
- La ubicación del usuario llega redondeada (~1 km), solo cuando hace falta (por ejemplo "farmacias cerca" o
  "¿cuánto tardo en llegar?"), y no se guarda ni se escribe en los logs. Tampoco los destinos ni las URL.
- Con `arrive_by` en auto se hacen como máximo 2 consultas a Routes (se afina el tráfico previsto a la hora de salida).
- El nivel de acceso "Google Maps" (Permitido / Bloqueada) en Ajustes > Restringir aplicaciones corta las tres herramientas.

## Pruebas

`npx tsx tests/maps-check.ts` (usa respuestas simuladas, no consume cuota).
