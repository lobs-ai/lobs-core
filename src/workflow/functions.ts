/**
 * Workflow expression functions — query live DB state for expressions.
 * Port of lobs-server/app/orchestrator/workflow_functions.py
 */

import { eq, and, inArray, count, sql } from "drizzle-orm";
import { getDb } from "../db/connection.js";
import { tasks, agentStatus as agentStatusTable, workerRuns, inboxItems } from "../db/schema.js";
import { log } from "../util/logger.js";

// ── Core query functions ──────────────────────────────────────────────────────

/** Max concurrent workers (from settings or default 3) */
export function workerCapacity(): number {
  const db = getDb();
  try {
    const row = db.select({ ct: count() })
      .from(workerRuns)
      .where(sql`${workerRuns.endedAt} IS NULL AND ${workerRuns.startedAt} IS NOT NULL`)
      .get();
    const active = row?.ct ?? 0;
    const maxWorkers = 5;
    return Math.max(0, maxWorkers - active);
  } catch (e) {
    log().warn(`workerCapacity() error: ${e}`);
    return 0;
  }
}

/** Count workers currently active (no endedAt) */
export function activeWorkers(): number {
  const db = getDb();
  try {
    const row = db.select({ ct: count() })
      .from(workerRuns)
      .where(sql`${workerRuns.endedAt} IS NULL AND ${workerRuns.startedAt} IS NOT NULL`)
      .get();
    return row?.ct ?? 0;
  } catch (e) {
    log().warn(`activeWorkers() error: ${e}`);
    return 0;
  }
}

/**
 * Count tasks by status.
 * @param status "open" | "active" | "pending" | specific status string
 */
export function numTasks(status: string): number {
  const db = getDb();
  try {
    if (status === "open") {
      const row = db.select({ ct: count() })
        .from(tasks)
        .where(inArray(tasks.status, ["inbox", "active", "waiting_on"]))
        .get();
      return row?.ct ?? 0;
    }
    if (status === "pending") {
      const row = db.select({ ct: count() })
        .from(tasks)
        .where(and(
          inArray(tasks.status, ["inbox", "active"]),
          eq(tasks.workState, "not_started"),
        ))
        .get();
      return row?.ct ?? 0;
    }
    if (status === "active") {
      const row = db.select({ ct: count() })
        .from(tasks)
        .where(eq(tasks.workState, "in_progress"))
        .get();
      return row?.ct ?? 0;
    }
    const row = db.select({ ct: count() })
      .from(tasks)
      .where(eq(tasks.status, status))
      .get();
    return row?.ct ?? 0;
  } catch (e) {
    log().warn(`numTasks() error: ${e}`);
    return 0;
  }
}

/**
 * Get a field from the current task in context.
 */
export function taskField(field: string, context: Record<string, unknown> = {}): unknown {
  const task = context["task"] as Record<string, unknown> | undefined;
  if (!task) return null;
  const parts = field.split(".");
  let val: unknown = task;
  for (const part of parts) {
    if (val && typeof val === "object") {
      val = (val as Record<string, unknown>)[part];
    } else {
      return null;
    }
  }
  return val;
}

/**
 * Get agent status string.
 */
export function agentStatus(agentType: string): string {
  const db = getDb();
  try {
    const row = db.select()
      .from(agentStatusTable)
      .where(eq(agentStatusTable.agentType, agentType))
      .get();
    return row?.status ?? "idle";
  } catch (e) {
    log().warn(`agentStatus() error: ${e}`);
    return "unknown";
  }
}

/** Count unread inbox items */
export function numUnread(): number {
  const db = getDb();
  try {
    const row = db.select({ ct: count() })
      .from(inboxItems)
      .where(eq(inboxItems.isRead, false))
      .get();
    return row?.ct ?? 0;
  } catch (e) {
    log().warn(`numUnread() error: ${e}`);
    return 0;
  }
}

/** Get current hour in given timezone (0-23) */
export function hour(tz: string = "UTC"): number {
  try {
    const now = new Date();
    const opts: Intl.DateTimeFormatOptions = { timeZone: tz, hour: "numeric", hour12: false };
    const hourStr = new Intl.DateTimeFormat("en-US", opts).format(now);
    const h = parseInt(hourStr, 10);
    return isNaN(h) ? new Date().getUTCHours() : h % 24;
  } catch (e) {
    log().warn(`hour() error: ${e}`);
    return new Date().getUTCHours();
  }
}

/** Get day of week in given timezone (0=Sunday, 6=Saturday) */
export function dayOfWeek(tz: string = "UTC"): number {
  try {
    const now = new Date();
    const opts: Intl.DateTimeFormatOptions = { timeZone: tz, weekday: "short" };
    const day = new Intl.DateTimeFormat("en-US", opts).format(now);
    const map: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
    return map[day] ?? now.getUTCDay();
  } catch (e) {
    log().warn(`dayOfWeek() error: ${e}`);
    return new Date().getUTCDay();
  }
}

/**
 * Get a value from the run context by dotted path.
 */
export function ctx(path: string, context: Record<string, unknown> = {}): unknown {
  const parts = path.split(".");
  let val: unknown = context;
  for (const part of parts) {
    if (val && typeof val === "object") {
      val = (val as Record<string, unknown>)[part];
    } else {
      return null;
    }
  }
  return val;
}

/**
 * Check if a string contains a substring.
 */
export function contains(haystack: unknown, needle: string): boolean {
  if (typeof haystack === "string") {
    return haystack.includes(needle);
  }
  if (Array.isArray(haystack)) {
    return haystack.includes(needle);
  }
  return false;
}

// ── Expression evaluator ──────────────────────────────────────────────────────

/**
 * Evaluate a workflow expression string.
 */
