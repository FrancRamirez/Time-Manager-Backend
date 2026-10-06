# Mapas: Google Maps y OpenStreetMap (IDEA 1)

Frami tiene tres herramientas de mapas. Pueden usar **Google Maps** (de pago por encima del cupo gratis) u
**OpenStreetMap** (gratis, sin clave): ver "Proveedores" más abajo.

| Herramienta | Qué hace | Usa una API de mapas |
|---|---|---|
| `search_place` | Busca lugares, direcciones, barrios o zonas (hasta 3 resultados con nombre y dirección; con `near_me` también la distancia). | Sí: Places API (New) u OpenStreetMap Nominatim |
| `get_directions` | Distancia y tiempo de viaje (con tráfico solo en Google). Con `arrive_by` calcula a qué hora salir. | Sí: Routes API u OpenStreetMap (OSRM) |
| `open_maps_route` | Abre la app de mapas con la ruta o el destino; el usuario inicia la navegación. | No |

`open_maps_route` funciona aunque no haya clave: es un enlace que abre la app del teléfono.

## Proveedores (`MAPS_PROVIDER`)

| Valor | Comportamiento |
|---|---|
| `auto` (por defecto) | Google Maps si hay `GOOGLE_MAPS_API_KEY`. Si Google falla (cuota, clave, red, error) o no encuentra nada, se intenta con OpenStreetMap. Sin clave, solo OpenStreetMap. |
| `google` | Solo Google Maps (sin clave no hay búsquedas ni tiempos; sí se puede abrir la ruta). |
| `osm` | Solo OpenStreetMap. Además `open_maps_route` abre el selector de apps de mapas de Android (`geo:`) en vez de Google Maps. |

Un "no pude ubicar esa dirección" de Google (HTTP 400/404) **no** se reintenta con OpenStreetMap: se le pide al usuario más detalle.

### Qué ofrece cada uno

| | Google Maps | OpenStreetMap (gratis) |
|---|---|---|
| Clave / costo | Clave y facturación; cupo gratis por SKU | Sin clave, sin costo |
| Buscar lugares y zonas | Muy completo (comercios, horarios) | Bueno para direcciones, barrios, ciudades y lugares conocidos; puede faltar información de comercios |
| Tiempo de viaje | Con tráfico en vivo o previsto | Sin tráfico (tiempo con la vía libre): Frami lo avisa y sugiere un margen |
| Auto, a pie, bicicleta | Sí | Sí (servidores `routed-car`, `routed-foot` y `routed-bike` de routing.openstreetmap.de) |
| Transporte público | Sí | No: Frami lo explica y ofrece abrir la ruta en la app de mapas |
| Qué se envía | Texto de lugares y coordenadas aproximadas (~1 km) | Igual |

### Uso responsable de OpenStreetMap

- Nominatim permite **1 consulta por segundo** y pide identificar la app. El código espacia las consultas (>= 1,1 s)
  dentro de cada instancia y manda un `User-Agent` propio; define `OSM_CONTACT` con un email o web de contacto.
  Una consulta del usuario hace 1 o 2 llamadas (por ejemplo, ruta con origen y destino escritos = 2 búsquedas + 1 ruta,
  unos 2 segundos).
- Los servidores públicos son para uso moderado. Si la app crece, conviene un Nominatim/OSRM propio (`NOMINATIM_URL`)
  o un proveedor comercial.
- **Atribución obligatoria** (licencia ODbL): "© colaboradores de OpenStreetMap". Frami la incluye en la nota de los
  resultados; se recomienda mostrarla también en Ajustes de la app.
- Los destinos, coordenadas y URL no se guardan ni se registran en logs.

## Activar Google Maps (opcional, una sola vez)

1. En Google Cloud Console, en el mismo proyecto de GCP de la app, habilita **Places API (New)** y **Routes API**.
2. Vincula una cuenta de facturación al proyecto (Google la exige para estas dos APIs). Google da un cupo
   gratis mensual por tipo de consulta y cobra solo lo que lo supere.
3. Crea una **clave de API** (APIs y servicios > Credenciales) y restríngela a esas dos APIs. No se puede
   restringir por app Android porque la clave vive en el servidor, no en el teléfono.
4. Fija **cuotas diarias** en la consola (Places API (New) y Routes API) para que un error o un abuso no
   genere un cobro inesperado.
5. En Vercel agrega la variable `GOOGLE_MAPS_API_KEY` (y, si quieres, `MAPS_REGION_CODE=AR`) y vuelve a desplegar.

Para usar solo la opción gratuita no hace falta nada de esto: déjalo sin clave (o `MAPS_PROVIDER=osm`).

## Cómo se usa cada consulta

- Se piden solo los campos necesarios (nombre y dirección; duración, distancia y nombre de la ruta), que
  es lo que mantiene bajo el costo por consulta.
- La ubicación del usuario llega redondeada (~1 km), solo cuando hace falta (por ejemplo "farmacias cerca" o
  "¿cuánto tardo en llegar?"), y no se guarda ni se escribe en los logs. Tampoco los destinos ni las URL.
- Con `arrive_by` en auto se hacen como máximo 2 consultas a Routes (se afina el tráfico previsto a la hora de salida).
- El nivel de acceso "Mapas" (Permitido / Bloqueada) en Ajustes > Restringir aplicaciones corta las tres herramientas, con cualquier proveedor.

## Pruebas

`npx tsx tests/maps-check.ts` (Google) y `npx tsx tests/osm-check.ts` (OpenStreetMap y selector de proveedor). Usan respuestas simuladas: no consumen cuota ni usan red.
