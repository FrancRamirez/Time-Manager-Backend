-- Migración del cobro (BILLING). Ejecútala UNA vez en el SQL Editor de TiDB Cloud, ANTES de poner BILLING_ENABLED=true.
-- Si tu tabla `users` ya existe (se creó con el schema.sql anterior) hacen falta estas columnas nuevas.
-- Con BILLING_ENABLED apagado la app funciona igual aunque no la ejecutes todavía.
-- Si una columna ya existe, TiDB responde "Duplicate column name": es inofensivo, sigue con la siguiente.

USE time_manager;

ALTER TABLE users ADD COLUMN access_override VARCHAR(10) NULL;
ALTER TABLE users ADD COLUMN access_until DATE NULL;
ALTER TABLE users ADD COLUMN subscription_expires_at DATETIME NULL;
ALTER TABLE users ADD COLUMN play_onboarding_token TEXT NULL;
ALTER TABLE users ADD COLUMN play_subscription_token TEXT NULL;

-- ---------------------------------------------------------------------------------------------
-- Acceso sin pagar por usuario (sin redesplegar). Pon tu correo y el de quienes quieras que usen la app gratis:
--
--   Gratis siempre:
--     UPDATE users SET access_override = 'free', access_until = NULL WHERE email = 'tucorreo@gmail.com';
--
--   De prueba hasta una fecha (inclusive):
--     UPDATE users SET access_override = 'trial', access_until = '2026-12-31' WHERE email = 'amigo@gmail.com';
--
--   Quitar el acceso especial:
--     UPDATE users SET access_override = NULL, access_until = NULL WHERE email = 'amigo@gmail.com';
--
-- También puedes usar la variable FREE_ACCESS_EMAILS en Vercel (ver env.example): sirve incluso antes de que la
-- persona haya iniciado sesión por primera vez, y no depende de esta migración.
