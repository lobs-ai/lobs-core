/**
 * Skills API — list loaded skills.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { json, error } from "./index.js";
import { skillsService } from "../services/skills.js";

export async function handleSkillsRequest(
  req: IncomingMessage,
  res: ServerResponse,
  _sub?: string,
): Promise<void> {
  if (req.method !== "GET") {
    return error(res, "Method not allowed", 405);
  }

  // Return all skills (without full instructions to keep response light)
  const skills = skillsService.getAll().map(s => ({
    name: s.name,
    description: s.description,
    tags: s.tags,
    path: s.path,
  }));

  json(res, { skills });
}
