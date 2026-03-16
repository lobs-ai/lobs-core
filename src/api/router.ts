import type { IncomingMessage, ServerResponse } from "node:http";
import type { LobsPluginApi } from "../types/lobs-plugin.js";
import { handleTaskRequest } from "./tasks.js";
import { handleProjectRequest } from "./projects.js";
import { handleAgentRequest } from "./agents.js";
import { handleStatusRequest } from "./status.js";
import { handleInboxRequest } from "./inbox.js";
import { handleWorkerRequest } from "./worker.js";
import { handleWorkflowRequest } from "./workflows.js";
import { handleCalendarRequest } from "./calendar.js";
import { handleOrchestratorRequest } from "./orchestrator.js";
import { handleChatRequest, handleMainAgentChat } from "./chat.js";
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
import { handleYouTubeRequest } from "./youtube.js";
import { handleComplianceRequest } from "./compliance.js";
import { handleLearningRequest } from "./learning.js";
import { handleAdminRequest } from "./admin.js";
import { handleDashboardRequest } from "./dashboard.js";
import { handleDiscordRequest } from "./discord.js";
import { handlePluginsRequest, handleUiAffordancesRequest, handleUiConfigRequest } from "./plugins.js";
import { handleSchedulerRequest } from "./scheduler.js";
import { handleGitHubRequest } from "./github.js";
import { handleDailyBriefRequest } from "./daily-brief.js";
import { handleSkillsRequest } from "./skills.js";
import { handleHealthRequest } from "./health.js";
import { handleTrainingRequest } from "./training.js";
import { handleTrainingPipelineRequest } from "./training-pipeline.js";
import { error } from "./index.js";

const PREFIXES = ["/paw/api/", "/api/"];

export function registerPawRouter(api: LobsPluginApi): void {
  const handler = async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const pathname = decodeURIComponent(url.pathname);

    const prefix = PREFIXES.find(p => pathname.startsWith(p));
    if (!prefix) return false;

    const rest = pathname.slice(prefix.length);
    const parts = rest.split("/").filter(Boolean);
    const resource = parts[0];

    try {
      switch (resource) {
        case "health":          await handleHealthRequest(req, res); return true;
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
        case "agent":           await handleMainAgentChat(req, res, parts[1]); return true;
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
        case "youtube":          await handleYouTubeRequest(req, res, parts[1], parts); return true;
        case "compliance":       await handleComplianceRequest(req, res, parts[1]); return true;
        case "learning":         await handleLearningRequest(req, res, parts[1], parts); return true;
        case "admin":            await handleAdminRequest(req, res, parts); return true;
        case "dashboard":        await handleDashboardRequest(req, res, parts[1]); return true;
        case "discord":          await handleDiscordRequest(req, res, parts[1], parts); return true;
        case "plugins":         await handlePluginsRequest(req, res, parts[1], parts); return true;
        case "ui-affordances":  await handleUiAffordancesRequest(req, res); return true;
        case "ui-config":       await handleUiConfigRequest(req, res); return true;
        case "scheduler":       await handleSchedulerRequest(req, res, parts[1], parts); return true;
        case "github":          await handleGitHubRequest(req, res, parts[1], parts); return true;
        case "daily-brief":     await handleDailyBriefRequest(req, res, parts[1]); return true;
        case "skills":          await handleSkillsRequest(req, res, parts[1]); return true;
        case "training":        await handleTrainingRequest(req, res, parts[1], parts[2]); return true;
        case "training-pipeline": await handleTrainingPipelineRequest(req, res, parts[1], parts); return true;
        default:                error(res, `Unknown resource: ${resource}`, 404); return true;
      }
    } catch (err) {
      if (!res.headersSent) error(res, `Internal error: ${String(err)}`, 500);
      return true;
    }
  };

  // Register under both prefixes
  api.registerHttpRoute({ path: "/paw/api", handler, auth: "plugin", match: "prefix" });
  api.registerHttpRoute({ path: "/api", handler, auth: "plugin", match: "prefix" });
}

/**
 * Standalone API handler — for use without the plugin host.
 * Wire this into the HTTP server directly.
 */
export async function handleApiRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const pathname = decodeURIComponent(url.pathname);

  const prefix = PREFIXES.find(p => pathname.startsWith(p));
  if (!prefix) {
    error(res, "Not found", 404);
    return;
  }

  const rest = pathname.slice(prefix.length);
  const parts = rest.split("/").filter(Boolean);
  const resource = parts[0];

  try {
    switch (resource) {
      case "health":          await handleHealthRequest(req, res); return;
      case "tasks":           await handleTaskRequest(req, res, parts[1], parts); return;
      case "projects":        await handleProjectRequest(req, res, parts[1], parts); return;
      case "agents":          await handleAgentRequest(req, res, parts[1]); return;
      case "status":          await handleStatusRequest(req, res, parts[1], parts); return;
      case "inbox":           await handleInboxRequest(req, res, parts[1], parts); return;
      case "worker":          await handleWorkerRequest(req, res, parts[1], parts); return;
      case "workflows":       await handleWorkflowRequest(req, res, parts[1]); return;
      case "workflow-runs":   await handleWorkflowRunsRequest(req, res, parts[1], parts); return;
      case "orchestrator":    await handleOrchestratorRequest(req, res, parts.slice(1)); return;
      case "chat":            await handleChatRequest(req, res, parts[1], parts); return;
      case "agent":           await handleMainAgentChat(req, res, parts[1]); return;
      case "memories":        await handleMemoriesRequest(req, res, parts[1], parts); return;
      case "usage":           await handleUsageRequest(req, res, parts[1]); return;
      case "reflections":     await handleReflectionsRequest(req, res, parts[1], parts); return;
      case "meetings":        await handleMeetingsRequest(req, res, parts[1], parts); return;
      case "knowledge":       await handleKnowledgeRequest(req, res, parts[1], parts); return;
      case "knowledge-fs":    await handleKnowledgeFsRequest(req, res, parts[1], parts); return;
      case "memories-fs":     await handleMemoriesFsRequest(req, res, parts[1]); return;
      case "scheduler":       await handleSchedulerRequest(req, res, parts[1], parts); return;
      case "github":          await handleGitHubRequest(req, res, parts[1], parts); return;
      case "daily-brief":     await handleDailyBriefRequest(req, res, parts[1]); return;
      case "learning":        await handleLearningRequest(req, res, parts[1], parts); return;
      case "tracker":         await handleTrackerRequest(req, res, parts); return;
      case "research":        await handleResearchRequest(req, res, parts[1], parts); return;
      case "documents":       await handleDocumentsRequest(req, res, parts[1], parts); return;
      case "youtube":         await handleYouTubeRequest(req, res, parts[1], parts); return;
      case "topics":          await handleTopicsRequest(req, res, parts[1], parts); return;
      case "tiles":           await handleTilesRequest(req, res, parts[1], parts); return;
      case "skills":          await handleSkillsRequest(req, res, parts[1]); return;
      case "training":        await handleTrainingRequest(req, res, parts[1], parts[2]); return;
      case "training-pipeline": await handleTrainingPipelineRequest(req, res, parts[1], parts); return;
      default:                error(res, `Unknown resource: ${resource}`, 404); return;
    }
  } catch (err) {
    if (!res.headersSent) error(res, `Internal error: ${String(err)}`, 500);
  }
}
