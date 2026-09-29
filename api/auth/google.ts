import { randomUUID } from "node:crypto";
import { route, bodyOf, HttpError } from "../../lib/http";
import { query, exec } from "../../lib/db";
import { encrypt } from "../../lib/crypto";
import { signAccessToken, signRefreshToken } from "../../lib/auth";
import { verifyGoogleIdToken, exchangeAuthCode } from "../../lib/google";
import { toApiUser, type UserRow } from "../../lib/users";

export default route(["POST"], async (req, res) => {
  const body = bodyOf(req);
  const idToken = body.idToken;
  const serverAuthCode = body.serverAuthCode;

  if (typeof idToken !== "string" || typeof serverAuthCode !== "string") {
    throw new HttpError(400, "Faltan idToken o serverAuthCode");
  }

  const identity = await verifyGoogleIdToken(idToken);
  const googleTokens = await exchangeAuthCode(serverAuthCode);

  if (!googleTokens.refresh_token) {
    // Pasa si el usuario ya había dado consentimiento antes y Google no
    // reemite el refresh_token. Por ahora lo tratamos como error: sin
    // refresh_token no podemos sincronizar su Calendar más adelante.
    throw new HttpError(
      409,
      "Google no devolvió un refresh token. Revocá el acceso de la app en tu cuenta de Google y probá de nuevo."
    );
  }

  const encryptedRefreshToken = encrypt(googleTokens.refresh_token);
  const existing = await query<UserRow>("SELECT * FROM users WHERE google_sub = ?", [
    identity.sub,
  ]);

  let user: UserRow;
  if (existing[0]) {
    await exec(
      `UPDATE users
       SET email = ?, name = ?, photo_url = ?, google_refresh_token_enc = ?
       WHERE id = ?`,
      [identity.email, identity.name, identity.picture ?? null, encryptedRefreshToken, existing[0].id]
    );
    user = { ...existing[0], email: identity.email, name: identity.name };
  } else {
    const id = randomUUID();
    await exec(
      `INSERT INTO users (id, google_sub, email, name, photo_url, google_refresh_token_enc)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [id, identity.sub, identity.email, identity.name, identity.picture ?? null, encryptedRefreshToken]
    );
    user = {
      id,
      google_sub: identity.sub,
      email: identity.email,
      name: identity.name,
      photo_url: identity.picture ?? null,
      google_refresh_token_enc: encryptedRefreshToken,
      onboarding_completed: 0,
      subscription_active: 0,
    };
  }

  const [accessToken, refreshToken] = await Promise.all([
    signAccessToken(user.id),
    signRefreshToken(user.id),
  ]);

  res.status(200).json({ user: toApiUser(user), accessToken, refreshToken });
});
