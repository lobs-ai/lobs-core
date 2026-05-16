import { describe, it, expect, beforeEach } from "vitest";
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
  getAgentMemoryDir,
  getAgentCompliantMemoryDir,
  getAgentSessionsDir,
} from "./lobs.js";

describe("lobs config", () => {
  it("getLobsRoot returns a non-empty path", () => {
    const root = getLobsRoot();
    expect(root).toBeTruthy();
    expect(root.length).toBeGreaterThan(0);
  });

  it("getAgentsRoot returns a subdirectory of lobsRoot", () => {
    const root = getLobsRoot();
    const agentsRoot = getAgentsRoot();
    expect(agentsRoot.startsWith(root)).toBe(true);
  });

  it("getAgentDir returns a path for any agent type", () => {
    const dir = getAgentDir("programmer");
    expect(dir).toContain("programmer");
  });

  it("getServerPort returns a number", () => {
    const port = getServerPort();
    expect(typeof port).toBe("number");
    expect(port).toBeGreaterThan(0);
  });

  it("loadLobsConfig returns an object", () => {
    const config = loadLobsConfig();
    expect(typeof config).toBe("object");
  });

  it("getGatewayConfig returns expected shape", () => {
    const gw = getGatewayConfig();
    expect(typeof gw.port).toBe("number");
    expect(typeof gw.token).toBe("string");
  });
});
