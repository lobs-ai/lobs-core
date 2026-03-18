import type { IncomingMessage, ServerResponse } from "node:http";
import { json, error, parseQuery } from "./index.js";
import {
  getChannelModelOverride,
  getDefaultChatModel,
  getModelCatalog,
} from "../services/model-catalog.js";

export async function handleModelsRequest(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  if (req.method !== "GET") {
    return error(res, "Method not allowed — use GET", 405);
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
  });
}
