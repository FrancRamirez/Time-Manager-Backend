export interface UserRow {
  id: string;
  google_sub: string;
  email: string;
  name: string;
  photo_url: string | null;
  google_refresh_token_enc: string;
  onboarding_completed: number;
  subscription_active: number;
}

/** Forma que espera la app (ver `User` en src/types/index.ts). */
export function toApiUser(u: UserRow) {
  return {
    id: u.id,
    email: u.email,
    name: u.name,
    photoUrl: u.photo_url ?? undefined,
    onboardingCompleted: Boolean(u.onboarding_completed),
    subscriptionActive: Boolean(u.subscription_active),
  };
}
