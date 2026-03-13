/**
 * Test the context engine — classification, budgeting, and assembly.
 * Run: npx vitest tests/context-engine-test.ts
 */

import { describe, it, expect } from "vitest";
import { classifyTask, allocateBudget, assembleContext } from "../src/runner/index.js";

describe("Context Engine - Task Classifier", () => {
  it("should classify debugging tasks correctly", () => {
    const result = classifyTask("Fix the auth bug in paw-hub where login fails after token expiry");
    expect(result.taskType).toBe("debugging");
    expect(result.confidence).toBeGreaterThan(0.5);
  });

  it("should classify architecture tasks correctly", () => {
    const result = classifyTask("Design the new handoff architecture for multi-agent context sharing");
    expect(result.taskType).toBe("architecture");
    expect(result.confidence).toBeGreaterThan(0.5);
  });

  it("should classify review tasks correctly", () => {
    const result = classifyTask("Review PR #42 for the lobs-memory reranker changes");
    expect(result.taskType).toBe("review");
    expect(result.confidence).toBeGreaterThan(0.5);
  });

  it("should classify research tasks correctly", () => {
    const result = classifyTask("Research options for graph databases vs SQLite for entity storage");
    expect(result.taskType).toBe("research");
    expect(result.confidence).toBeGreaterThan(0.5);
  });

  it("should classify documentation tasks correctly", () => {
    const result = classifyTask("Write documentation for the agent runner API");
    expect(result.taskType).toBe("documentation");
    expect(result.confidence).toBeGreaterThan(0.5);
  });

  it("should classify devops tasks correctly", () => {
    const result = classifyTask("Set up CI/CD pipeline with Docker for paw-hub deployment");
    expect(result.taskType).toBe("devops");
    expect(result.confidence).toBeGreaterThan(0.5);
  });

  it("should classify coding tasks correctly", () => {
    const result = classifyTask("Implement the web_fetch tool for the agent runner");
    expect(result.taskType).toBe("coding");
    expect(result.confidence).toBeGreaterThan(0.5);
  });

  it("should classify general questions as conversation", () => {
    const result = classifyTask("How does the context engine work?");
    expect(result.taskType).toBe("conversation");
  });

  it("should extract file entities from task", () => {
    const result = classifyTask("Fix bug in auth-middleware.ts and update config.json");
    expect(result.entities).toContain("auth-middleware.ts");
    expect(result.entities).toContain("config.json");
  });

  it("should detect project from keywords", () => {
    const result = classifyTask("Fix paw-hub authentication");
    expect(result.project).toBeDefined();
  });

  it("should extract meaningful topics", () => {
    const result = classifyTask("Implement the handoff logic for multi-agent coordination");
    expect(result.topic).toBeTruthy();
    expect(result.topic.length).toBeGreaterThan(3);
  });

  it("should handle tasks with multiple indicators", () => {
    const result = classifyTask("Debug and fix the broken test in auth.test.ts");
    // Should recognize both debugging and test/code patterns
    expect(["debugging", "coding"]).toContain(result.taskType);
  });

  it("should classify error-related tasks as debugging", () => {
    const result = classifyTask("The server crashes on startup, need to fix this");
    expect(result.taskType).toBe("debugging");
  });

  it("should classify comparison tasks as research", () => {
    const result = classifyTask("Compare PostgreSQL vs MongoDB for this use case");
    expect(result.taskType).toBe("research");
  });
});

