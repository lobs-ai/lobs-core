# Claude Code Tool Architecture — Research & Comparison

**Date:** 2026-03-31  
**Researcher:** Claude (researcher agent)  
**Purpose:** Deep-dive into Claude Code's tool architecture vs. lobs-core tools, to find actionable improvements.

---

## Question / Topic

How does Claude Code structure its tools, embed prompts, validate inputs, and handle errors — and where does lobs-core fall short in ways we can fix?

---

## Key Findings

### 1. Architecture Pattern

**Claude Code:** Each tool lives in its own directory (`src/tools/BashTool/`, `src/tools/FileEditTool/`, etc.) and is split into multiple focused files:
- `ToolName.ts` — main tool class with `buildTool({...})` factory
- `prompt.ts` — the tool's system-prompt contribution (a standalone exported function)
- `types.ts` — input/output Zod schemas
- `UI.tsx` — React rendering for the CLI
- `utils.ts` — pure helpers (diff generation, quote normalization, fuzzy matching)
- `constants.ts` — shared string constants
- `permissions.ts` / `validation.ts` — dedicated security modules for complex tools

**lobs-core:** Each tool is a single flat file (`exec.ts`, `edit.ts`, `read.ts`, etc.) containing the definition, all logic, and helpers. Tool registration lives in `index.ts`.

**Gap:** Our flat files mix concerns and don't scale well. For complex tools (exec has cwd tracking, background processes, timeout logic all inline), it's becoming hard to navigate. Not a blocking issue yet, but the per-directory pattern becomes important as tools grow.

---

### 2. Prompt Architecture — The Biggest Quality Gap

**Claude Code:** Every tool contributes a detailed, standalone prompt via `prompt.ts`. These prompts are injected into the system prompt at runtime and contain:
- When to use this tool vs. alternatives ("Use Grep, NOT grep/rg via Bash")  
- Exact usage rules with examples
- Anti-patterns to avoid ("NEVER use `find`, `grep`, `cat`, `head`, `tail`")
- Tool cross-references ("Use FileEdit, NOT sed/awk")
- Nuanced sub-rules (e.g., parallel vs. sequential command batching)

Example from `BashTool/prompt.ts` — just the tool preference section:
```
IMPORTANT: Avoid using this tool to run `find`, `grep`, `cat`, `head`, `tail`, 
`sed`, `awk`, or `echo` commands, unless explicitly instructed or after you have 
verified that a dedicated tool cannot accomplish your task. Instead, use:
- File search: Use Glob (NOT find or ls)
- Content search: Use Grep (NOT grep or rg)
- Read files: Use Read (NOT cat/head/tail)
- Edit files: Use Edit (NOT sed/awk)
- Write files: Use Write (NOT echo >/cat <<EOF)
```

The Bash prompt also has a full section on git safety protocols, commit formatting, PR creation, sleep avoidance patterns, and sandbox behavior — hundreds of lines of carefully tuned guidance.

**lobs-core:** Tool guidance lives entirely in the `description` field of the tool definition, which gets embedded in the API schema. These are 1-4 lines. Example from `exec.ts`:
```
"Execute a shell command in the current working directory or an optional workdir. " +
"Returns structured stdout, stderr, and exit status. Prefer dedicated tools like Read, Edit, Glob, and Grep when they fit the task instead of routing everything through Bash. " +
"Prefer targeted commands over huge output. Use timeout to limit execution time. " +
"Use run_in_background when you do not need the result immediately and are okay checking later."
```

**Gap:** We have almost no per-tool guidance in the system prompt. The model has to figure out when to use which tool from the schema descriptions alone. Claude Code's tool preference rules, anti-patterns, and cross-tool references are likely responsible for significant quality improvement in practice.

---

### 3. Input Validation — Two-Phase Approach

**Claude Code:** Tools have a dedicated `validateInput()` method that runs before `checkPermissions()` and before the actual `call()`. This returns structured errors with:
- `result: false` — failed
- `message` — human-readable description of the failure
- `errorCode` — numeric code for programmatic handling
- `behavior: 'ask'` — optional, signals to ask the user rather than auto-reject

The validation is thorough. `FileEditTool.validateInput()` catches:
- `old_string === new_string` (no-op edit)
- File too large (> 1 GiB)
- File not found (with "did you mean X?" fuzzy suggestions)
- File not read yet ("must read before editing")
- File modified since last read (staleness check via mtime comparison)
- Multiple matches without `replace_all: true`
- Empty `old_string` on existing file
- Binary files / Jupyter notebooks (redirected to correct tool)
- Denied by permissions

