import { existsSync } from "node:fs";

const FALLBACK_SHELLS = [
  "/bin/bash",
  "/usr/bin/bash",
  "/opt/homebrew/bin/bash",
  "/bin/zsh",
  "/bin/sh",
];

export function shellExists(path: string): boolean {
  return path.includes("/") ? existsSync(path) : true;
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
    if (isSupportedShell(candidate) && shellExists(candidate)) return candidate;
  }

  return "/bin/sh";
}

export function getShellSpawnArgs(command: string): [string, string] {
  return ["-c", command];
}

export function getShellScriptArgs(scriptPath: string): [string] | [string, string] {
  return shellExists(scriptPath) ? [scriptPath] : ["-c", scriptPath];
}
