import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { json } from "./index.js";

export function registerUstatusRoutes(api: OpenClawPluginApi): void {
  api.registerHttpRoute({
    path: "/paw/api/status",
    handler: async (_req, res) => {
      json(res, { status: "stub", route: "status" });
    },
  });
}
