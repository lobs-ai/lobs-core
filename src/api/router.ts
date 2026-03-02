import type { IncomingMessage, ServerResponse } from "node:http";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { handleTaskRequest } from "./tasks.js";
import { handleProjectRequest } from "./projects.js";
import { handleAgentRequest } from "./agents.js";
import { handleStatusRequest } from "./status.js";
import { handleInboxRequest } from "./inbox.js";
import { handleWorkerRequest } from "./worker.js";
import { handleWorkflowRequest } from "./workflows.js";
import { error } from "./index.js";

const PREFIX = "/paw/api/";

export function registerPawRouter(api: OpenClawPluginApi): void {
  // registerHttpHandler takes a bare function: (req, res) => Promise<boolean>
  (api as any).registerHttpHandler(async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const pathname = url.pathname;

    if (!pathname.startsWith(PREFIX)) return false;

    const rest = pathname.slice(PREFIX.length);
    const parts = rest.split("/").filter(Boolean);
    const resource = parts[0];
    const id = parts[1];

    try {
      switch (resource) {
        case "tasks": await handleTaskRequest(req, res, id, parts); return true;
        case "projects": await handleProjectRequest(req, res, id); return true;
        case "agents": await handleAgentRequest(req, res, id); return true;
        case "status": await handleStatusRequest(req, res, id); return true;
        case "inbox": await handleInboxRequest(req, res, id); return true;
        case "worker": await handleWorkerRequest(req, res, id); return true;
        case "workflows": await handleWorkflowRequest(req, res, id); return true;
        default: error(res, `Unknown resource: ${resource}`, 404); return true;
      }
    } catch (err) {
      if (!res.headersSent) error(res, `Internal error: ${String(err)}`, 500);
      return true;
    }
  });
}
