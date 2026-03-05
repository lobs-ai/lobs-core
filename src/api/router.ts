import type { IncomingMessage, ServerResponse } from "node:http";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { handleTaskRequest } from "./tasks.js";
import { handleProjectRequest } from "./projects.js";
import { handleAgentRequest } from "./agents.js";
import { handleStatusRequest } from "./status.js";
import { handleInboxRequest } from "./inbox.js";
import { handleWorkerRequest } from "./worker.js";
import { handleWorkflowRequest } from "./workflows.js";
import { handleCalendarRequest } from "./calendar.js";
import { handleOrchestratorRequest } from "./orchestrator.js";
import { handleChatRequest } from "./chat.js";
import { handleMemoriesRequest } from "./memories.js";
import { handleUsageRequest } from "./usage.js";
import { handleResearchRequest } from "./research.js";
import { handleDocumentsRequest } from "./documents.js";
import { handleRoutingRequest } from "./routing.js";
import { handleTemplatesRequest } from "./templates.js";
import { handleTextDumpsRequest } from "./text-dumps.js";
import { handleTopicsRequest } from "./topics.js";
import { handleTilesRequest } from "./tiles.js";
import { handleTrackerRequest } from "./tracker.js";
import { handleWorkflowRunsRequest } from "./workflow-runs.js";
import { handleKnowledgeRequest } from "./knowledge.js";
import { handleKnowledgeFsRequest } from "./knowledge-fs.js";
import { handleMemoriesFsRequest } from "./memories-fs.js";
import { handleReflectionsRequest } from "./reflections.js";
import { handleMeetingsRequest, handleMeetingActionItemsRequest } from "./meetings.js";
import { error } from "./index.js";

const PREFIXES = ["/paw/api/", "/api/"];

export function registerPawRouter(api: OpenClawPluginApi): void {
  (api as any).registerHttpHandler(async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const pathname = decodeURIComponent(url.pathname);

    const prefix = PREFIXES.find(p => pathname.startsWith(p));
    if (!prefix) return false;

    const rest = pathname.slice(prefix.length);
    const parts = rest.split("/").filter(Boolean);
    const resource = parts[0];

    try {
      switch (resource) {
        case "health":          res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ status: "ok", version: "0.1.0", uptime: process.uptime() })); return true;
        case "tasks":           await handleTaskRequest(req, res, parts[1], parts); return true;
        case "projects":        await handleProjectRequest(req, res, parts[1], parts); return true;
        case "agents":          await handleAgentRequest(req, res, parts[1]); return true;
        case "status":          await handleStatusRequest(req, res, parts[1], parts); return true;
        case "inbox":           await handleInboxRequest(req, res, parts[1], parts); return true;
        case "worker":          await handleWorkerRequest(req, res, parts[1], parts); return true;
        case "workflows":       await handleWorkflowRequest(req, res, parts[1]); return true;
        case "workflow-runs":   await handleWorkflowRunsRequest(req, res, parts[1], parts); return true;
        case "calendar":        await handleCalendarRequest(req, res, parts[1], parts); return true;
        case "orchestrator":    await handleOrchestratorRequest(req, res, parts.slice(1)); return true;
        case "chat":            await handleChatRequest(req, res, parts[1], parts); return true;
        case "memories":        await handleMemoriesRequest(req, res, parts[1], parts); return true;
        case "usage":           await handleUsageRequest(req, res, parts[1]); return true;
        case "research":        await handleResearchRequest(req, res, parts[1], parts); return true;
        case "documents":       await handleDocumentsRequest(req, res, parts[1], parts); return true;
        case "routing":         await handleRoutingRequest(req, res, parts[1]); return true;
        case "templates":       await handleTemplatesRequest(req, res, parts[1]); return true;
        case "text-dumps":      await handleTextDumpsRequest(req, res, parts[1]); return true;
        case "topics":          await handleTopicsRequest(req, res, parts[1], parts); return true;
        case "tiles":           await handleTilesRequest(req, res, parts[1], parts); return true;
        case "tracker":         await handleTrackerRequest(req, res, parts); return true;
        case "knowledge":       await handleKnowledgeRequest(req, res, parts[1], parts); return true;
        case "knowledge-fs":    await handleKnowledgeFsRequest(req, res, parts[1], parts); return true;
        case "memories-fs":     await handleMemoriesFsRequest(req, res, parts[1]); return true;
        case "reflections":      await handleReflectionsRequest(req, res, parts[1], parts); return true;
        case "meetings":         await handleMeetingsRequest(req, res, parts[1], parts); return true;
        default:                error(res, `Unknown resource: ${resource}`, 404); return true;
      }
    } catch (err) {
      if (!res.headersSent) error(res, `Internal error: ${String(err)}`, 500);
      return true;
    }
  });
}