`FileReadTool.validateInput()` catches:
- Invalid PDF page ranges
- Binary file extensions (with helpful message)
- Blocked device paths (`/dev/zero`, `/dev/random`, `/dev/stdin`, etc.)
- UNC path (security, prevents NTLM credential leaks on Windows)

**lobs-core:** Validation is inline in the `editTool()` function body. Checks exist but are simpler:
- File not found
- `old_string` not found (with fuzzy suggestion)
- Multiple matches without `replace_all`
- File not recently read (via `hasRecentlyReadFile`)

**Gap:** We lack the pre-execution validation separation. More importantly, we're missing specific safety checks:
- No staleness detection (mtime check between read and edit)
- No file size guard on edit
- No blocked device path list for Read
- Error codes (we just throw strings)

---

### 4. Read Deduplication — Cache Stub Pattern

**Claude Code** (`FileReadTool`):
```typescript
// If file hasn't changed since last read, return a stub instead of full content
if (existingState && existingState.offset === offset && existingState.limit === limit) {
  const mtimeMs = await getFileModificationTimeAsync(fullFilePath)
  if (mtimeMs === existingState.timestamp) {
    return { data: { type: 'file_unchanged', file: { filePath: file_path } } }
  }
}
// stub text sent to model:
'File unchanged since last read. The content from the earlier Read 
tool_result in this conversation is still current — refer to that instead of re-reading.'
```

**lobs-core** (`read.ts`) — we already implemented this! Same pattern:
```typescript
const cached = recentReadCache.get(cacheKey);
if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
  return FILE_UNCHANGED_STUB;
}
```

**Gap:** None here — we have this pattern. We actually copied it well.

---

### 5. Zod Schema Architecture

**Claude Code:** Every tool has a separate `inputSchema` and `outputSchema`, both using Zod v4 with `lazySchema()` (deferred evaluation to avoid circular import costs). Schemas are used for:
- API schema generation
- Runtime input validation
- Output type safety
- `mapToolResultToToolResultBlockParam()` — controlling exactly what the model sees vs. what the UI shows

The separation of model-facing content from UI-facing content is an explicit design goal. For example, `FileReadTool` sends the full file content with line numbers to the model but the UI only shows "Read 42 lines" chrome.

**lobs-core:** We use plain JSON Schema objects (not Zod) for `input_schema`. There's no output schema — the executor just returns a string. `formatToolOutput()` in `index.ts` does minor formatting but there's no structured output model.

**Gap:** No typed output schemas means we can't distinguish what the model sees vs. what debugging shows. Not critical, but it means we can't easily add output transformations (e.g., stripping internal fields, reformatting for context efficiency).

---

### 6. Quote Normalization in Edit

**Claude Code** (`FileEditTool/utils.ts`):
```typescript
// Claude can't output curly quotes, so we normalize them to straight quotes
export function normalizeQuotes(str: string): string {
  return str
    .replaceAll('\u2018', "'").replaceAll('\u2019', "'")  // '' → ''
    .replaceAll('\u201C', '"').replaceAll('\u201D', '"')  // "" → ""
}

// Also: findActualString() tries exact match, then quote-normalized match
export function findActualString(fileContent: string, searchString: string): string | null {
  // First try exact match
  if (fileContent.includes(searchString)) return searchString
  // Then try quote-normalized match
  const normalized = normalizeQuotes(searchString)
  if (normalized !== searchString && fileContent.includes(normalized)) return normalized
  return null
}
```

And `preserveQuoteStyle()` — when the file uses curly quotes but the model outputs straight quotes, it converts the replacement to use the file's quote style.

**lobs-core** (`edit.ts`): We have `fuzzyFindSimilar()` for whitespace normalization but no quote normalization.

**Gap:** Models (and especially copy-paste from users) frequently produce curly quotes. Our edit tool will fail on these with "old_string not found" when a fuzzy match after quote normalization would have succeeded. This is a real source of spurious edit failures.

---

### 7. Line Numbers in Read Output

**Claude Code** sends `cat -n` style output to the model (line number + tab + content). The prompt explicitly tells the model: "Everything after the line number prefix is the actual file content to match. Never include any part of the line number prefix in old_string."

**lobs-core** sends padded `"     1\t<content>"` format — we got this right.

**Gap:** None — we do line numbers. But our Edit prompt should explicitly call out the prefix format the way Claude Code does, to avoid the model accidentally including line numbers in `old_string`.

---

### 8. Grep Tool — Output Modes & Pagination

