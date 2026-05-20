import { accessSync, constants, statSync } from "node:fs";
import { join } from "node:path";

const FALLBACK_SHELLS = [
  "/bin/bash",
  "/usr/bin/bash",
  "/opt/homebrew/bin/bash",
  "/bin/zsh",
  "/bin/sh",
];

function isExecutableFile(path: string): boolean {
  try {
    const stat = statSync(path);
    if (!stat.isFile()) return false;
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function resolvePathExecutable(command: string): string | null {
  if (command.includes("/")) return isExecutableFile(command) ? command : null;

  const pathEntries = (process.env.PATH ?? "").split(":").filter(Boolean);
  for (const dir of pathEntries) {
    const resolved = join(dir, command);
    if (isExecutableFile(resolved)) return resolved;
  }

  return null;
}

export function shellExists(path: string): boolean {
  return resolvePathExecutable(path) !== null;
}

function isSupportedShell(path: string): boolean {
  return /(?:^|\/)(?:ba)?sh$/.test(path) || /(?:^|\/)zsh$/.test(path);
}

function configuredShells(): string[] {
  return [process.env.LOBS_SHELL, process.env.SHELL].filter(
    (candidate): candidate is string => Boolean(candidate),
  );
}

function shellCandidates(): string[] {
  const configured = configuredShells();
  const configuredAbsoluteShells = configured.filter((candidate) => candidate.includes("/"));
  const configuredPathShells = configured.filter((candidate) => !candidate.includes("/"));

  return [...configuredAbsoluteShells, ...FALLBACK_SHELLS, ...configuredPathShells, "bash", "sh"];
}

export function getShellExecutable(): string {
  for (const candidate of shellCandidates()) {
    const resolved = resolvePathExecutable(candidate);
    if (isSupportedShell(candidate) && resolved) return resolved;
  }

  return "/bin/sh";
}

export function getShellSpawnArgs(command: string): [string, string] {
  return ["-c", command];
}

export function getShellScriptArgs(scriptPath: string): [string] | [string, string] {
  return shellExists(scriptPath) ? [scriptPath] : ["-c", scriptPath];
}
