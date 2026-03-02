import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { json } from "./index.js";

export function registerUworkflowsRoutes(api: OpenClawPluginApi): void {
  api.registerHttpRoute({
    path: "/paw/api/workflows",
    handler: async (_req, res) => {
      json(res, { status: "stub", route: "workflows" });
    },
  });
}