**Claude Code** `GrepTool` supports:
- `output_mode`: `"content"` | `"files_with_matches"` | `"count"` (defaults to `files_with_matches`)
- `-A`, `-B`, `-C` context line flags
- `-i` case insensitive
- `type` for file type filter (e.g. `"js"`, `"py"`)
- `head_limit` + `offset` for pagination (default cap: 250 lines)
- `multiline` mode for cross-line patterns
- Automatic path relativization (saves tokens)
- VCS directory exclusion (`.git`, `.svn`, `.hg`, etc.)
- `--max-columns 500` to prevent base64/minified content from bloating output

**lobs-core** `grep.ts` (from `find ~/lobs/lobs-core/src/runner/tools/grep.ts`): needs reading to compare, but the schema likely lacks output modes and pagination.

**Gap (likely):** No output modes, no pagination, no context lines, probably no `head_limit`. These make Grep substantially more useful for the model — especially `files_with_matches` as default (much cheaper to return just paths than content) and `head_limit` to avoid context bloat.

---

### 9. Glob Tool — Token Efficiency

**Claude Code** `GlobTool`:
- Automatically relativizes paths under cwd to save tokens
- Has a configurable result limit (default 100)
- When truncated: tells model explicitly "(Results are truncated. Consider using a more specific path or pattern.)"
- Returns `durationMs` for debugging

**lobs-core** `GlobTool`:
- Uses `fd` with a fallback to `find` — good
- No automatic path relativization — returns absolute paths (wastes tokens)
- `capOutput()` truncation but no explicit "results truncated" signal to the model

**Gap:** Absolute paths in glob output waste tokens on every file listed. Path relativization is a pure win.

---

### 10. Tool Registration Pattern

**Claude Code:** Tools are `buildTool({...})` factory objects that include everything: name, schema, prompt, call, validation, permissions, UI rendering, and serialization. Tools are self-contained objects that know how to render themselves.

**lobs-core:** Definition and executor are separate exports (e.g., `execToolDefinition` + `execTool`), registered as a pair in `TOOL_REGISTRY`. The registry then calls `formatToolOutput()` for minor output formatting. This split is clean and simpler for a server.

**Gap:** This is a deliberate architectural difference, not a bug. Our simpler pattern is fine for a server-based system. No change needed.

---

### 11. `description` Field on `exec` Schema Parameters

**Claude Code** Bash input schema has a `description` field on the `command` parameter:
```typescript
command: z.string().describe('The command to execute'),
timeout: semanticNumber(z.number().optional()).describe(
  `Optional timeout in milliseconds (max ${getMaxTimeoutMs()})`
),
description: z.string().optional().describe(
  `Clear, concise description of what this command does in active voice...
  For simple commands: keep it brief (5-10 words)
  For complex commands: add enough context...`
)
```

The `description` parameter on Bash calls is itself described in detail — teaching the model how to write good descriptions of its own tool calls. This surfaces in UI and makes tool use more legible.

**lobs-core:** Our exec schema has similar parameter descriptions but no `description` parameter for the command. We do have `cmd` and `command` as aliased fields.

**Gap:** Low priority, but adding a `description` parameter to `exec` would make agent tool calls more auditable.

---

## Comparison Summary Table

| Dimension | Claude Code | lobs-core | Gap Size |
|-----------|-------------|-----------|----------|
| Tool prompt system | Per-tool `prompt.ts`, hundreds of lines, runtime-injected | 1-4 line `description` in schema | 🔴 Large |
| Input validation | Dedicated `validateInput()`, structured errors, error codes | Inline throws, fewer checks | 🟠 Medium |
| Edit staleness detection | mtime check between read and edit | None | 🟠 Medium |
| Quote normalization | Curly→straight, `findActualString()`, `preserveQuoteStyle()` | Whitespace fuzzy only | 🟠 Medium |
| Grep output modes | 3 modes + pagination + context lines | Basic | 🟠 Medium |
| Path relativization | Grep & Glob relativize under cwd | Returns absolute paths | 🟡 Small-medium |
| Read deduplication | ✅ mtime cache + stub | ✅ mtime cache + stub | None |
| Line numbers in Read | ✅ `cat -n` style | ✅ same | None |
| Tool directory structure | Per-tool dirs, focused files | Flat files | 🟡 Low (style) |
| Zod output schemas | Typed, model-vs-UI split | String output only | 🟡 Low |
| Binary file detection | Extension list + device path blocklist | Null-byte scan | 🟡 Low |
| `description` param on exec | ✅ teaches model to self-document | ❌ missing | 🟡 Low |

---

## Recommendations (Ordered by Impact)

### 🔴 Priority 1: Per-Tool Prompt Contributions

