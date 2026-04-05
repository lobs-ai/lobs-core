/**
 * tool_manage — agent-facing tool for creating, editing, deleting, and listing dynamic tools.
 *
 * Dynamic tools are stored in ~/.lobs/tools/{name}/ and persist across sessions.
 */

import { existsSync, mkdirSync, writeFileSync, rmSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ToolDefinition } from "../types.js";
import type { ToolExecutor } from "./index.js";
import { securityScan } from "./tool-security.js";
import { getDynamicToolLoader, type ToolJson } from "./dynamic-tools.js";
import { getToolManager } from "./tool-manager.js";
import type { ToolName } from "../types.js";

// Built-in tool names that cannot be overridden
const BUILTIN_TOOL_NAMES = new Set([
  "exec", "read", "write", "edit", "ls", "grep", "glob", "find_files",
  "code_search", "web_search", "web_fetch", "memory_search", "memory_read",
  "memory_write", "spawn_agent", "run_pipeline", "list_agents", "check_agents",
  "message_agent", "stop_agent", "cron", "discord", "process", "humanize",
  "imagine", "html_to_pdf", "dispatch_agent", "tool_manage",
]);

const NAME_PATTERN = /^[a-z][a-z0-9-]*$/;

export const toolManageDefinition: ToolDefinition = {
  name: "tool_manage",
  description:
    "Create, edit, delete, or list dynamic tools, and enable/disable built-in tools at runtime. " +
    "Dynamic tools are stored in ~/.lobs/tools/ and persist across sessions. " +
    "Use 'create' to make a new tool with a shell script, TypeScript module, or procedural steps. " +
    "Use 'list' to see all dynamic tools. " +
    "Use 'edit' to modify an existing tool. " +
    "Use 'delete' to remove a tool. " +
    "Use 'enable' or 'disable' to toggle built-in tools at runtime (e.g., enable discord for Nexus sessions). " +
    "Use 'list_disabled' to see which tools are currently disabled.\n\n" +
    "**Built-in tools that can be enabled on demand:**\n" +
    "- **discord** — Manage your Discord server: channels (create, edit, delete, permissions), " +
    "threads (archive, lock, unlock, edit, delete), messages (edit, pin, bulk delete), " +
    "webhooks (create, post with embeds/files), and guild info (members, roles). " +
    "Says things like 'enable discord so I can create a #feedback channel' or " +
    "'enable discord, then create a webhook on #announcements called Events'.\n" +
    "Enable it whenever you need to manage Discord — enable it before the task, " +
    "disable it after if you want to keep the prompt clean again.",
  input_schema: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["create", "edit", "delete", "list", "enable", "disable", "list_disabled"],
        description: "Action to perform",
      },
      name: {
        type: "string",
        description:
          "Tool name (required for create/edit/delete). Must be lowercase, alphanumeric with hyphens.",
      },
      description: {
        type: "string",
        description: "Tool description (required for create)",
      },
      implementation: {
        type: "string",
        enum: ["shell", "typescript", "procedural"],
        description: "Implementation type (required for create)",
      },
      code: {
        type: "string",
        description:
          "Implementation code/content (required for create, optional for edit)",
      },
      input_schema: {
        type: "object",
        description: "JSON Schema for tool parameters (required for create)",
      },
      field: {
        type: "string",
        enum: ["description", "code", "input_schema"],
        description: "Field to update (required for edit)",
      },
      value: {
        type: "string",
        description: "New value for the field (required for edit)",
      },
    },
    required: ["action"],
  },
};

export const toolManageTool: ToolExecutor = async (params) => {
  const action = params.action as string;

  switch (action) {
    case "create":
      return handleCreate(params);
    case "edit":
      return handleEdit(params);
    case "delete":
      return handleDelete(params);
    case "list":
      return handleList();
    case "enable":
      return handleEnable(params);
    case "disable":
      return handleDisable(params);
    case "list_disabled":
      return handleListDisabled();
    default:
      return `Unknown action: ${action}. Valid actions: create, edit, delete, list, enable, disable, list_disabled`;
  }
};

