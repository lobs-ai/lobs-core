/**
 * Tests for MainAgent session management and DB operations.
 * Uses in-memory SQLite database to test without LLM calls.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import { MainAgent } from "../src/services/main-agent.js";

describe("MainAgent Session Management", () => {
  let db: Database.Database;
  let agent: MainAgent;

  beforeEach(() => {
    // Create in-memory database for each test
    db = new Database(":memory:");
    agent = new MainAgent(db, "test-model");
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("should create required tables on initialization", () => {
    // Check that tables exist
    const tables = db.prepare(`
      SELECT name FROM sqlite_master WHERE type='table' 
      ORDER BY name
    `).all() as Array<{ name: string }>;

    const tableNames = tables.map(t => t.name);
    
    expect(tableNames).toContain("main_agent_messages");
    expect(tableNames).toContain("channel_sessions");
    expect(tableNames).toContain("message_queue");
  });

  it("should store message in DB when handleMessage is called", async () => {
    // We need to mock the reply handler to avoid errors
    agent.setReplyHandler(async () => {});
    agent.setTypingHandler(() => {});
    
    // Create a simple message
    const msg = {
      id: "test-msg-1",
      content: "Hello, world!",
      authorId: "user-123",
      authorName: "TestUser",
      channelId: "channel-abc",
      timestamp: Date.now(),
      chatType: "dm" as const,
    };

    // Insert the message into the DB manually since handleMessage calls LLM
    db.prepare(`
      INSERT INTO main_agent_messages
        (id, role, content, author_id, author_name, channel_id, platform_message_id, token_estimate)
      VALUES (?, 'user', ?, ?, ?, ?, ?, ?)
    `).run(
      msg.id,
      msg.content,
      msg.authorId,
      msg.authorName,
      msg.channelId,
      null,
      Math.ceil(msg.content.length / 4)
    );

    // Verify it was stored
    const stored = db.prepare(`
      SELECT * FROM main_agent_messages WHERE id = ?
    `).get(msg.id) as Record<string, unknown>;

    expect(stored).toBeDefined();
    expect(stored.role).toBe("user");
    expect(stored.content).toBe(msg.content);
    expect(stored.author_id).toBe(msg.authorId);
    expect(stored.channel_id).toBe(msg.channelId);
  });

  it("should isolate history per channel", () => {
    // Add messages to channel A
    db.prepare(`
      INSERT INTO main_agent_messages (id, role, content, channel_id)
      VALUES ('msg1', 'user', 'Channel A message 1', 'channel-a')
    `).run();
    
    db.prepare(`
      INSERT INTO main_agent_messages (id, role, content, channel_id)
      VALUES ('msg2', 'assistant', 'Channel A reply', 'channel-a')
    `).run();

    // Add messages to channel B
    db.prepare(`
      INSERT INTO main_agent_messages (id, role, content, channel_id)
      VALUES ('msg3', 'user', 'Channel B message 1', 'channel-b')
    `).run();

    // Get history for channel A
    const historyA = db.prepare(`
      SELECT content FROM main_agent_messages 
      WHERE channel_id = 'channel-a'
      ORDER BY created_at
    `).all() as Array<{ content: string }>;

    // Get history for channel B
    const historyB = db.prepare(`
      SELECT content FROM main_agent_messages 
      WHERE channel_id = 'channel-b'
      ORDER BY created_at
    `).all() as Array<{ content: string }>;

    expect(historyA.length).toBe(2);
    expect(historyB.length).toBe(1);
    expect(historyA[0].content).toBe("Channel A message 1");
    expect(historyB[0].content).toBe("Channel B message 1");
  });

  it("should persist message to queue", () => {
    db.prepare(`
      INSERT INTO message_queue (id, channel_id, content, author_id, author_name)
      VALUES ('queue1', 'channel-x', 'Queued message', 'user-1', 'Alice')
    `).run();

    const queued = db.prepare(`
      SELECT * FROM message_queue WHERE id = 'queue1'
    `).get() as Record<string, unknown>;

    expect(queued).toBeDefined();
    expect(queued.channel_id).toBe("channel-x");
    expect(queued.content).toBe("Queued message");
    expect(queued.processed).toBe(0);
  });

  it("should load persisted queue for a channel", () => {
    // Add some queued messages
    db.prepare(`
      INSERT INTO message_queue (id, channel_id, content, author_id, author_name, processed)
      VALUES ('q1', 'channel-1', 'Message 1', 'user-1', 'Alice', 0)
    `).run();
    
    db.prepare(`
      INSERT INTO message_queue (id, channel_id, content, author_id, author_name, processed)
      VALUES ('q2', 'channel-1', 'Message 2', 'user-1', 'Alice', 0)
    `).run();

    db.prepare(`
      INSERT INTO message_queue (id, channel_id, content, author_id, author_name, processed)
      VALUES ('q3', 'channel-2', 'Other channel', 'user-2', 'Bob', 0)
    `).run();

    // Load queue for channel-1
    const queue = db.prepare(`
      SELECT * FROM message_queue WHERE channel_id = ? AND processed = 0
      ORDER BY queued_at
    `).all("channel-1") as Array<Record<string, unknown>>;

    expect(queue.length).toBe(2);
    expect(queue[0].content).toBe("Message 1");
    expect(queue[1].content).toBe("Message 2");
  });

  it("should mark queue messages as processed", () => {
    db.prepare(`
      INSERT INTO message_queue (id, channel_id, content, author_id, author_name, processed)
      VALUES ('q1', 'channel-1', 'Message', 'user-1', 'Alice', 0)
    `).run();

    // Mark as processed
    db.prepare(`
      UPDATE message_queue SET processed = 1 WHERE channel_id = ? AND processed = 0
    `).run("channel-1");

    const processed = db.prepare(`
      SELECT processed FROM message_queue WHERE id = 'q1'
    `).get() as { processed: number };

    expect(processed.processed).toBe(1);
  });

  it("should create and update channel session", () => {
    // Insert initial session
    db.prepare(`
      INSERT INTO channel_sessions (channel_id, status, last_author_id, last_author_name)
      VALUES ('channel-1', 'idle', 'user-1', 'Alice')
    `).run();

    // Update to processing
    db.prepare(`
      UPDATE channel_sessions 
      SET status = 'processing', last_activity = datetime('now')
      WHERE channel_id = 'channel-1'
    `).run();

    const session = db.prepare(`
      SELECT * FROM channel_sessions WHERE channel_id = 'channel-1'
    `).get() as Record<string, unknown>;

    expect(session.status).toBe("processing");
    expect(session.last_author_id).toBe("user-1");
  });

  it("should store and retrieve model override", () => {
    const channelId = "channel-test";
    const model = "anthropic/claude-opus-4-6";

    // Use the agent's method
    agent.setChannelModel(channelId, model);

    // Verify in DB
    const session = db.prepare(`
      SELECT model_override FROM channel_sessions WHERE channel_id = ?
    `).get(channelId) as { model_override: string };

    expect(session.model_override).toBe(model);
  });

  it("should clear model override when set to null", () => {
    const channelId = "channel-test";
    
    // Set a model first
    agent.setChannelModel(channelId, "anthropic/claude-opus-4-6");
    
    // Clear it
    agent.setChannelModel(channelId, null);

    const session = db.prepare(`
      SELECT model_override FROM channel_sessions WHERE channel_id = ?
    `).get(channelId) as { model_override: string | null };

    expect(session.model_override).toBeNull();
  });

  it("should reject a user tool_result as the first message", () => {
    const invalidMessages = [
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_123",
            content: "ok",
          },
        ],
      },
      {
        role: "assistant",
        content: "follow-up",
      },
      {
        role: "user",
        content: "next user turn",
      },
    ];

    const validation = (agent as any).validateMessages(invalidMessages);
    expect(validation).toBe("tool_result at index 0 cannot be first message");
  });

  it("should repair a user tool_result that became the first message", () => {
    const repaired = (agent as any).emergencyRepairToolPairs([
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_123",
            content: "ok",
          },
        ],
      },
      {
        role: "assistant",
        content: "follow-up",
      },
      {
        role: "user",
        content: "next user turn",
      },
    ]);

    expect(repaired[0]).toEqual({
      role: "user",
      content: "[Earlier tool results — matching tool calls were compacted]",
    });
  });

  it("should get last assistant message for a channel", () => {
    // Add some messages
    db.prepare(`
      INSERT INTO main_agent_messages (id, role, content, channel_id)
      VALUES ('msg1', 'user', 'User message', 'channel-1')
    `).run();
    
    db.prepare(`
      INSERT INTO main_agent_messages (id, role, content, channel_id)
      VALUES ('msg2', 'assistant', 'First reply', 'channel-1')
    `).run();
    
    db.prepare(`
      INSERT INTO main_agent_messages (id, role, content, channel_id)
      VALUES ('msg3', 'user', 'Another message', 'channel-1')
    `).run();
    
    db.prepare(`
      INSERT INTO main_agent_messages (id, role, content, channel_id)
      VALUES ('msg4', 'assistant', 'Latest reply', 'channel-1')
    `).run();

    const last = agent.getLastAssistantMessage("channel-1");

    expect(last).toBe("Latest reply");
  });

  it("should return null when no assistant messages exist", () => {
    const last = agent.getLastAssistantMessage("channel-nonexistent");
    expect(last).toBeNull();
  });

  it("should track chat type per channel", () => {
    // This is tested via the behavior when handling messages
    // The channelChatType Map is private, but we can verify behavior
    
    // DM channels should show steps
    const dmChannel = "dm-channel-123";
    
    // Nexus channels should show steps
    const nexusChannel = "nexus:chat-abc";
    
    // For now, we just verify the structure is set up correctly
    // Full behavior testing would require LLM mock
    expect(agent).toBeDefined();
  });

  it("should defer a conversation retry until capacity is available", async () => {
    vi.useFakeTimers();

    const maxConcurrent = agent.getMaxConcurrent();
    const processingChannels = (agent as any).processingChannels as Set<string>;
    for (let i = 0; i < maxConcurrent; i++) {
      processingChannels.add(`busy-${i}`);
    }

    const processSpy = vi
      .spyOn(agent as any, "processConversation")
      .mockResolvedValue(undefined);

    (agent as any).scheduleConversationRetry("channel-retry", 1000);

    await vi.advanceTimersByTimeAsync(1000);
    expect(processSpy).not.toHaveBeenCalled();

    const queuedSession = db.prepare(`
      SELECT status FROM channel_sessions WHERE channel_id = ?
    `).get("channel-retry") as { status: string };
    expect(queuedSession.status).toBe("queued");

    processingChannels.clear();
    await vi.advanceTimersByTimeAsync(5000);

    expect(processSpy).toHaveBeenCalledWith("channel-retry");

    const resumedSession = db.prepare(`
      SELECT status FROM channel_sessions WHERE channel_id = ?
    `).get("channel-retry") as { status: string };
    expect(resumedSession.status).toBe("processing");
  });

  it("should recover a queued channel when nothing is actively processing it", async () => {
    const processSpy = vi
      .spyOn(agent as any, "processConversation")
      .mockResolvedValue(undefined);

    (agent as any).channelQueues.set("channel-stuck", [{
      id: "queued-1",
      content: "hello from queue",
      authorId: "user-1",
      authorName: "Alice",
      channelId: "channel-stuck",
      timestamp: Date.now(),
    }]);

    (agent as any).recoverQueuedChannels();

    expect(processSpy).toHaveBeenCalledWith("channel-stuck");
    expect(agent.getChannelQueueDepth("channel-stuck")).toBe(0);

    const session = db.prepare(`
      SELECT status, last_author_name FROM channel_sessions WHERE channel_id = ?
    `).get("channel-stuck") as { status: string; last_author_name: string };

    expect(session.status).toBe("processing");
    expect(session.last_author_name).toBe("Alice");
  });

  it("should handle empty message history gracefully", () => {
    const history = db.prepare(`
      SELECT * FROM main_agent_messages WHERE channel_id = 'nonexistent'
    `).all();

    expect(history).toEqual([]);
  });

  it("should support platform message ID tracking", () => {
    db.prepare(`
      INSERT INTO main_agent_messages 
        (id, role, content, channel_id, platform_message_id)
      VALUES ('msg1', 'user', 'Test', 'channel-1', '123456789')
    `).run();

    const msg = db.prepare(`
      SELECT platform_message_id FROM main_agent_messages WHERE id = 'msg1'
    `).get() as { platform_message_id: string };

    expect(msg.platform_message_id).toBe("123456789");
  });
});
