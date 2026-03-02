import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { json } from "./index.js";

export function registerUinboxRoutes(api: OpenClawPluginApi): void {
  api.registerHttpRoute({
    path: "/paw/api/inbox",
    handler: async (_req, res) => {
      json(res, { status: "stub", route: "inbox" });
    },
  });
}
