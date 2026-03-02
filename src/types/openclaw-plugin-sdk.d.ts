/**
 * Type declarations for OpenClaw Plugin SDK.
 * These match the actual OpenClaw plugin runtime API.
 */

declare module "openclaw/plugin-sdk" {
  export interface PluginLogger {
    info(msg: string): void;
    warn(msg: string): void;
    error(msg: string): void;
    debug?(msg: string): void;
  }

  export interface OpenClawPluginApi {
    logger: PluginLogger;
    pluginConfig: Record<string, unknown> | null;
    config: Record<string, unknown>;

    resolvePath(path: string): string;

    on(event: string, handler: (event: unknown, ctx: unknown) => Promise<Record<string, unknown> | void>): void;

    registerHttpRoute(opts: {
      path: string;
      handler: (req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) => Promise<void>;
    }): void;

    registerService(opts: {
      id: string;
      start: () => void;
      stop: () => void;
    }): void;

    registerCommand?(opts: {
      name: string;
      description: string;
      handler: (ctx?: unknown) => Promise<{ text: string }>;
    }): void;

    registerCli?(
      fn: (opts: { program: { command(name: string): { description(d: string): { action(fn: () => Promise<void>): void } } } }) => void,
      opts?: { commands: string[] },
    ): void;

    registerGatewayMethod?(name: string, handler: (params: unknown) => Promise<unknown>): void;

    registerTool?(opts: {
      name: string;
      description: string;
      parameters: unknown;
      execute: (toolCallId: string, params: unknown) => Promise<unknown>;
    }): void;
  }

  export interface OpenClawPluginServiceContext {
    config: Record<string, unknown>;
    stateDir: string;
    logger: PluginLogger;
  }
}
