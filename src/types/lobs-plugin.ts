import type { IncomingMessage, ServerResponse } from "node:http";

export interface PluginLogger {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
  debug?(msg: string): void;
}

export interface CliProgram {
  command(name: string): CliCommand;
}

export interface CliCommand {
  description(d: string): CliCommand;
  action(fn: (...args: unknown[]) => void | Promise<void>): CliCommand;
  command(name: string): CliCommand;
}

export interface LobsPluginApi {
  logger: PluginLogger;
  pluginConfig: Record<string, unknown> | null;
  config: Record<string, unknown>;
  resolvePath(path: string): string;
  on(event: string, handler: (event: unknown, ctx: unknown) => Promise<Record<string, unknown> | void>): void;
  registerHttpRoute(params: {
    path: string;
    handler: (req: IncomingMessage, res: ServerResponse) => Promise<boolean | void> | boolean | void;
    auth: "gateway" | "plugin";
    match?: "exact" | "prefix";
    replaceExisting?: boolean;
  }): void;
  registerService(opts: { id: string; start: () => void; stop: () => void }): void;
  registerCommand?(opts: { name: string; description: string; handler: (ctx?: unknown) => Promise<{ text: string }> }): void;
  registerCli?(fn: (opts: { program: CliProgram }) => void, opts?: { commands: string[] }): void;
  registerGatewayMethod?(name: string, handler: (params: unknown) => Promise<unknown>): void;
  registerTool?(opts: { name: string; description: string; parameters: unknown; execute: (toolCallId: string, params: unknown) => Promise<unknown> }): void;
}

export interface LobsPluginServiceContext {
  config: Record<string, unknown>;
  stateDir: string;
  logger: PluginLogger;
}
