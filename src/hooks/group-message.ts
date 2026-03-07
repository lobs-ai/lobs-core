/**
 * group-message hook — intercept "group message" commands from user input.
 *
 * Registers two surfaces:
 *
 * 1. before_user_message — detects natural-language group message commands
 *    (e.g. "group message Alice Bob about Q2") and injects skill guidance into
 *    the agent's system context so it follows the group-messaging skill workflow.
 *
 * 2. /group-message slash command — explicit shortcut for the same flow.
 *    Usage: /group-message Alice Bob [about <topic>]
 *
 * Both surfaces use parseGroupMessageCommand to extract recipients + topic,
 * then return a structured confirmation prompt or error.
 *
 * The agent is expected to:
 *   1. Resolve recipient names → Discord IDs via action: "user-search"
 *   2. Check GroupChannelManager for an existing channel
 *   3. Confirm with the user via formatConfirmationPrompt output
 *   4. Create or reuse the channel, then send the opening message
 *
 * See: ~/.openclaw/skills/group-messaging/SKILL.md for the full workflow.
 */

import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import {
  isGroupMessageCommand,
  parseGroupMessageCommand,
  formatConfirmationPrompt,
  type GroupMessageCommand,
} from "../util/group-message-command.js";
import { log } from "../util/logger.js";

// Path to the group-messaging skill — injected into system context so the
// agent has access to the full workflow instructions.
const GROUP_MESSAGING_SKILL_HINT = `
## Active Skill: group-messaging

A group message command was detected. Follow the group-messaging skill:

1. **Parse** — command already parsed (recipients + topic provided below)
2. **Resolve** — look up Discord IDs for each recipient via \`action: "user-search"\`
3. **Check existing** — call GroupChannelManager.prepare_channel_plan() or query group_channels DB
4. **Confirm** — present the confirmation prompt to the user and wait for approval
5. **Create or reuse** — channel if new combination, skip creation if existing
6. **Send** — tag all participants, include topic context
7. **Touch** — update last_used_at in the registry

Full skill reference: ~/.openclaw/skills/group-messaging/SKILL.md
`.trim();

/**
 * Build the system context injection for a parsed group message command.
 */
function buildSkillContext(cmd: GroupMessageCommand): string {
  const lines: string[] = [GROUP_MESSAGING_SKILL_HINT, ""];
  lines.push(`**Parsed command:**`);
  lines.push(`- Recipients: ${cmd.recipients.join(", ")}`);
  if (cmd.topic) lines.push(`- Topic: ${cmd.topic}`);
  lines.push(`- Confirmation prompt: "${formatConfirmationPrompt(cmd)}"`);
  return lines.join("\n");
}

export function registerGroupMessageHook(api: OpenClawPluginApi): void {
  // ── 1. Natural-language intercept via before_user_message ───────────────
  // Intercept user messages that look like group message commands and inject
  // skill context so the agent knows exactly what workflow to follow.
  api.on("before_user_message", async (event) => {
    const ev = event as Record<string, unknown>;
    const message = (ev.message ?? ev.text ?? ev.content ?? "") as string;

    if (!message || !isGroupMessageCommand(message)) return;

    const cmd = parseGroupMessageCommand(message);
    log().info(`[PAW] Group message command detected — recipients: [${cmd.recipients.join(", ")}]${cmd.topic ? ` topic: ${cmd.topic}` : ""}`);

    if (!cmd.isValid) {
      // Return an early reply with the error instead of passing to the LLM
      return {
        earlyReply: cmd.error,
      };
    }

    // Inject skill guidance into the system context for this turn
    return {
      appendSystemContext: buildSkillContext(cmd),
    };
  });

  // ── 2. /group-message slash command ──────────────────────────────────────
  // Explicit slash command as an alternative to natural language.
  // Usage: /group-message Alice Bob [about Q2 roadmap]
  api.registerCommand?.({
    name: "group-message",
    description: "Start a group chat. Usage: /group-message [name1] [name2] [about topic]",
    handler: async (ctx) => {
      // The slash command args arrive as the remainder after the command name.
      // OpenClaw passes the full text including the command name for context.
      const raw = (ctx as Record<string, unknown>)?.args as string ?? "";

      // Synthesize a full command string the parser understands
      const fullText = `group message ${raw}`.trim();
      const cmd = parseGroupMessageCommand(fullText);

      if (!cmd.isValid) {
        return { text: `❌ ${cmd.error}` };
      }

      log().info(`[PAW] /group-message command — recipients: [${cmd.recipients.join(", ")}]${cmd.topic ? ` topic: ${cmd.topic}` : ""}`);

      const confirmation = formatConfirmationPrompt(cmd);
      const lines: string[] = [
        `👥 ${confirmation}`,
        "",
        `Recipients: **${cmd.recipients.join("**, **")}**`,
      ];
      if (cmd.topic) lines.push(`Topic: *${cmd.topic}*`);
      lines.push("", "Reply **yes** to create the channel, or **no** to cancel.");

      return { text: lines.join("\n") };
    },
  });

  log().info("[PAW] Group message hook registered (before_user_message + /group-message)");
}
