import { dispatcher } from "../../lib/dispatch";
import { aiRoutes } from "../../lib/routes";

// /api/ai/chat, /api/ai/usage, /api/ai/diagnose, /api/ai/actions/:actionId/confirm (una sola función)
export default dispatcher("/api/ai/", aiRoutes);
