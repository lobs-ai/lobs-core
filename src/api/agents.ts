import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { json } from "./index.js";

export function registerUagentsRoutes(api: OpenClawPluginApi): void {
  api.registerHttpRoute({
    path: "/paw/api/agents",
    handler: async (_req, res) => {
      json(res, { status: "stub", route: "agents" });
    },
  });
}
