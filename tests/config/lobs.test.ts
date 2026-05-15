import { describe, expect, test, beforeEach } from "vitest";
import {
  getLobsRoot,
  getLobsConfigPath,
  loadLobsConfig,
  getGatewayConfig,
  getServerPort,
  getSubagentRunsPath,
  getAgentsRoot,
  getAgentDir,
  getAgentContextDir,
  getAgentMentionNames,
  resetAgentMentionCache,
  getAgentMemoryDir,
  getAgentCompliantMemoryDir,
  getAgentSessionsDir,
} from "../../src/config/lobs.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { env } from "node:process";

describe("lobs config path utilities", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "lobs-test-"));
    resetAgentMentionCache();
  });

  describe("getLobsRoot", () => {
    test("returns LOBS_ROOT env var when set", () => {
      env.LOBS_ROOT = join(tmp, "custom-root");
      try {
        expect(getLobsRoot()).toBe(join(tmp, "custom-root"));
      } finally {
        delete env.LOBS_ROOT;
      }
    });

    test("falls back to HOME/.lobs when LOBS_ROOT not set", () => {
      delete env.LOBS_ROOT;
      const home = env.HOME ?? "";
      expect(getLobsRoot()).toBe(join(home, ".lobs"));
    });
  });

  describe("getLobsConfigPath", () => {
    test("returns LOBS_CONFIG env var when set", () => {
      env.LOBS_CONFIG = join(tmp, "custom-config.json");
      try {
        expect(getLobsConfigPath()).toBe(join(tmp, "custom-config.json"));
      } finally {
        delete env.LOBS_CONFIG;
      }
    });

    test("defaults to {LOBS_ROOT}/config/lobs.json", () => {
      env.LOBS_ROOT = join(tmp, "myroot");
      delete env.LOBS_CONFIG;
      try {
        expect(getLobsConfigPath()).toBe(join(tmp, "myroot", "config", "lobs.json"));
      } finally {
        delete env.LOBS_ROOT;
      }
    });
  });

  describe("loadLobsConfig", () => {
    test("returns empty object when config file does not exist", () => {
      env.LOBS_ROOT = tmp;
      delete env.LOBS_CONFIG;
      try {
        expect(loadLobsConfig()).toEqual({});
      } finally {
        delete env.LOBS_ROOT;
      }
    });

    test("parses valid config file", () => {
      env.LOBS_ROOT = tmp;
      delete env.LOBS_CONFIG;
      try {
        mkdirSync(join(tmp, "config"), { recursive: true });
        writeFileSync(join(tmp, "config", "lobs.json"), JSON.stringify({
          server: { port: 9999 },
          gateway: { port: 12345, auth: { token: "secret" } },
        }));
        const config = loadLobsConfig();
        expect(config.server?.port).toBe(9999);
        expect(config.gateway?.port).toBe(12345);
        expect(config.gateway?.auth?.token).toBe("secret");
      } finally {
        delete env.LOBS_ROOT;
      }
    });

    test("returns empty object on malformed JSON", () => {
      env.LOBS_ROOT = tmp;
      delete env.LOBS_CONFIG;
      try {
        mkdirSync(join(tmp, "config"), { recursive: true });
        writeFileSync(join(tmp, "config", "lobs.json"), "{ not json }");
        expect(loadLobsConfig()).toEqual({});
      } finally {
        delete env.LOBS_ROOT;
      }
    });
  });

  describe("getGatewayConfig", () => {
    test("returns token from config file", () => {
      env.LOBS_ROOT = tmp;
      delete env.LOBS_CONFIG;
      try {
        mkdirSync(join(tmp, "config"), { recursive: true });
        writeFileSync(join(tmp, "config", "lobs.json"), JSON.stringify({
          gateway: { port: 9999, auth: { token: "tok123" } },
        }));
        const result = getGatewayConfig();
        expect(result.port).toBe(9999);
        expect(result.token).toBe("tok123");
      } finally {
        delete env.LOBS_ROOT;
      }
    });

    test("uses defaults when no config file", () => {
      env.LOBS_ROOT = tmp;
      delete env.LOBS_CONFIG;
      try {
        const result = getGatewayConfig();
        expect(result.port).toBe(18789);
        expect(result.token).toBe("");
      } finally {
        delete env.LOBS_ROOT;
      }
    });
  });

  describe("getServerPort", () => {
    test("prefers LOBS_PORT env var", () => {
      env.LOBS_PORT = "5555";
      env.LOBS_ROOT = tmp;
      delete env.LOBS_CONFIG;
      try {
        expect(getServerPort()).toBe(5555);
      } finally {
        delete env.LOBS_PORT;
        delete env.LOBS_ROOT;
      }
    });

    test("falls back to config file port", () => {
      env.LOBS_ROOT = tmp;
      delete env.LOBS_PORT;
      delete env.LOBS_CONFIG;
      try {
        mkdirSync(join(tmp, "config"), { recursive: true });
        writeFileSync(join(tmp, "config", "lobs.json"), JSON.stringify({
          server: { port: 7331 },
        }));
        expect(getServerPort()).toBe(7331);
      } finally {
        delete env.LOBS_ROOT;
      }
    });

    test("defaults to 9420", () => {
      env.LOBS_ROOT = tmp;
      delete env.LOBS_PORT;
      delete env.LOBS_CONFIG;
      try {
        expect(getServerPort()).toBe(9420);
      } finally {
        delete env.LOBS_ROOT;
      }
    });

    test("treats non-numeric LOBS_PORT as invalid and falls back", () => {
      env.LOBS_PORT = "not-a-number";
      env.LOBS_ROOT = tmp;
      delete env.LOBS_CONFIG;
      try {
        mkdirSync(join(tmp, "config"), { recursive: true });
        writeFileSync(join(tmp, "config", "lobs.json"), JSON.stringify({
          server: { port: 1234 },
        }));
        expect(getServerPort()).toBe(1234);
      } finally {
        delete env.LOBS_PORT;
        delete env.LOBS_ROOT;
      }
    });
  });

  describe("getSubagentRunsPath", () => {
    test("returns {LOBS_ROOT}/subagents/runs.json", () => {
      env.LOBS_ROOT = tmp;
      delete env.LOBS_CONFIG;
      try {
        expect(getSubagentRunsPath()).toBe(join(tmp, "subagents", "runs.json"));
      } finally {
        delete env.LOBS_ROOT;
      }
    });
  });

  describe("getAgentsRoot", () => {
    test("returns {LOBS_ROOT}/agents", () => {
      env.LOBS_ROOT = tmp;
      delete env.LOBS_CONFIG;
      try {
        expect(getAgentsRoot()).toBe(join(tmp, "agents"));
      } finally {
        delete env.LOBS_ROOT;
      }
    });
  });

  describe("getAgentDir", () => {
    test("returns {LOBS_ROOT}/agents/{agentType}", () => {
      env.LOBS_ROOT = tmp;
      delete env.LOBS_CONFIG;
      try {
        expect(getAgentDir("programmer")).toBe(join(tmp, "agents", "programmer"));
      } finally {
        delete env.LOBS_ROOT;
      }
    });
  });

  describe("getAgentContextDir", () => {
    test("returns {LOBS_ROOT}/agents/{agentType}/context", () => {
      env.LOBS_ROOT = tmp;
      delete env.LOBS_CONFIG;
      try {
        expect(getAgentContextDir("reviewer")).toBe(join(tmp, "agents", "reviewer", "context"));
      } finally {
        delete env.LOBS_ROOT;
      }
    });
  });

  describe("getAgentMentionNames", () => {
    test("falls back to 'lobs' when no identity.json or env var", () => {
      env.LOBS_ROOT = tmp;
      delete env.LOBS_CONFIG;
      delete env.AGENT_NAME;
      try {
        resetAgentMentionCache();
        expect(getAgentMentionNames()).toEqual(["lobs"]);
      } finally {
        delete env.LOBS_ROOT;
      }
    });

    test("uses AGENT_NAME env var as fallback", () => {
      env.LOBS_ROOT = tmp;
      delete env.LOBS_CONFIG;
      env.AGENT_NAME = "my-agent";
      try {
        resetAgentMentionCache();
        expect(getAgentMentionNames()).toEqual(["my-agent"]);
      } finally {
        delete env.AGENT_NAME;
        delete env.LOBS_ROOT;
      }
    });

    test("reads bot.name and bot.id from identity.json", () => {
      env.LOBS_ROOT = tmp;
      delete env.LOBS_CONFIG;
      delete env.AGENT_NAME;
      try {
        mkdirSync(join(tmp, "config"), { recursive: true });
        writeFileSync(join(tmp, "config", "identity.json"), JSON.stringify({
          bot: { name: "LobsBot", id: "123456" },
        }));
        resetAgentMentionCache();
        const names = getAgentMentionNames();
        expect(names).toContain("lobsbot");
        expect(names).toContain("123456");
      } finally {
        delete env.LOBS_ROOT;
      }
    });

    test("caches result and returns same array on subsequent calls", () => {
      env.LOBS_ROOT = tmp;
      delete env.LOBS_CONFIG;
      delete env.AGENT_NAME;
      try {
        resetAgentMentionCache();
        const first = getAgentMentionNames();
        const second = getAgentMentionNames();
        expect(first).toBe(second); // same reference
      } finally {
        delete env.LOBS_ROOT;
      }
    });

    test("resetAgentMentionCache clears the cache", () => {
      env.LOBS_ROOT = tmp;
      delete env.LOBS_CONFIG;
      delete env.AGENT_NAME;
      try {
        resetAgentMentionCache();
        const first = getAgentMentionNames();
        env.AGENT_NAME = "new-agent";
        resetAgentMentionCache();
        const second = getAgentMentionNames();
        expect(second).toContain("new-agent");
      } finally {
        delete env.AGENT_NAME;
        delete env.LOBS_ROOT;
      }
    });
  });

  describe("getAgentMemoryDir", () => {
    test("returns {LOBS_ROOT}/agents/{agentType}/context/memory", () => {
      env.LOBS_ROOT = tmp;
      delete env.LOBS_CONFIG;
      try {
        expect(getAgentMemoryDir("writer")).toBe(join(tmp, "agents", "writer", "context", "memory"));
      } finally {
        delete env.LOBS_ROOT;
      }
    });
  });

  describe("getAgentCompliantMemoryDir", () => {
    test("returns {LOBS_ROOT}/agents/{agentType}/context/memory-compliant", () => {
      env.LOBS_ROOT = tmp;
      delete env.LOBS_CONFIG;
      try {
        expect(getAgentCompliantMemoryDir("architect")).toBe(join(tmp, "agents", "architect", "context", "memory-compliant"));
      } finally {
        delete env.LOBS_ROOT;
      }
    });
  });

  describe("getAgentSessionsDir", () => {
    test("returns {LOBS_ROOT}/agents/{agentType}/sessions", () => {
      env.LOBS_ROOT = tmp;
      delete env.LOBS_CONFIG;
      try {
        expect(getAgentSessionsDir("researcher")).toBe(join(tmp, "agents", "researcher", "sessions"));
      } finally {
        delete env.LOBS_ROOT;
      }
    });
  });
});