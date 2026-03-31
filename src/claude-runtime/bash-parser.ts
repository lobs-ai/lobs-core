import { randomBytes } from "node:crypto";
import {
  parse as shellQuoteParse,
  type ParseEntry,
} from "shell-quote";

type ShellParseResult =
  | { success: true; tokens: ParseEntry[] }
  | { success: false; error: string };

function tryParseShellCommand(cmd: string): ShellParseResult {
  try {
    return {
      success: true,
      tokens: shellQuoteParse(cmd, (varName: string) => `$${varName}`),
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown parse error",
    };
  }
}

function generatePlaceholders() {
  const salt = randomBytes(8).toString("hex");
  return {
    SINGLE_QUOTE: `__SINGLE_QUOTE_${salt}__`,
    DOUBLE_QUOTE: `__DOUBLE_QUOTE_${salt}__`,
    NEW_LINE: `__NEW_LINE_${salt}__`,
    ESCAPED_OPEN_PAREN: `__ESCAPED_OPEN_PAREN_${salt}__`,
    ESCAPED_CLOSE_PAREN: `__ESCAPED_CLOSE_PAREN_${salt}__`,
  };
}

type ExtractedHeredoc = {
  placeholder: string;
  body: string;
};

function extractHeredocs(command: string): {
  processedCommand: string;
  heredocs: ExtractedHeredoc[];
} {
  const heredocs: ExtractedHeredoc[] = [];
  let processedCommand = command;
  let counter = 0;

  const heredocPattern = /(<<-?\s*['"]?([A-Za-z_][A-Za-z0-9_]*)['"]?[^\n]*\n)([\s\S]*?)(\n\2)(?=\n|$)/g;
  processedCommand = processedCommand.replace(
    heredocPattern,
    (match, header: string, delimiter: string, body: string, closing: string) => {
      const placeholder = `__HEREDOC_${counter++}_${randomBytes(4).toString("hex")}__`;
      heredocs.push({
        placeholder,
        body: `${header}${body}${closing}`,
      });
      return placeholder;
    },
  );

  return { processedCommand, heredocs };
}

function restoreHeredocs(parts: string[], heredocs: ExtractedHeredoc[]): string[] {
  if (heredocs.length === 0) return parts;
  return parts.map((part) => {
    let restored = part;
    for (const heredoc of heredocs) {
      restored = restored.replaceAll(heredoc.placeholder, heredoc.body);
    }
    return restored;
  });
}

function joinContinuationLines(command: string): string {
  return command.replace(/\\+\n/g, (match) => {
    const backslashCount = match.length - 1;
    if (backslashCount % 2 === 1) {
      return "\\".repeat(backslashCount - 1);
    }
    return match;
  });
}

const CONTROL_OPERATORS = new Set(["&&", "||", "|", ";", "&", "|&"]);
const REDIRECTION_OPERATORS = new Set(["<", "<<", "<<-", ">", ">>", "<>", ">&", "<&", ">|"]);
const ALLOWED_FILE_DESCRIPTORS = new Set(["0", "1", "2"]);

function isStaticRedirectTarget(target: string): boolean {
  if (/[\s'"]/.test(target)) return false;
  if (target.length === 0) return false;
  if (target.startsWith("#")) return false;
  return (
    !target.startsWith("!") &&
    !target.startsWith("=") &&
    !target.includes("$") &&
    !target.includes("`") &&
    !target.includes("*") &&
    !target.includes("?") &&
    !target.includes("[") &&
    !target.includes("{") &&
    !target.includes("~") &&
    !target.includes("(") &&
    !target.includes("<") &&
    !target.startsWith("&")
  );
}

function stripRedirections(commandsAndOperators: string[]): string[] {
  const parts: Array<string | undefined> = [...commandsAndOperators];

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]?.trim();
    if (!part || !REDIRECTION_OPERATORS.has(part)) continue;

    const prevPart = parts[i - 1]?.trim();
    const nextPart = parts[i + 1]?.trim();
    const afterNextPart = parts[i + 2]?.trim();
    if (!nextPart) continue;

    let shouldStrip = false;
    let stripThirdToken = false;
    let effectiveNextPart = nextPart;

    if (
      (part === ">" || part === ">>") &&
      nextPart.length >= 3 &&
      nextPart.charAt(nextPart.length - 2) === " " &&
      ALLOWED_FILE_DESCRIPTORS.has(nextPart.charAt(nextPart.length - 1)) &&
      afterNextPart &&
      REDIRECTION_OPERATORS.has(afterNextPart)
    ) {
      effectiveNextPart = nextPart.slice(0, -2);
    }

    if ((part === ">&" || part === "<&") && ALLOWED_FILE_DESCRIPTORS.has(nextPart)) {
      shouldStrip = true;
    } else if (
      part === ">" &&
      nextPart === "&" &&
      afterNextPart &&
      ALLOWED_FILE_DESCRIPTORS.has(afterNextPart)
    ) {
      shouldStrip = true;
      stripThirdToken = true;
    } else if (
      part === ">" &&
      nextPart.startsWith("&") &&
      nextPart.length > 1 &&
      ALLOWED_FILE_DESCRIPTORS.has(nextPart.slice(1))
    ) {
      shouldStrip = true;
    } else if ((part === ">" || part === ">>" || part === "<" || part === "<>") && isStaticRedirectTarget(effectiveNextPart)) {
      shouldStrip = true;
    }

    if (!shouldStrip) continue;

    if (
      prevPart &&
      prevPart.length >= 3 &&
      ALLOWED_FILE_DESCRIPTORS.has(prevPart.charAt(prevPart.length - 1)) &&
      prevPart.charAt(prevPart.length - 2) === " "
    ) {
      parts[i - 1] = prevPart.slice(0, -2);
    }

    parts[i] = undefined;
    parts[i + 1] = undefined;
    if (stripThirdToken) parts[i + 2] = undefined;
  }

  return parts.filter((part): part is string => Boolean(part && part.trim().length > 0));
}

export function splitCommandWithOperators(command: string): string[] {
  const parts: Array<ParseEntry | null> = [];
  const placeholders = generatePlaceholders();
  const { processedCommand, heredocs } = extractHeredocs(command);
  const commandWithContinuationsJoined = joinContinuationLines(processedCommand);
  const originalJoined = joinContinuationLines(command);
  const parseResult = tryParseShellCommand(
    commandWithContinuationsJoined
      .replaceAll('"', `"${placeholders.DOUBLE_QUOTE}`)
      .replaceAll("'", `'${placeholders.SINGLE_QUOTE}`)
      .replaceAll("\n", `\n${placeholders.NEW_LINE}\n`)
      .replaceAll("\\(", placeholders.ESCAPED_OPEN_PAREN)
      .replaceAll("\\)", placeholders.ESCAPED_CLOSE_PAREN),
  );

  if (!parseResult.success) return [originalJoined];
  if (parseResult.tokens.length === 0) return [];

  try {
    for (const part of parseResult.tokens) {
      if (typeof part === "string") {
        if (parts.length > 0 && typeof parts[parts.length - 1] === "string") {
          if (part === placeholders.NEW_LINE) {
            parts.push(null);
          } else {
            parts[parts.length - 1] += ` ${part}`;
          }
          continue;
        }
      } else if ("op" in part && part.op === "glob") {
        if (parts.length > 0 && typeof parts[parts.length - 1] === "string") {
          parts[parts.length - 1] += ` ${part.pattern}`;
          continue;
        }
      }

      parts.push(part);
    }

    return restoreHeredocs(
      parts
      .map((part) => {
        if (part === null) return null;
        if (typeof part === "string") return part;
        if ("comment" in part) {
          const cleaned = part.comment
            .replaceAll(
              `"${placeholders.DOUBLE_QUOTE}`,
              placeholders.DOUBLE_QUOTE,
            )
            .replaceAll(
              `'${placeholders.SINGLE_QUOTE}`,
              placeholders.SINGLE_QUOTE,
            );
          return `#${cleaned}`;
        }
        if ("op" in part && part.op === "glob") return part.pattern;
        if ("op" in part) return part.op;
        return null;
      })
      .filter((part): part is string => part !== null)
      .map((part) =>
        part
          .replaceAll(placeholders.SINGLE_QUOTE, "'")
          .replaceAll(placeholders.DOUBLE_QUOTE, '"')
          .replaceAll(`\n${placeholders.NEW_LINE}\n`, "\n")
          .replaceAll(placeholders.ESCAPED_OPEN_PAREN, "\\(")
          .replaceAll(placeholders.ESCAPED_CLOSE_PAREN, "\\)"),
      ),
      heredocs,
    );
  } catch {
    return [originalJoined];
  }
}

export function filterControlOperators(commandsAndOperators: string[]): string[] {
  return commandsAndOperators.filter((part) => !CONTROL_OPERATORS.has(part));
}

export function splitCommand(command: string): string[] {
  return filterControlOperators(stripRedirections(splitCommandWithOperators(command)));
}

export function extractCdTarget(command: string): string | null {
  const parts = splitCommand(command);
  if (parts.length !== 1) return null;

  const parsed = tryParseShellCommand(parts[0]);
  if (!parsed.success) return null;

  const tokens = parsed.tokens.filter(
    (token): token is string => typeof token === "string",
  );
  if (tokens.length === 0) return null;
  if (tokens[0] !== "cd") return null;
  if (tokens.length === 1) return process.env.HOME ?? "/";
  if (tokens.length > 2) return null;
  return tokens[1] ?? null;
}
