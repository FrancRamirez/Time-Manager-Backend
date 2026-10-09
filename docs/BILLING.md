# Cobro de Time Manager (preparado, apagado)

Estado actual: **apagado**. Con `BILLING_ENABLED` vacío o en `false` nadie ve el mensaje de pagar y todo funciona como siempre.

## Quién paga y quién no (lo decide el servidor)
Orden: cobro apagado -> `FREE_ACCESS_EMAILS` -> acceso por usuario en la base -> compra verificada -> debe pagar.

- `FREE_ACCESS_EMAILS=tu@gmail.com,amigo@gmail.com:2026-12-31` (Vercel). Sin fecha = gratis siempre; con fecha = de prueba hasta ese día.
- O por usuario, sin redesplegar (TiDB): ver `docs/migracion-billing.sql`.

## Para encender el cobro (cuando llegue el momento)
1. Ejecutar `docs/migracion-billing.sql` en TiDB.
2. Poner **tu correo** (y el de quienes usarán gratis) en `FREE_ACCESS_EMAILS`.
3. Play Console: crear el producto de pago único y la suscripción mensual; crear una cuenta de servicio con permiso de
   finanzas y cargar `PLAY_PACKAGE_NAME`, `PLAY_ONBOARDING_PRODUCT_ID`, `PLAY_SUBSCRIPTION_ID`, `PLAY_SERVICE_ACCOUNT_JSON`.
4. En la app: integrar el SDK de compras (ver `src/services/billing.ts`) y reconstruir el dev build.
5. Probar con una cuenta de prueba de licencias de Play y recién entonces `BILLING_ENABLED=true`.

## Qué protege el servidor
- `POST /api/ai/chat` y `/api/ai/confirm` responden 402 `payment_required` a quien debe pagar.
- El barrido con la app cerrada (`/api/cron/scan`) no analiza cuentas que deben pagar.
- `POST /api/billing/confirm-onboarding` ya no activa nada por pedido del cliente: verifica el `purchaseToken` con
  Google Play, lo confirma (acknowledge) y no deja usar el mismo token en dos cuentas.

## Pendiente / límites
- La verificación con Google Play está escrita según la documentación y probada con respuestas simuladas, **no contra Google Play real**.
- No hay aún notificaciones en tiempo real de Play (RTDN): la renovación se comprueba cuando la app llama a `sync`.
- El cupo de IA por usuario (`AI_DAILY_MESSAGES_PER_USER`) es igual para todos; separar "pago" de "prueba" queda para cuando se pague Gemini.
