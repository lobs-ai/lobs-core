/**
 * Shared path utilities for file tools.
 *
 * Centralizes the path resolution logic that was previously duplicated
 * across read.ts, write.ts, edit.ts, ls.ts, grep.ts, and glob.ts.
 */

import { resolve, isAbsolute } from "node:path";

/**
 * Resolve a file path relative to a working directory.
 * - Expands `~` to `$HOME`
 * - Resolves relative paths against `cwd`
 * - Returns the resolved absolute path
 */
export function resolveToCwd(filePath: string, cwd: string): string {
  const expanded = filePath.replace(/^~/, process.env.HOME ?? "");
  return isAbsolute(expanded) ? expanded : resolve(cwd, expanded);
}
