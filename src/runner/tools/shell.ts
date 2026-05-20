import { existsSync } from "node:fs";

const FALLBACK_SHELLS = [
  "/bin/bash",
  "/usr/bin/bash",
  "/opt/homebrew/bin/bash",
  "/bin/zsh",
  "/bin/sh",
];

function isSupportedShell(path: string): boolean {
  return /(?:^|\/)(?:ba)?sh$/.test(path) || /(?:^|\/)zsh$/.test(path);
}

function shellExists(path: string): boolean {
  return path.includes("/") ? existsSync(path) : true;
}

export function getShellExecutable(): string {
  const configuredShells = [process.env.LOBS_SHELL, process.env.SHELL].filter(
    (candidate): candidate is string => Boolean(candidate),
  );
  const configuredAbsoluteShells = configuredShells.filter((candidate) => candidate.includes("/"));
  const configuredPathShells = configuredShells.filter((candidate) => !candidate.includes("/"));
  const candidates = [
    ...configuredAbsoluteShells,
    ...FALLBACK_SHELLS,
    ...configuredPathShells,
    "bash",
    "sh",
  ];

  for (const candidate of candidates) {
    if (!isSupportedShell(candidate) || !shellExists(candidate)) continue;
    return candidate;
  }

  return "/bin/sh";
}

export function getShellSpawnArgs(command: string): [string, string] {
  return ["-c", command];
}
