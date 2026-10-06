# Medir y optimizar (IDEA 4C)

Regla: **primero medir, después optimizar**. El backend ya registra cuánto tarda cada request en cada
paso; con unos días de uso real se ve dónde está el tiempo.

## 1. Qué se registra
Al terminar cada request se escribe **una línea JSON** en los logs de Vercel:

```
{"perf":1,"route":"/api/ai/chat","method":"POST","status":200,"ms":4200,
 "steps":{"gemini":{"n":2,"ms":3600},"db":{"n":4,"ms":380},"calendar":{"n":1,"ms":210}}}
```
`ms` es el total; en `steps` cada paso trae cuántas llamadas hizo (`n`) y cuánto sumaron (`ms`). Pasos:
`db`, `google_token`, `calendar`, `gmail`, `gemini`, `fcm`, `weather`, `maps`, `http`.
No se guarda nada del usuario: ni ids, ni correos, ni contenido (los ids de las rutas salen como `:id`).
Las peticiones de más de 5 s salen como `warn` para encontrarlas fácil. Para apagarlo: `PERF_LOG=0`.

## 2. Cómo leerlo
1. Vercel > tu proyecto > **Logs**; filtra por `"perf":1` y copia las líneas a un archivo
   (Vercel conserva los logs por un tiempo limitado según tu plan: copia mientras analizas).
2. `node scripts/perf-summary.mjs < logs.txt`

Por ruta muestra peticiones, mediana (p50), p95 y máximo, y por paso el tiempo medio y las llamadas por
petición. Los pasos pueden solaparse: no tienen por qué sumar el total.

## 3. Qué hacer según lo que salga
| Si domina… | Probable causa | Qué probar |
|---|---|---|
| `db` con muchas llamadas | Latencia entre Vercel y TiDB | Poner la función en la **región de Vercel más cercana al clúster de TiDB** (la región del clúster se ve en TiDB Cloud). En `vercel.json`: `"regions": ["<id de región>"]`. Es lo que más suele pesar. |
| `google_token` alto y frecuente | Instancias nuevas sin token en memoria | Ya se reutiliza el token por usuario mientras la instancia siga activa; si sigue alto, es el arranque en frío. |
| `calendar` en `/api/calendar/scan` y en el barrido | Se pide toda la ventana cada vez | Ya se piden solo los campos necesarios. Siguiente paso, solo si los datos lo justifican: sincronización incremental con `syncToken` (exige guardar el estado de los eventos por usuario). |
| `gemini` | Es lo normal en el chat | Ya se envían solo las herramientas permitidas. Para cuidar el cupo gratuito, añade un modelo **Flash-Lite** vigente a `GEMINI_FALLBACK_MODEL` (admite varios separados por coma): cuando el principal agota su cupo diario, el servidor pasa solo al siguiente. Según la documentación de Gemini los límites gratuitos se cuentan por modelo; confirma los vigentes. |

## 4. Decisiones tomadas
- **No se implementó `syncToken`**: el análisis necesita la ventana completa de eventos en cada pasada y
  la incremental obligaría a guardar contenido de la agenda en la base. No compensa sin datos que lo pidan.
- **No hay enrutamiento automático "simple vs. complejo" hacia un modelo lite**: clasificar mal una
  consulta degradaría respuestas con herramientas. El respaldo por cuota (arriba) da el mismo beneficio
  sin ese riesgo.
- **Región de Vercel**: no se fijó en `vercel.json` porque depende de dónde esté tu clúster de TiDB.