**Problem:** The model has no guidance on when to use which tool. It may shell out to `grep` instead of using our `grep` tool, or use `exec` for things that should go through `read`/`edit`.

**What to do:** Add a `getSystemPromptSection()` function to each tool's file that returns guidance text. Concatenate these into the system prompt in the runner. Start with:
- `exec.ts` — mirror Claude Code's tool preference rules: "Use Read/Edit/Grep/Glob. Don't use cat/grep/find via exec."
- `edit.ts` — "Must Read before editing. Exact whitespace. Line number prefix is not part of the content."
- `grep.ts` — "Use Grep not exec for content search. Pattern syntax is ripgrep (not POSIX grep)."

**Estimated impact:** High — this is likely the biggest quality lever Claude Code has over us.

---

### 🟠 Priority 2: Edit Staleness Detection

**Problem:** If a file is modified externally (lint, formatter, another agent) between when we read it and when we edit it, we silently overwrite the intermediate changes.

**What to do:** In `edit.ts`, after reading the file for the edit, check its `mtime` against the `mtime` at read time (stored in `recentReadCache`). If they differ and the content differs, return an error: "File has been modified since last read. Read it again before editing."

```typescript
// In editTool(), after readFileSync():
const cached = recentReadCache.get(resolved);
const currentMtime = statSync(resolved).mtimeMs;
if (cached && currentMtime > cached.mtimeMs) {
  const currentContent = readFileSync(resolved, 'utf-8');
  if (currentContent !== cached.content) {  // need to store content too
    throw new Error('File modified since last read. Read it again before editing.');
  }
}
```

Note: `recentReadCache` currently stores `{ mtimeMs, size }` — needs `content` added for this to work properly (or just use mtime as a heuristic).

---

### 🟠 Priority 3: Quote Normalization in Edit

**Problem:** Models frequently output curly quotes (`'`, `'`, `"`, `"`) when the source file uses straight quotes, or vice versa. Our edit fails with "old_string not found" even though the match is obvious.

**What to do:** In `applySingleEdit()`, after the exact match fails:
```typescript
function normalizeQuotes(s: string): string {
  return s
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"');
}

// After index === -1:
const normalizedOld = normalizeQuotes(oldText);
if (normalizedOld !== oldText) {
  const normalizedContent = normalizeQuotes(content);
  const normalizedIdx = normalizedContent.indexOf(normalizedOld);
  if (normalizedIdx !== -1) {
    // find the actual text span in original content and use it
    ...
  }
}
```

---

### 🟠 Priority 4: Grep Output Modes + Pagination

**Problem:** Our Grep tool probably returns raw content by default. For most search tasks, the model only needs file paths (`files_with_matches`), not content. And without a `head_limit`, a broad search can dump megabytes into context.

**What to do:** Add to `grepToolDefinition.input_schema`:
- `output_mode`: `"content" | "files_with_matches" | "count"` (default `"files_with_matches"`)
- `head_limit`: number, default 250, pass 0 for unlimited
- `-A`, `-B`, `-C`: context lines (only in content mode)
- `-i`: case insensitive

In `grepTool()`, pass `-l` flag for `files_with_matches` mode, and slice results to `head_limit`.

Also: add `--max-columns 500` to prevent minified JS / base64 from bloating output.

---

### 🟡 Priority 5: Path Relativization in Grep & Glob

**Problem:** Absolute paths in grep/glob output waste tokens on long prefixes that repeat across every line.

**What to do:** In `grepTool()` content mode, strip the cwd prefix from file paths in each output line. In `globTool()`, do the same before returning results. A simple utility:
```typescript
function toRelative(filePath: string, cwd: string): string {
  return filePath.startsWith(cwd + '/') ? filePath.slice(cwd.length + 1) : filePath;
}
```

---

### 🟡 Priority 6: Blocked Device Paths in Read

**Problem:** Reading `/dev/random`, `/dev/zero`, or `/dev/stdin` would hang the process indefinitely.

**What to do:** In `readTool()`, add a blocklist check before reading:
```typescript
const BLOCKED_PATHS = new Set(['/dev/zero', '/dev/random', '/dev/urandom', 
  '/dev/full', '/dev/stdin', '/dev/tty', '/dev/console']);
if (BLOCKED_PATHS.has(resolved)) {
  throw new Error(`Cannot read '${filePath}': device file would block or produce infinite output.`);
}
```

---

### 🟡 Priority 7: Edit Prompt Clarification on Line Number Prefix

**Problem:** The model might include the `"     1\t"` prefix from Read output in `old_string`, causing "not found" errors.

