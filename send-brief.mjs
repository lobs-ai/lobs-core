import { discordPostTool } from "./src/runner/tools/discord-post.js";

const result = await discordPostTool({
  channel_id: "1466921249421660415",
  content: `**Good morning Rafe!** Here's your morning brief for Tuesday, April 21.

**Overnight Agent Activity** (past 24h)
No overnight agent work recorded.

**Today's Schedule**
• Office hours 8:30–10:30am
• EECS 281 lecture 10:30am–12pm

**Tasks**
Active: 0 | Completed today: 0 | Blocked: 0 | Overdue: 0

**System**
✅ Healthy — no issues

📋 No urgent items — steady state`,
});

console.log(result);