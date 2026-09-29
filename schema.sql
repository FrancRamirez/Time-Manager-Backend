-- Pegá y ejecutá todo este script en el SQL Editor de TiDB Cloud.

CREATE DATABASE IF NOT EXISTS time_manager;
USE time_manager;

CREATE TABLE IF NOT EXISTS users (
  id CHAR(36) NOT NULL PRIMARY KEY,
  google_sub VARCHAR(64) NOT NULL,
  email VARCHAR(255) NOT NULL,
  name VARCHAR(255) NOT NULL,
  photo_url TEXT NULL,
  -- refresh token de Google cifrado con AES-256-GCM (base64)
  google_refresh_token_enc TEXT NOT NULL,
  onboarding_completed TINYINT(1) NOT NULL DEFAULT 0,
  subscription_active TINYINT(1) NOT NULL DEFAULT 0,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_users_google_sub (google_sub)
);

CREATE TABLE IF NOT EXISTS devices (
  id CHAR(36) NOT NULL PRIMARY KEY,
  user_id CHAR(36) NOT NULL,
  fcm_token VARCHAR(255) NOT NULL,
  platform VARCHAR(20) NOT NULL DEFAULT 'android',
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_devices_fcm_token (fcm_token),
  KEY idx_devices_user (user_id)
);

CREATE TABLE IF NOT EXISTS suggestions (
  id CHAR(36) NOT NULL PRIMARY KEY,
  user_id CHAR(36) NOT NULL,
  event_id VARCHAR(255) NOT NULL,
  current_starts_at VARCHAR(40) NOT NULL,
  current_ends_at VARCHAR(40) NOT NULL,
  proposed_starts_at VARCHAR(40) NOT NULL,
  proposed_ends_at VARCHAR(40) NOT NULL,
  reason TEXT NOT NULL,
  status VARCHAR(12) NOT NULL DEFAULT 'pending', -- pending | accepted | rejected
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_suggestions_user_status (user_id, status)
);

-- Acciones que Gemini propone y esperan confirmación del usuario.
-- (Los mensajes del chat NO se guardan: procesamiento efímero.)
CREATE TABLE IF NOT EXISTS pending_actions (
  id CHAR(36) NOT NULL PRIMARY KEY,
  user_id CHAR(36) NOT NULL,
  type VARCHAR(20) NOT NULL, -- create | reschedule | cancel
  description TEXT NOT NULL,
  payload JSON NOT NULL,
  status VARCHAR(12) NOT NULL DEFAULT 'pending', -- pending | executed | rejected
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_pending_user_status (user_id, status)
);