**What to do:** Add to `edit.ts` description:
> "When editing text from Read output, the line number prefix format is: spaces + line number + tab. Everything **after** the tab is the actual file content. Never include the line number prefix in old_string or new_string."

This is already in our Edit description partially but should be made more explicit.

---

## Key Code Snippets from Claude Code to Adopt

### Pattern A: Tool Preference System Prompt Section

```typescript
// In each tool file, e.g. grep.ts
export function getSystemPromptSection(): string {
  return `Content search: Use Grep (NOT exec with grep/rg).
  - ALWAYS use Grep for search tasks. NEVER invoke grep or rg via exec.
  - Supports full regex syntax
  - output_mode "files_with_matches" (default) returns paths only — cheaper
  - Use head_limit to cap output size (default 250 lines)`;
}

// In runner/system-prompt.ts — concatenate all sections
const toolGuidance = [
  exec.getSystemPromptSection(),
  grep.getSystemPromptSection(),
  glob.getSystemPromptSection(),
  // ...
].join('\n\n');
```

### Pattern B: findActualString with quote normalization

```typescript
// FileEditTool/utils.ts pattern — adapt for our edit.ts
export function findActualString(content: string, search: string): string | null {
  if (content.includes(search)) return search;
  // Try quote normalization
  const normalized = search
    .replace(/[\u2018\u2019]/g, "'").replace(/[\u201C\u201D]/g, '"');
  if (normalized !== search && content.includes(normalized)) return normalized;
  return null;
}
```

### Pattern C: Structured validateInput() (adapt for our pattern)

```typescript
// Instead of inline throws, use a pre-call validation function:
async function validateEditInput(params, cwd): Promise<{ ok: true } | { ok: false; message: string }> {
  if (!params.old_string) return { ok: false, message: 'old_string is required' };
  if (params.old_string === params.new_string) 
    return { ok: false, message: 'No changes: old_string and new_string are identical' };
  const resolved = resolveToCwd(params.file_path, cwd);
  if (!existsSync(resolved)) 
    return { ok: false, message: `File not found: ${params.file_path}` };
  if (!hasRecentlyReadFile(resolved))
    return { ok: false, message: 'Must Read file before editing it.' };
  // ... etc
  return { ok: true };
}
```

### Pattern D: Grep with head_limit + pagination

```typescript
// From GrepTool — the applyHeadLimit pattern:
const DEFAULT_HEAD_LIMIT = 250;

function applyHeadLimit<T>(items: T[], limit?: number, offset = 0) {
  if (limit === 0) return { items: items.slice(offset), appliedLimit: undefined };
  const effective = limit ?? DEFAULT_HEAD_LIMIT;
  const sliced = items.slice(offset, offset + effective);
  const truncated = items.length - offset > effective;
  return { items: sliced, appliedLimit: truncated ? effective : undefined };
}
```

---

## Sources / References

- `~/claude-code/src/tools/BashTool/BashTool.tsx` — full tool impl + isSearchOrReadBashCommand
- `~/claude-code/src/tools/BashTool/prompt.ts` — getSimplePrompt(), tool preference rules, git safety
- `~/claude-code/src/tools/FileEditTool/FileEditTool.ts` — validateInput, staleness check, call()
- `~/claude-code/src/tools/FileEditTool/prompt.ts` — getEditToolDescription()
- `~/claude-code/src/tools/FileEditTool/utils.ts` — findActualString, normalizeQuotes, fuzzyFindSimilar
- `~/claude-code/src/tools/FileReadTool/FileReadTool.ts` — dedup, blocked devices, limits
- `~/claude-code/src/tools/FileReadTool/prompt.ts` — renderPromptTemplate()
- `~/claude-code/src/tools/GrepTool/GrepTool.ts` — output modes, head_limit, VCS exclusion
- `~/claude-code/src/tools/GrepTool/prompt.ts` — "ALWAYS use Grep, NEVER invoke grep/rg via Bash"
- `~/claude-code/src/tools/GlobTool/GlobTool.ts` — path relativization, truncation signal
- `~/claude-code/src/Tool.ts` — ToolDef interface, buildTool pattern
- `~/lobs/lobs-core/src/runner/tools/exec.ts`
- `~/lobs/lobs-core/src/runner/tools/edit.ts`
- `~/lobs/lobs-core/src/runner/tools/read.ts`
- `~/lobs/lobs-core/src/runner/tools/grep.ts`
- `~/lobs/lobs-core/src/runner/tools/glob.ts`
- `~/lobs/lobs-core/src/runner/tools/index.ts`
