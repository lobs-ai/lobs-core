import type { IncomingMessage, ServerResponse } from "node:http";
import { json, error, parseBody, parseQuery } from "./index.js";
import {
  getChannelModelOverride,
  getDefaultChatModel,
  getModelCatalog,
} from "../services/model-catalog.js";
import {
  getSchedulerModelSettings,
  updateSchedulerModelSettings,
} from "../services/scheduler-intelligence.js";

export async function handleModelsRequest(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  if (req.method === "PATCH") {
    try {
      const body = await parseBody(req) as {
        scheduler?: {
          enabled?: boolean;
          localOnly?: boolean;
          tier?: "micro" | "small" | "medium" | "standard" | "strong";
          overrideModel?: string | null;
          temperature?: number;
          maxTokens?: number;
        };
      };

      if (!body.scheduler) {
        return error(res, "Missing scheduler settings payload", 400);
      }

      const scheduler = updateSchedulerModelSettings(body.scheduler);
      return json(res, { success: true, scheduler });
    } catch (err) {
      return error(res, `Failed to update model settings: ${String(err)}`, 500);
    }
  }

  if (req.method !== "GET") {
    return error(res, "Method not allowed — use GET or PATCH", 405);
  }

  const query = parseQuery(req.url ?? "");
  const channelId = query.channelId || (query.sessionKey ? `nexus:${query.sessionKey}` : "");
  const overrideModel = channelId ? getChannelModelOverride(channelId) : null;
  const catalog = await getModelCatalog();

  return json(res, {
    defaultModel: catalog.defaultModel,
    currentModel: overrideModel || catalog.defaultModel || getDefaultChatModel(),
    overrideModel,
    options: catalog.options,
    lmstudio: catalog.lmstudio,
    scheduler: getSchedulerModelSettings(),
  });
}