describe("Context Engine - Budget Allocator", () => {
  const maxTokens = 8000;

  it("should allocate budget for coding tasks", () => {
    const budget = allocateBudget("coding", maxTokens);
    expect(budget.total).toBe(maxTokens);
    // Coding tasks should prioritize code context
    expect(budget.allocations.code).toBeGreaterThan(budget.allocations.memory);
    expect(budget.allocations.code).toBeGreaterThan(budget.allocations.session);
  });

  it("should allocate budget for architecture tasks", () => {
    const budget = allocateBudget("architecture", maxTokens);
    // Architecture tasks should prioritize project docs and memory
    expect(budget.allocations.project).toBeGreaterThan(budget.allocations.code);
    expect(budget.allocations.memory).toBeGreaterThan(budget.allocations.session);
  });

  it("should allocate budget for research tasks", () => {
    const budget = allocateBudget("research", maxTokens);
    // Research tasks need more memory and project context
    expect(budget.allocations.memory).toBeGreaterThan(0);
    expect(budget.allocations.project).toBeGreaterThan(0);
  });

  it("should allocate budget for debugging tasks", () => {
    const budget = allocateBudget("debugging", maxTokens);
    // Debugging needs lots of code context
    expect(budget.allocations.code).toBeGreaterThan(budget.allocations.project);
  });

  it("should ensure all allocations sum to approximately total", () => {
    const budget = allocateBudget("coding", maxTokens);
    const sum = Object.values(budget.allocations).reduce((a, b) => a + b, 0);
    // Allow some rounding variance
    expect(Math.abs(sum - maxTokens)).toBeLessThan(50);
  });

  it("should respect custom max tokens", () => {
    const customMax = 12000;
    const budget = allocateBudget("coding", customMax);
    expect(budget.total).toBe(customMax);
    const sum = Object.values(budget.allocations).reduce((a, b) => a + b, 0);
    expect(sum).toBeLessThanOrEqual(customMax + 50);
  });

  it("should allocate all categories for all task types", () => {
    const types = ["coding", "debugging", "architecture", "review", "research", "documentation", "devops", "conversation"] as const;
    
    for (const type of types) {
      const budget = allocateBudget(type, maxTokens);
      expect(budget.allocations.memory).toBeGreaterThan(0);
      expect(budget.allocations.project).toBeGreaterThan(0);
      expect(budget.allocations.code).toBeGreaterThan(0);
      expect(budget.allocations.session).toBeGreaterThan(0);
      expect(budget.allocations.instructions).toBeGreaterThan(0);
    }
  });

  it("should prioritize conversation tasks differently", () => {
    const budget = allocateBudget("conversation", maxTokens);
    // Conversation tasks should prioritize memory and session
    expect(budget.allocations.memory + budget.allocations.session)
      .toBeGreaterThan(budget.allocations.code);
  });
});

describe("Context Engine - Assembly", () => {
  it.skip("should assemble context with lobs-memory (requires server)", async () => {
    // This test requires lobs-memory to be running
    // Skip by default, run manually when testing integration

    // Check if lobs-memory is running
    let memoryAvailable = false;
    try {
      const check = await fetch("http://localhost:7420/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: "test", maxResults: 1 }),
        signal: AbortSignal.timeout(3000),
      });
      memoryAvailable = check.ok;
    } catch {
      memoryAvailable = false;
    }

    if (!memoryAvailable) {
      console.log("⚠️ lobs-memory not running — skipping assembly test");
      return;
    }

    const context = await assembleContext({
      task: "Fix the auth middleware in paw-hub to properly handle token refresh",
      agentType: "programmer",
      projectId: "paw-hub",
    });

    expect(context.classification).toBeDefined();
    expect(context.classification.taskType).toBe("debugging");
    expect(context.budget.total).toBeGreaterThan(0);
    expect(context.layers).toBeDefined();
    expect(context.layers.length).toBeGreaterThan(0);
  });

  it("should assemble context even without lobs-memory", async () => {
    const context = await assembleContext({
      task: "Write a simple hello world function",
      agentType: "programmer",
      config: {
        memorySearchUrl: "http://localhost:99999", // non-existent server
        maxContextTokens: 8000,
        projects: [],
      },
    });

    // Should not crash, just return empty layers
    expect(context.classification).toBeDefined();
    expect(context.classification.taskType).toBe("coding");
    expect(context.budget.total).toBe(8000);
    expect(context.layers).toBeDefined();
  });

  it("should include context block when layers have content", async () => {
    const context = await assembleContext({
      task: "Test task",
      agentType: "programmer",
    });

    // Context block should be defined (may be empty if no memory available)
    expect(typeof context.contextBlock).toBe("string");
  });

  it("should respect project scoping", async () => {
    const context = await assembleContext({
      task: "Fix bug in authentication",
      agentType: "programmer",
      projectId: "paw-hub",
    });

    expect(context.classification.project).toBe("paw-hub");
  });

  it("should handle context refs", async () => {
    const context = await assembleContext({
      task: "Review this code",
      agentType: "reviewer",
      contextRefs: ["/nonexistent/file.ts"], // Won't exist, but shouldn't crash
    });

    expect(context.classification).toBeDefined();
  });

  it("should adapt budget based on agent type", async () => {
    const architectContext = await assembleContext({
      task: "Design the system",
      agentType: "architect",
    });

    expect(architectContext.classification.taskType).toBe("architecture");
    
    const programmerContext = await assembleContext({
      task: "Design the system",
      agentType: "programmer",
    });

    // Architect should get different budget than programmer for same task
    expect(architectContext.budget.allocations.project)
      .toBeGreaterThan(programmerContext.budget.allocations.project);
  });

  it("should include classification metadata in context block", async () => {
    const context = await assembleContext({
      task: "Test task for metadata",
      agentType: "researcher",
    });

    if (context.contextBlock.length > 0) {
      // Should include HTML comment with metadata
      expect(context.contextBlock).toContain("context-engine:");
    }
  });
});
