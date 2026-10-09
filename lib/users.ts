import { computeAccess } from "./billing";

export interface UserRow {
  id: string;
  google_sub: string;
  email: string;
  name: string;
  photo_url: string | null;
  google_refresh_token_enc: string;
  onboarding_completed: number;
  subscription_active: number;
  // Columnas de cobro (opcionales: una base de datos sin migrar sigue funcionando; ver docs/migracion-billing.sql).
  access_override?: string | null;
  access_until?: string | Date | null;
  subscription_expires_at?: string | Date | null;
  play_onboarding_token?: string | null;
  play_subscription_token?: string | null;
}

/** Forma que espera la app (ver `User` en src/types/index.ts). */
export function toApiUser(u: UserRow) {
  const { access, paywall, until } = computeAccess(u);
  return {
    id: u.id,
    email: u.email,
    name: u.name,
    photoUrl: u.photo_url ?? undefined,
    // Compatibilidad: las versiones de la app que ya están instaladas solo miran onboardingCompleted para decidir si
    // muestran la pantalla de pago. Ahora significa "no tiene que pagar": cobro apagado, acceso gratis/de prueba o pagó.
    onboardingCompleted: !paywall,
    subscriptionActive: Boolean(u.subscription_active),
    /** open = cobro apagado; free / trial = sin pagar; paid = pagó; payment_required = debe pagar. */
    access,
    accessUntil: until ?? undefined,
  };
}
