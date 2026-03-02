import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { json } from "./index.js";

export function registerUprojectsRoutes(api: OpenClawPluginApi): void {
  api.registerHttpRoute({
    path: "/paw/api/projects",
    handler: async (_req, res) => {
      json(res, { status: "stub", route: "projects" });
    },
  });
}