export function evaluateExpression(expr: string, context: Record<string, unknown>): unknown {
  try {
    return _eval(expr.trim(), context);
  } catch (e) {
    log().warn(`evaluateExpression error for "${expr}": ${e}`);
    return null;
  }
}

/**
 * Evaluate a condition expression — returns boolean.
 */
export function evaluateCondition(condition: string, context: Record<string, unknown>): boolean {
  const result = evaluateExpression(condition, context);
  return Boolean(result);
}

// ── Internal evaluator ────────────────────────────────────────────────────────

function _eval(expr: string, context: Record<string, unknown>): unknown {
  expr = expr.trim();

  if (expr === "true") return true;
  if (expr === "false") return false;
  if (expr === "null" || expr === "None") return null;

  if (/^-?\d+(\.\d+)?$/.test(expr)) return parseFloat(expr);

  if ((expr.startsWith('"') && expr.endsWith('"')) ||
      (expr.startsWith("'") && expr.endsWith("'"))) {
    return expr.slice(1, -1);
  }

  const andIdx = findBinaryOp(expr, " and ");
  if (andIdx !== -1) {
    const left = _eval(expr.slice(0, andIdx), context);
    const right = _eval(expr.slice(andIdx + 5), context);
    return Boolean(left) && Boolean(right);
  }

  const orIdx = findBinaryOp(expr, " or ");
  if (orIdx !== -1) {
    const left = _eval(expr.slice(0, orIdx), context);
    const right = _eval(expr.slice(orIdx + 4), context);
    return Boolean(left) || Boolean(right);
  }

  if (expr.startsWith("not ")) {
    return !_eval(expr.slice(4), context);
  }

  for (const op of ["!=", "==", ">=", "<=", ">", "<"]) {
    const idx = findBinaryOp(expr, ` ${op} `);
    if (idx !== -1) {
      const left = _eval(expr.slice(0, idx), context);
      const right = _eval(expr.slice(idx + op.length + 2), context);
      return compare(left, right, op);
    }
  }

  const funcMatch = expr.match(/^(\w+)\((.*)\)$/s);
  if (funcMatch) {
    const [, fn, argsStr] = funcMatch;
    const args = parseArgs(argsStr, context);
    return callFunction(fn, args, context);
  }

  if (/^[\w.]+$/.test(expr)) {
    return resolveContextPath(expr, context);
  }

  log().warn(`evaluateExpression: unrecognized expression: "${expr}"`);
  return null;
}

function findBinaryOp(expr: string, op: string): number {
  let depth = 0;
  let inString = false;
  let strChar = "";
  for (let i = 0; i < expr.length; i++) {
    const c = expr[i];
    if (inString) {
      if (c === strChar) inString = false;
      continue;
    }
    if (c === '"' || c === "'") { inString = true; strChar = c; continue; }
    if (c === '(' || c === '[') { depth++; continue; }
    if (c === ')' || c === ']') { depth--; continue; }
    if (depth === 0 && expr.slice(i).startsWith(op)) {
      return i;
    }
  }
  return -1;
}

function parseArgs(argsStr: string, context: Record<string, unknown>): unknown[] {
  if (!argsStr.trim()) return [];
  const parts: string[] = [];
  let depth = 0, inStr = false, strCh = "", cur = "";
  for (const c of argsStr) {
    if (inStr) { cur += c; if (c === strCh) inStr = false; continue; }
    if (c === '"' || c === "'") { inStr = true; strCh = c; cur += c; continue; }
    if (c === '(' || c === '[') { depth++; cur += c; continue; }
    if (c === ')' || c === ']') { depth--; cur += c; continue; }
    if (c === ',' && depth === 0) { parts.push(cur.trim()); cur = ""; continue; }
    cur += c;
  }
  if (cur.trim()) parts.push(cur.trim());
  return parts.map(p => _eval(p, context));
}

function callFunction(fn: string, args: unknown[], context: Record<string, unknown>): unknown {
  switch (fn) {
    case "workerCapacity": return workerCapacity();
    case "activeWorkers": return activeWorkers();
    case "numTasks": return numTasks(String(args[0] ?? "open"));
    case "taskField": return taskField(String(args[0] ?? ""), context);
    case "agentStatus": return agentStatus(String(args[0] ?? ""));
    case "numUnread": return numUnread();
    case "hour": return hour(String(args[0] ?? "UTC"));
    case "dayOfWeek": return dayOfWeek(String(args[0] ?? "UTC"));
    case "ctx": return ctx(String(args[0] ?? ""), context);
    case "contains": return contains(args[0], String(args[1] ?? ""));
    default:
      log().warn(`evaluateExpression: unknown function: ${fn}`);
      return null;
  }
}

function compare(left: unknown, right: unknown, op: string): boolean {
  switch (op) {
    case "==": return left == right || String(left) === String(right);
    case "!=": return left != right && String(left) !== String(right);
    case ">": return Number(left) > Number(right);
    case "<": return Number(left) < Number(right);
    case ">=": return Number(left) >= Number(right);
    case "<=": return Number(left) <= Number(right);
    default: return false;
  }
}

function resolveContextPath(path: string, context: Record<string, unknown>): unknown {
  const parts = path.split(".");
  let val: unknown = context;
  for (const part of parts) {
    if (val && typeof val === "object") {
      val = (val as Record<string, unknown>)[part];
    } else {
      return null;
    }
  }
  return val;
}

/**
 * Template interpolation: replace {node.field} placeholders with context values.
 */
export function interpolate(template: string, context: Record<string, unknown>): string {
  return template.replace(/\{([\w.]+)\}/g, (_match, path) => {
    const val = resolveContextPath(path, context);
    return val != null ? String(val) : "";
  });
}
