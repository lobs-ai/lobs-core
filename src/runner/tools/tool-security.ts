/**
 * Security scanner for dynamic tool code.
 * Validates shell scripts and TypeScript modules before they are written to disk.
 */

export interface SecurityScanResult {
  pass: boolean;
  errors: string[];
}

const SHELL_PATTERNS: Array<{ pattern: RegExp; message: string }> = [
  // Destructive rm patterns
  {
    pattern: /rm\s+(-[a-zA-Z]*f[a-zA-Z]*\s+|--force\s+).*(-[a-zA-Z]*r[a-zA-Z]*|--recursive)/i,
    message: "Destructive recursive rm detected",
  },
  {
    pattern: /rm\s+(-[a-zA-Z]*r[a-zA-Z]*\s+|--recursive\s+).*(-[a-zA-Z]*f[a-zA-Z]*|--force)/i,
    message: "Destructive recursive rm detected",
  },
  {
    pattern: /rm\s+-rf\s*(\/|~|"\$HOME"|'\$HOME')/i,
    message: "Destructive rm -rf / or ~ detected",
  },
  // Disk overwrite
  {
    pattern: /dd\s+if=\/dev\//i,
    message: "Disk overwrite via dd detected",
  },
  // Fork bombs
  {
    pattern: /:\(\)\s*\{[^}]*:\s*\|\s*:&\s*\}/,
    message: "Fork bomb pattern detected",
  },
  // Credential env access
  {
    pattern: /\$\{?(OPENAI_API_KEY|AWS_SECRET|AWS_SECRET_ACCESS_KEY|GITHUB_TOKEN|ANTHROPIC_API_KEY|DATABASE_URL|DISCORD_TOKEN|SECRET|PRIVATE_KEY)\}?/i,
    message: "Access to sensitive credential environment variables detected",
  },
  // Curl/wget piped to shell
  {
    pattern: /curl\s+.*\|\s*(bash|sh|zsh|fish)/i,
    message: "Piping curl output to shell is not allowed",
  },
  {
    pattern: /wget\s+.*\|\s*(bash|sh|zsh|fish)/i,
    message: "Piping wget output to shell is not allowed",
  },
  {
    pattern: /curl\s+.*-[a-zA-Z]*o[a-zA-Z]*\s+\/dev\/stdin.*\|\s*(bash|sh)/i,
    message: "Piping downloaded content to shell is not allowed",
  },
  // Interactive prompts / stdin reads (tools run non-interactively)
  {
    pattern: /\bread\s+-p\s/i,
    message: "Interactive prompt (read -p) not allowed in non-interactive tools",
  },
  {
    pattern: /\bread\s+[a-zA-Z_]+\s*$/m,
    message: "Stdin read (read VAR) not allowed in non-interactive tools",
  },
];

const TYPESCRIPT_PATTERNS: Array<{ pattern: RegExp; message: string }> = [
  // child_process with unsanitized inputs
  {
    pattern: /child_process.*exec\s*\([^)]*\+[^)]*\)/,
    message: "child_process.exec with string concatenation (potential command injection)",
  },
  {
    pattern: /child_process.*execSync\s*\([^)]*\+[^)]*\)/,
    message: "child_process.execSync with string concatenation (potential command injection)",
  },
  // fs writes/deletes outside ~/.lobs/tools/
  {
    pattern: /fs\.writeFileSync\s*\(\s*(?!['"`].*\.lobs\/tools\/)/,
    message: "fs.writeFileSync outside ~/.lobs/tools/ is not allowed in dynamic tools",
  },
  {
    pattern: /fs\.rmSync\s*\(\s*(?!['"`].*\.lobs\/tools\/)/,
    message: "fs.rmSync outside ~/.lobs/tools/ is not allowed in dynamic tools",
  },
  // eval / Function constructor
  {
    pattern: /\beval\s*\(/,
    message: "eval() is not allowed in dynamic tools",
  },
  {
    pattern: /new\s+Function\s*\(/,
    message: "new Function() constructor is not allowed in dynamic tools",
  },
];

/**
 * Scan code for security violations.
 * Returns { pass: true } if clean, or { pass: false, errors: [...] } with all violations.
 */
export function securityScan(code: string, type: "shell" | "typescript"): SecurityScanResult {
  const errors: string[] = [];
  const patterns = type === "shell" ? SHELL_PATTERNS : TYPESCRIPT_PATTERNS;

  for (const { pattern, message } of patterns) {
    if (pattern.test(code)) {
      errors.push(message);
    }
  }

  return {
    pass: errors.length === 0,
    errors,
  };
}
