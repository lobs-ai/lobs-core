/**
 * Smart output capping for tool results.
 *
 * Philosophy: show the model a useful preview by default, let it request more
 * with offset/limit if needed. This prevents context bloat at the source
 * rather than trying to prune it after the fact.
 *
 * Default: ~8000 chars (~200 lines). For large outputs, we show the head
 * plus a hint about how much was cut and how to see more.
 */

/** Default max characters for tool output */
export const DEFAULT_OUTPUT_CAP = 8000;

/** Max lines to show in preview mode */
export const DEFAULT_MAX_LINES = 200;

/**
 * Cap a tool result string to a budget.
 * Shows the first `maxLines` lines up to `maxChars`, with a truncation notice.
 *
 * @param output   - Full tool output
 * @param maxChars - Character budget (default 8000)
 * @param maxLines - Line budget (default 200)
 * @param hint     - Extra hint to add to truncation notice (e.g. "Use offset=N to continue.")
 */
export function capOutput(
  output: string,
  maxChars: number = DEFAULT_OUTPUT_CAP,
  maxLines: number = DEFAULT_MAX_LINES,
  hint?: string,
): string {
  if (output.length <= maxChars) {
    // Still check line count
    const lines = output.split("\n");
    if (lines.length <= maxLines) return output;

    const kept = lines.slice(0, maxLines).join("\n");
    const remaining = lines.length - maxLines;
    const notice = hint
      ? `\n\n[${remaining} more lines. ${hint}]`
      : `\n\n[${remaining} more lines truncated.]`;
    return kept + notice;
  }

  // Truncate by chars, but try to break at a line boundary
  let truncated = output.slice(0, maxChars);
  const lastNewline = truncated.lastIndexOf("\n");
  if (lastNewline > maxChars * 0.7) {
    truncated = truncated.slice(0, lastNewline);
  }

  // Count what's left
  const shownLines = truncated.split("\n").length;
  const totalLines = output.split("\n").length;
  const remaining = totalLines - shownLines;
  const remainingChars = output.length - truncated.length;

  const parts = [`${remaining} more lines (~${Math.round(remainingChars / 1000)}K chars)`];
  if (hint) parts.push(hint);

  return truncated + `\n\n[${parts.join(". ")}]`;
}
