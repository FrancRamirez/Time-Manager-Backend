import { dispatcher } from "../../lib/dispatch";
import { devicesRoutes } from "../../lib/routes";

// /api/devices/register, /api/devices/unregister (una sola función)
export default dispatcher("/api/devices/", devicesRoutes);
