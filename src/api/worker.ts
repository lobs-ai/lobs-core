import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { json } from "./index.js";

export function registerUworkerRoutes(api: OpenClawPluginApi): void {
  api.registerHttpRoute({
    path: "/paw/api/worker",
    handler: async (_req, res) => {
      json(res, { status: "stub", route: "worker" });
    },
  });
}