// ─── action handlers ──────────────────────────────────────────────────────────

function handleCreate(params: Record<string, unknown>): string {
  const name = params.name as string | undefined;
  const description = params.description as string | undefined;
  const implementation = params.implementation as "shell" | "typescript" | "procedural" | undefined;
  const code = params.code as string | undefined;
  const inputSchema = params.input_schema as Record<string, unknown> | undefined;

  // Validate required fields
  if (!name) return "Error: 'name' is required for create";
  if (!description) return "Error: 'description' is required for create";
  if (!implementation) return "Error: 'implementation' is required for create";
  if (!code) return "Error: 'code' is required for create";
  if (!inputSchema) return "Error: 'input_schema' is required for create";

  // Validate name format
  if (!NAME_PATTERN.test(name)) {
    return `Error: invalid tool name '${name}'. Must be lowercase, start with a letter, and contain only alphanumeric characters and hyphens.`;
  }

  // Prevent shadowing built-in tools
  if (BUILTIN_TOOL_NAMES.has(name)) {
    return `Error: '${name}' conflicts with a built-in tool name and cannot be used.`;
  }

  // Security scan
  const scanType = implementation === "shell" ? "shell" : "typescript";
  if (implementation !== "procedural") {
    const scan = securityScan(code, scanType);
    if (!scan.pass) {
      return `Error: security scan failed:\n${scan.errors.map((e) => `  - ${e}`).join("\n")}`;
    }
  }

  const loader = getDynamicToolLoader();
  if (!loader) return "Error: dynamic tool loader not initialized";

  // Check for existing tool
  const toolDir = loader.getToolDir(name);
  if (existsSync(toolDir)) {
    return `Error: tool '${name}' already exists. Use 'edit' to modify it.`;
  }

  // Write files
  mkdirSync(toolDir, { recursive: true });

  const toolJson: ToolJson = {
    name,
    description,
    input_schema: inputSchema,
    implementation,
    created_at: new Date().toISOString(),
    created_by: "main",
    version: 1,
  };

  writeFileSync(join(toolDir, "tool.json"), JSON.stringify(toolJson, null, 2), "utf-8");

  const implFile = getImplFile(implementation);
  writeFileSync(join(toolDir, implFile), code, "utf-8");

  // Hot-register
  loader.register(name, toolJson, toolDir);

  return `Tool '${name}' created successfully (${implementation} implementation).\nDirectory: ${toolDir}`;
}

function handleEdit(params: Record<string, unknown>): string {
  const name = params.name as string | undefined;
  const field = params.field as "description" | "code" | "input_schema" | undefined;
  const value = params.value as string | undefined;

  if (!name) return "Error: 'name' is required for edit";
  if (!field) return "Error: 'field' is required for edit";
  if (value === undefined || value === null) return "Error: 'value' is required for edit";

  const loader = getDynamicToolLoader();
  if (!loader) return "Error: dynamic tool loader not initialized";

  const toolDir = loader.getToolDir(name);
  const toolJsonPath = join(toolDir, "tool.json");

  if (!existsSync(toolJsonPath)) {
    return `Error: tool '${name}' not found`;
  }

  const toolJson = JSON.parse(readFileSync(toolJsonPath, "utf-8")) as ToolJson;

  switch (field) {
    case "description": {
      toolJson.description = value;
      toolJson.version += 1;
      writeFileSync(toolJsonPath, JSON.stringify(toolJson, null, 2), "utf-8");
      loader.register(name, toolJson, toolDir);
      return `Tool '${name}' description updated.`;
    }

    case "code": {
      const scanType = toolJson.implementation === "shell" ? "shell" : "typescript";
      if (toolJson.implementation !== "procedural") {
        const scan = securityScan(value, scanType);
        if (!scan.pass) {
          return `Error: security scan failed:\n${scan.errors.map((e) => `  - ${e}`).join("\n")}`;
        }
      }
      const implFile = getImplFile(toolJson.implementation);
      writeFileSync(join(toolDir, implFile), value, "utf-8");
      toolJson.version += 1;
      writeFileSync(toolJsonPath, JSON.stringify(toolJson, null, 2), "utf-8");
      loader.register(name, toolJson, toolDir);
      return `Tool '${name}' code updated.`;
    }

    case "input_schema": {
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(value) as Record<string, unknown>;
      } catch {
        return "Error: 'value' must be valid JSON for input_schema updates";
      }
      toolJson.input_schema = parsed;
      toolJson.version += 1;
      writeFileSync(toolJsonPath, JSON.stringify(toolJson, null, 2), "utf-8");
      loader.register(name, toolJson, toolDir);
      return `Tool '${name}' input_schema updated.`;
    }

    default:
      return `Error: unknown field '${field}'. Valid fields: description, code, input_schema`;
  }
}

