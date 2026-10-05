import { dispatcher } from "../../lib/dispatch";
import { authRoutes } from "../../lib/routes";

// /api/auth/google, /api/auth/me, /api/auth/refresh (una sola función; ver lib/dispatch.ts)
export default dispatcher("/api/auth/", authRoutes);
