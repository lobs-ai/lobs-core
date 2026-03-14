# Deployment Checklist: Per-Channel Sessions Implementation

## Pre-Deployment ✅ (COMPLETE)
- [x] TypeScript compiles without errors
- [x] All verification checks pass
- [x] Implementation summary documented
- [x] Verification script created and tested

## Deployment Steps

### 1. Build
```bash
cd ~/lobs/lobs-core
npm run build
```

### 2. Restart lobs-core
```bash
# Option A: If running as a service
lobs restart

# Option B: Manual restart
# 1. Stop current process (Ctrl+C or `pkill -f "node dist/main.js"`)
# 2. Start fresh:
cd ~/lobs/lobs-core
node dist/main.js
```

### 3. Verify Database Migration
Check logs for:
```
[main-agent] Added platform_message_id column
```
OR (if already migrated):
```
(No message — column already exists)
```

### 4. Test Per-Channel Sessions
**Objective:** Verify channels process independently

1. Open 2+ Discord channels where the bot is active
2. Send messages to both channels at the same time (within 1-2 seconds)
3. Check logs — should see:
   ```
   [main-agent] Processing channel <channel-A-id>
   [main-agent] Processing channel <channel-B-id>
   ```
   Both processing simultaneously (not queued)

4. Verify each channel has isolated conversation history:
   - Talk about "topic A" in channel 1
   - Talk about "topic B" in channel 2
   - Return to channel 1 — agent should remember "topic A" context
   - Return to channel 2 — agent should remember "topic B" context (not A)

### 5. Test Discord Reactions
**Objective:** Verify react tool works

1. Send a test message in Discord
2. Note the message ID (right-click → Copy Message ID, or from logs)
3. Ask the agent to react to it:
   ```
   React to message <message-id> in this channel with 👍
   ```
4. Verify the bot adds the 👍 reaction to the message

**Test cases:**
- [ ] Unicode emoji (👍, ✅, ❌, 🎉)
- [ ] Custom emoji (if server has custom emojis): `react to <msg> with CustomEmojiName:id`

### 6. Test Tool Filtering
**Objective:** Verify session types have correct tool access

#### Nexus/API Chat (http://localhost:9420)
1. Open Nexus dashboard
2. Start a chat session
3. Try to use message tool → Should fail with "Unknown tool: message"
4. Try to use react tool → Should fail with "Unknown tool: react"
5. Verify basic tools work (exec, read, write, web_search)

#### Discord Channel
1. Send message in Discord
2. Agent should have access to message and react tools
3. Agent should NOT have access to cron tool

#### System Events (cron/heartbeat)
1. Wait for a scheduled heartbeat or trigger a cron job
2. System session should have full tool access (including cron)

### 7. Concurrency Test
**Objective:** Verify max 3 concurrent channels

1. Send messages to 4+ Discord channels simultaneously
2. Check logs:
   - First 3 channels should start processing immediately
   - 4th channel should queue with log:
     ```
     [main-agent] Queued message for channel <id> (concurrency limit reached)
     ```
3. When first channel finishes, 4th should start automatically

### 8. Regression Tests
**Objective:** Verify existing functionality still works

- [ ] API chat endpoint (Nexus dashboard) works
- [ ] Discord notifications (alerts, task completions) still send
- [ ] Worker agents still spawn and complete tasks
- [ ] Cron jobs still fire on schedule
- [ ] Heartbeat still runs

## Rollback Plan

If issues occur:

### Quick Rollback (Revert Code)
```bash
cd ~/lobs/lobs-core
git reset --hard HEAD~1  # or specific commit before changes
npm run build
lobs restart
```

### Database Issue (platform_message_id)
The column is nullable, so old code will work fine. No rollback needed.

If you need to remove it:
```sql
sqlite3 ~/.lobs/plugins/lobs/lobs.db "ALTER TABLE main_agent_messages DROP COLUMN platform_message_id;"
```
(Note: SQLite doesn't support DROP COLUMN in older versions — may need to recreate table)

## Known Issues / Troubleshooting

### Issue: Agent doesn't react to messages
**Check:**
1. Discord intents include `GuildMessageReactions`
2. Bot has permission to add reactions in the channel
3. messageId is being captured (check DB: `SELECT platform_message_id FROM main_agent_messages LIMIT 5;`)

### Issue: Channels still block each other
**Check:**
1. Logs show `processingChannels` Set usage
2. Multiple channels have `Processing channel <id>` logs at the same time
3. MAX_CONCURRENT_CHANNELS is set correctly (default: 3)

### Issue: History bleeding between channels
**Check:**
1. DB query in getRecentHistory includes `WHERE channel_id = ?`
2. Each channel's messages have correct channel_id in DB
3. Verify: `SELECT DISTINCT channel_id FROM main_agent_messages;`

### Issue: Tools unavailable in wrong session
**Check:**
1. `getSessionType()` logic correctly identifies channel type
2. `getToolsForSession()` returns correct tool array
3. Logs show tool filtering: `Resolved tools based on session type`

## Post-Deployment Monitoring

Watch these metrics for first 24 hours:

1. **Per-channel processing:**
   - Multiple channels processing simultaneously? ✅
   - Queue depth per channel stays low? ✅

2. **Database:**
   - platform_message_id populated for new messages? ✅
   - No DB errors in logs? ✅

3. **Reactions:**
   - react tool calls succeed? ✅
   - No permission errors? ✅

4. **Tool filtering:**
   - Nexus sessions don't have Discord tools? ✅
   - Discord sessions don't have cron tool? ✅

## Success Criteria

✅ All of the following must be true:

1. TypeScript compiles cleanly
2. Messages from multiple Discord channels process in parallel
3. Each channel maintains isolated conversation history
4. React tool adds emoji reactions to Discord messages
5. Nexus/API chat works (no Discord tools available)
6. System sessions have full tool access
7. No regressions in existing functionality

---

**Status:** Ready for deployment  
**Risk Level:** Low (no breaking changes, safe DB migration)  
**Estimated Downtime:** ~10 seconds (rebuild + restart)