function handleDelete(params: Record<string, unknown>): string {
  const name = params.name as string | undefined;
  if (!name) return "Error: 'name' is required for delete";

  const loader = getDynamicToolLoader();
  if (!loader) return "Error: dynamic tool loader not initialized";

  const toolDir = loader.getToolDir(name);
  if (!existsSync(toolDir)) {
    return `Error: tool '${name}' not found`;
  }

  rmSync(toolDir, { recursive: true });
  loader.deregister(name);

  return `Tool '${name}' deleted successfully.`;
}

function handleList(): string {
  const loader = getDynamicToolLoader();
  if (!loader) return "Error: dynamic tool loader not initialized";

  const toolsDir = loader.getToolsDir();
  if (!existsSync(toolsDir)) {
    return "No dynamic tools found (tools directory does not exist yet).";
  }

  const entries = readdirSync(toolsDir, { withFileTypes: true }).filter((e) => e.isDirectory());
  if (entries.length === 0) {
    return "No dynamic tools found.";
  }

  const lines: string[] = [`Dynamic tools (${entries.length}):\n`];

  for (const entry of entries) {
    const toolJsonPath = join(toolsDir, entry.name, "tool.json");
    if (!existsSync(toolJsonPath)) {
      lines.push(`  ${entry.name} — (missing tool.json)`);
      continue;
    }
    try {
      const toolJson = JSON.parse(readFileSync(toolJsonPath, "utf-8")) as ToolJson;
      lines.push(
        `  ${toolJson.name} [${toolJson.implementation}] v${toolJson.version}\n` +
        `    ${toolJson.description}\n` +
        `    Created: ${toolJson.created_at} by ${toolJson.created_by}`
      );
    } catch {
      lines.push(`  ${entry.name} — (invalid tool.json)`);
    }
  }

  return lines.join("\n");
}

function handleEnable(params: Record<string, unknown>): string {
  const name = params.name as string | undefined;
  if (!name) return "Error: 'name' is required for enable action.";
  const toolName = name as ToolName;

  // Validate it exists as a built-in tool
  const loader = getDynamicToolLoader();
  if (!loader) return "Error: dynamic tool loader not initialized";
  if (loader.has(toolName)) {
    return `Error: '${name}' is not a built-in tool. Use 'list' to see available dynamic tools.`;
  }

  const manager = getToolManager();
  manager.enable(toolName);
  return `Enabled '${name}'. It will now appear in tool definitions and can be called.`;
}

function handleDisable(params: Record<string, unknown>): string {
  const name = params.name as string | undefined;
  if (!name) return "Error: 'name' is required for disable action.";
  const toolName = name as ToolName;

  const manager = getToolManager();
  manager.disable(toolName);
  return `Disabled '${name}'. Excluded from tool definitions and blocked if called.`;
}

function handleListDisabled(): string {
  const manager = getToolManager();
  const disabled = manager.listDisabled();
  if (disabled.length === 0) return "No tools are currently disabled.";
  return `Disabled tools: ${disabled.join(", ")}`;
}

// ─── helpers ──────────────────────────────────────────────────────────────────

function getImplFile(implementation: "shell" | "typescript" | "procedural"): string {
  switch (implementation) {
    case "shell":
      return "run.sh";
    case "typescript":
      return "run.ts";
    case "procedural":
      return "steps.md";
  }
}
