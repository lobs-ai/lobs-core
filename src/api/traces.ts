/**
 * traces.ts — REST API for the Agent Replay Debugger.
 *
 * Routes (all under /traces/):
 *   GET  /traces               — list recent traces (paginated)
 *   GET  /traces/:traceId      — get trace metadata
 *   GET  /traces/:traceId/spans — get all spans for a trace
 *   GET  /traces/:traceId/export — export as OTLP-compatible JSON
 *   GET  /traces/ui            — serve the single-page replay viewer
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import type { PawDB } from "../db/connection.js";
import type { LobsPluginApi } from "../types/lobs-plugin.js";
import {
  listTraces,
  getTrace,
  getSpansForTrace,
  exportTraceAsOtlp,
  countTraces,
} from "../tracer/trace-store.js";
import { seedDemoTraces } from "../tracer/demo-traces.js";

let _db: PawDB | null = null;

export function initTracesApi(api: LobsPluginApi, db: PawDB): void {
  _db = db;
}

function getDb(): PawDB {
  if (!_db) throw new Error("traces API not initialized");
  return _db;
}

function json(res: ServerResponse, data: unknown, status = 200) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

function notFound(res: ServerResponse, msg = "Not found") {
  json(res, { error: msg }, 404);
}

export async function handleTracesRequest(
  req: IncomingMessage,
  res: ServerResponse,
  id: string | undefined,
  parts: string[]
): Promise<void> {
  try {
    const method = req.method ?? "GET";

    // POST /traces/seed-demo — populate demo traces for HN demo
    if (id === "seed-demo" && method === "POST") {
      try {
        const db = getDb();
        await seedDemoTraces(db, {
          taskId: "demo-research-2025-04",
          agentType: "research-agent",
          turns: 3,
          withErrors: true,
        });
        json(res, { ok: true, message: "Demo trace seeded" });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        json(res, { ok: false, error: msg }, 500);
      }
      return;
    }

    // GET /traces/ui — serve replay UI
    if (id === "ui") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(getReplayUiHtml());
      return;
    }

    // GET /traces — list traces
    if (!id && method === "GET") {
      const url = new URL(req.url ?? "/", "http://localhost");
      const limit = Math.min(parseInt(url.searchParams.get("limit") ?? "50"), 200);
      const offset = parseInt(url.searchParams.get("offset") ?? "0");
      const db = getDb();
      const traces = listTraces(db, limit, offset);
      const total = countTraces(db);
      json(res, { traces, total, limit, offset });
      return;
    }

    if (!id) { notFound(res); return; }

    const sub = parts[2]; // parts: ["traces", traceId, sub?]

    // GET /traces/:traceId/spans
    if (sub === "spans") {
      const db = getDb();
      const trace = getTrace(db, id);
      if (!trace) { notFound(res, `Trace ${id} not found`); return; }
      const spans = getSpansForTrace(db, id);
      json(res, { traceId: id, spans });
      return;
    }

    // GET /traces/:traceId/export — OTLP JSON
    if (sub === "export") {
      const db = getDb();
      const trace = getTrace(db, id);
      if (!trace) { notFound(res, `Trace ${id} not found`); return; }
      const spans = getSpansForTrace(db, id);
      const otlp = exportTraceAsOtlp(trace, spans);
      res.writeHead(200, {
        "Content-Type": "application/json",
        "Content-Disposition": `attachment; filename="trace-${id.slice(0, 8)}.otlp.json"`,
      });
      res.end(JSON.stringify(otlp, null, 2));
      return;
    }

    // GET /traces/:traceId — trace metadata
    if (method === "GET") {
      const db = getDb();
      const trace = getTrace(db, id);
      if (!trace) { notFound(res, `Trace ${id} not found`); return; }
      json(res, trace);
      return;
    }

    notFound(res);
  } catch (err) {
    console.error("[traces-api] error:", err);
    json(res, { error: String(err) }, 500);
  }
}

// ── Replay UI ─────────────────────────────────────────────────────────────────

function getReplayUiHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Agent Replay Debugger — Lobs</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  :root {
    --bg: #0f1117;
    --surface: #1a1d27;
    --surface2: #232635;
    --border: #2e3148;
    --text: #e2e4f0;
    --muted: #6b7194;
    --accent: #7c6af7;
    --accent2: #5b9cf6;
    --green: #4ade80;
    --red: #f87171;
    --yellow: #fbbf24;
    --orange: #fb923c;
  }
  body { background: var(--bg); color: var(--text); font-family: 'SF Mono', 'Fira Code', monospace; font-size: 13px; min-height: 100vh; }
  
  /* Layout */
  .shell { display: grid; grid-template-columns: 320px 1fr; height: 100vh; overflow: hidden; }
  .sidebar { background: var(--surface); border-right: 1px solid var(--border); display: flex; flex-direction: column; overflow: hidden; }
  .main { display: flex; flex-direction: column; overflow: hidden; }
  
  /* Header */
  .header { padding: 16px 20px; border-bottom: 1px solid var(--border); display: flex; align-items: center; gap: 12px; }
  .logo { font-size: 18px; font-weight: 700; color: var(--accent); letter-spacing: -0.5px; }
  .logo span { color: var(--muted); font-weight: 400; font-size: 13px; }
  .header-actions { margin-left: auto; display: flex; gap: 8px; }
  
  /* Sidebar trace list */
  .sidebar-header { padding: 12px 16px; border-bottom: 1px solid var(--border); font-size: 11px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.08em; display: flex; align-items: center; justify-content: space-between; }
  .trace-list { flex: 1; overflow-y: auto; }
  .trace-item { padding: 12px 16px; border-bottom: 1px solid var(--border); cursor: pointer; transition: background 0.1s; }
  .trace-item:hover { background: var(--surface2); }
  .trace-item.active { background: var(--surface2); border-left: 2px solid var(--accent); }
  .trace-agent { font-weight: 600; color: var(--text); font-size: 12px; }
  .trace-task { color: var(--muted); font-size: 11px; margin-top: 3px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 260px; }
  .trace-meta { display: flex; gap: 8px; margin-top: 6px; align-items: center; }
  .badge { font-size: 10px; padding: 2px 6px; border-radius: 4px; font-weight: 600; }
  .badge-running { background: rgba(251,191,36,0.15); color: var(--yellow); }
  .badge-completed { background: rgba(74,222,128,0.12); color: var(--green); }
  .badge-failed { background: rgba(248,113,113,0.12); color: var(--red); }
  .badge-timeout { background: rgba(251,146,60,0.12); color: var(--orange); }
  .badge-llm { background: rgba(124,106,247,0.15); color: var(--accent); }
  .badge-tool { background: rgba(91,156,246,0.15); color: var(--accent2); }
  .badge-error { background: rgba(248,113,113,0.12); color: var(--red); }
  .trace-time { color: var(--muted); font-size: 10px; }
  
  /* Main panel */
  .panel-header { padding: 14px 20px; border-bottom: 1px solid var(--border); display: flex; align-items: center; gap: 12px; }
  .panel-title { font-size: 14px; font-weight: 600; }
  .panel-sub { color: var(--muted); font-size: 11px; }
  .btn { background: var(--surface2); border: 1px solid var(--border); color: var(--text); padding: 5px 12px; border-radius: 6px; cursor: pointer; font-size: 11px; font-family: inherit; transition: all 0.1s; }
  .btn:hover { border-color: var(--accent); color: var(--accent); }
  .btn-primary { background: var(--accent); border-color: var(--accent); color: white; }
  .btn-primary:hover { opacity: 0.85; color: white; }
  
  /* Stats bar */
  .stats-bar { padding: 10px 20px; border-bottom: 1px solid var(--border); display: flex; gap: 24px; }
  .stat { display: flex; flex-direction: column; gap: 2px; }
  .stat-val { font-size: 18px; font-weight: 700; color: var(--text); }
  .stat-label { font-size: 10px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.06em; }
  
  /* Timeline */
  .timeline-wrap { flex: 1; overflow-y: auto; padding: 16px 20px; }
  .timeline { position: relative; }
  .tl-connector { position: absolute; left: 20px; top: 0; bottom: 0; width: 1px; background: var(--border); }
  
  .span-row { display: flex; gap: 12px; margin-bottom: 6px; position: relative; }
  .span-dot { width: 9px; height: 9px; border-radius: 50%; flex-shrink: 0; margin-top: 5px; position: relative; z-index: 1; }
  .span-dot.kind-agent { background: var(--accent); }
  .span-dot.kind-llm { background: var(--accent2); }
  .span-dot.kind-tool { background: var(--green); }
  .span-dot.kind-error { background: var(--red); }
  .span-dot.kind-compaction { background: var(--orange); }
  .span-dot.status-error { background: var(--red) !important; }
  .span-dot.status-running { animation: pulse 1.5s infinite; }
  @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.4} }
  
  .span-card { flex: 1; background: var(--surface); border: 1px solid var(--border); border-radius: 8px; cursor: pointer; transition: all 0.1s; overflow: hidden; }
  .span-card:hover { border-color: var(--accent); }
  .span-card.expanded { border-color: var(--accent); }
  .span-main { display: flex; align-items: center; gap: 8px; padding: 8px 12px; }
  .span-name { font-weight: 600; font-size: 12px; }
  .span-duration { color: var(--muted); font-size: 11px; margin-left: auto; }
  .span-detail { padding: 0 12px 10px; border-top: 1px solid var(--border); margin-top: 4px; }
  .detail-grid { display: grid; grid-template-columns: auto 1fr; gap: 3px 12px; margin-top: 8px; }
  .detail-key { color: var(--muted); font-size: 11px; }
  .detail-val { color: var(--text); font-size: 11px; word-break: break-all; }
  .detail-val.mono { font-family: monospace; }
  .detail-val.error { color: var(--red); }
  .detail-val.preview { color: var(--text); max-height: 120px; overflow-y: auto; background: var(--surface2); padding: 6px 8px; border-radius: 4px; white-space: pre-wrap; }
  
  /* Flamegraph */
  .flame-section { padding: 16px 20px; border-top: 1px solid var(--border); }
  .flame-title { font-size: 11px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.06em; margin-bottom: 8px; }
  .flame-wrap { overflow-x: auto; }
  .flame-canvas { position: relative; height: auto; }
  .flame-row { position: relative; height: 22px; margin-bottom: 2px; }
  .flame-bar { position: absolute; height: 20px; border-radius: 3px; display: flex; align-items: center; padding: 0 6px; font-size: 10px; overflow: hidden; white-space: nowrap; cursor: pointer; transition: opacity 0.1s; }
  .flame-bar:hover { opacity: 0.85; }
  .flame-bar.kind-agent { background: rgba(124,106,247,0.5); border: 1px solid rgba(124,106,247,0.7); }
  .flame-bar.kind-llm { background: rgba(91,156,246,0.5); border: 1px solid rgba(91,156,246,0.7); }
  .flame-bar.kind-tool { background: rgba(74,222,128,0.35); border: 1px solid rgba(74,222,128,0.6); }
  .flame-bar.kind-error { background: rgba(248,113,113,0.4); border: 1px solid rgba(248,113,113,0.7); }
  .flame-bar.kind-compaction { background: rgba(251,146,60,0.4); border: 1px solid rgba(251,146,60,0.7); }
  
  /* Empty / loading */
  .empty { display: flex; flex-direction: column; align-items: center; justify-content: center; flex: 1; gap: 12px; color: var(--muted); }
  .empty-icon { font-size: 40px; opacity: 0.4; }
  .spinner { width: 20px; height: 20px; border: 2px solid var(--border); border-top-color: var(--accent); border-radius: 50%; animation: spin 0.7s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
  
  /* Replay controls */
  .replay-bar { padding: 10px 20px; border-top: 1px solid var(--border); display: flex; align-items: center; gap: 12px; }
  .replay-progress { flex: 1; height: 4px; background: var(--border); border-radius: 2px; overflow: hidden; cursor: pointer; }
  .replay-fill { height: 100%; background: var(--accent); transition: width 0.2s; }
  .replay-time { color: var(--muted); font-size: 11px; min-width: 80px; text-align: right; }
  
  /* Scrollbar */
  ::-webkit-scrollbar { width: 6px; height: 6px; }
  ::-webkit-scrollbar-track { background: transparent; }
  ::-webkit-scrollbar-thumb { background: var(--border); border-radius: 3px; }
  
  /* Tooltip */
  .tooltip { position: fixed; background: var(--surface2); border: 1px solid var(--border); border-radius: 6px; padding: 6px 10px; font-size: 11px; pointer-events: none; z-index: 100; display: none; max-width: 300px; }
</style>
</head>
<body>

<div class="shell">
  <!-- Sidebar: trace list -->
  <aside class="sidebar">
    <div class="header">
      <div class="logo">Lobs <span>Replay</span></div>
      <div class="header-actions">
        <button class="btn" onclick="seedDemo()" id="seed-btn">✦ Seed Demo</button>
        <button class="btn" onclick="loadTraces()">↻ Refresh</button>
      </div>
    </div>
    <div class="sidebar-header">
      <span id="trace-count">Traces</span>
      <span id="last-refresh" style="font-size:10px;"></span>
    </div>
    <div class="trace-list" id="trace-list">
      <div class="empty"><div class="spinner"></div></div>
    </div>
  </aside>

  <!-- Main: replay panel -->
  <main class="main">
    <div id="main-empty" class="empty" style="flex:1;">
      <div class="empty-icon">🔍</div>
      <div>Select a trace to replay</div>
    </div>
    <div id="main-panel" style="display:none;flex-direction:column;height:100%;overflow:hidden;">
      <div class="panel-header">
        <div>
          <div class="panel-title" id="panel-title">—</div>
          <div class="panel-sub" id="panel-sub">—</div>
        </div>
        <div style="margin-left:auto;display:flex;gap:8px;">
          <button class="btn" onclick="exportOtlp()">↓ OTLP JSON</button>
          <button class="btn btn-primary" id="replay-btn" onclick="startReplay()">▶ Replay</button>
        </div>
      </div>
      <div class="stats-bar" id="stats-bar"></div>
      
      <!-- Flamegraph -->
      <div class="flame-section">
        <div class="flame-title">Execution Timeline (Flamegraph)</div>
        <div class="flame-wrap">
          <div class="flame-canvas" id="flame-canvas"></div>
        </div>
      </div>
      
      <!-- Span timeline -->
      <div class="timeline-wrap" id="timeline-wrap">
        <div class="timeline">
          <div class="tl-connector"></div>
          <div id="span-list"></div>
        </div>
      </div>
      
      <!-- Replay controls -->
      <div class="replay-bar">
        <button class="btn" id="replay-prev" onclick="replayStep(-1)">◀</button>
        <button class="btn" id="replay-next" onclick="replayStep(1)">▶</button>
        <div class="replay-progress" onclick="seekReplay(event)">
          <div class="replay-fill" id="replay-fill" style="width:0%"></div>
        </div>
        <div class="replay-time" id="replay-time">0 / 0</div>
        <button class="btn" onclick="stopReplay()" id="replay-stop" style="display:none;">■ Stop</button>
      </div>
    </div>
  </main>
</div>

<div class="tooltip" id="tooltip"></div>

<script>
const API = '';  // relative — served from same origin
let currentTrace = null;
let currentSpans = [];
let replayIndex = -1;
let replayTimer = null;

// ── Data loading ───────────────────────────────────────────────────────────

async function seedDemo() {
  const btn = document.getElementById('seed-btn');
  btn.textContent = '⏳ Seeding…';
  btn.disabled = true;
  try {
    const r = await fetch(API + '/traces/seed-demo', { method: 'POST' });
    const data = await r.json();
    if (data.ok) {
      btn.textContent = '✓ Seeded!';
      await loadTraces();
    } else {
      btn.textContent = '✗ Error';
      console.error('seed-demo error:', data.error);
    }
  } catch(e) {
    btn.textContent = '✗ Error';
    console.error('seed-demo fetch error:', e);
  } finally {
    setTimeout(() => {
      btn.textContent = '✦ Seed Demo';
      btn.disabled = false;
    }, 2000);
  }
}

async function loadTraces() {
  const list = document.getElementById('trace-list');
  list.innerHTML = '<div class="empty"><div class="spinner"></div></div>';
  try {
    const r = await fetch(API + '/traces?limit=100');
    const data = await r.json();
    renderTraceList(data.traces, data.total);
    document.getElementById('last-refresh').textContent = new Date().toLocaleTimeString();
    document.getElementById('trace-count').textContent = \`\${data.total} traces\`;
  } catch(e) {
    list.innerHTML = \`<div class="empty">Error: \${e.message}</div>\`;
  }
}

async function loadTrace(traceId) {
  try {
    const [traceRes, spansRes] = await Promise.all([
      fetch(API + '/traces/' + traceId),
      fetch(API + '/traces/' + traceId + '/spans'),
    ]);
    currentTrace = await traceRes.json();
    const spansData = await spansRes.json();
    currentSpans = spansData.spans || [];
    replayIndex = -1;
    renderTracePanel();
  } catch(e) {
    console.error('loadTrace error:', e);
  }
}

// ── Rendering ──────────────────────────────────────────────────────────────

function renderTraceList(traces, total) {
  const list = document.getElementById('trace-list');
  if (!traces.length) {
    list.innerHTML = '<div class="empty"><div class="empty-icon">📭</div><div>No traces yet</div><div style="font-size:11px;color:var(--muted)">Run an agent task to see traces here</div></div>';
    return;
  }
  list.innerHTML = traces.map(t => {
    const dur = t.durationMs ? formatDur(t.durationMs) : (t.status === 'running' ? '…' : '?');
    const ts = new Date(t.startTimeMs).toLocaleString();
    const taskPreview = t.taskSummary ? t.taskSummary.slice(0, 60) : (t.taskId ? 'task:' + t.taskId.slice(0,16) : 'no task');
    return \`<div class="trace-item" onclick="selectTrace('\${t.traceId}')" id="titem-\${t.traceId}">
      <div class="trace-agent">\${escHtml(t.agentType)}</div>
      <div class="trace-task">\${escHtml(taskPreview)}</div>
      <div class="trace-meta">
        <span class="badge badge-\${t.status}">\${t.status}</span>
        <span class="badge badge-llm">\${t.totalTurns}t</span>
        <span class="badge badge-tool">\${t.totalToolCalls}🔧</span>
        <span class="trace-time">\${dur}</span>
      </div>
      <div class="trace-time" style="margin-top:4px;">\${ts}</div>
    </div>\`;
  }).join('');
}

function selectTrace(traceId) {
  document.querySelectorAll('.trace-item').forEach(el => el.classList.remove('active'));
  const el = document.getElementById('titem-' + traceId);
  if (el) el.classList.add('active');
  document.getElementById('main-empty').style.display = 'none';
  document.getElementById('main-panel').style.display = 'flex';
  loadTrace(traceId);
}

function renderTracePanel() {
  const t = currentTrace;
  document.getElementById('panel-title').textContent = t.agentType + (t.model ? '  ·  ' + t.model : '');
  document.getElementById('panel-sub').textContent = 
    (t.taskId ? 'task:' + t.taskId.slice(0,24) : 'no task') + '  ·  trace:' + t.traceId.slice(0,16);
  
  // Stats bar
  const dur = t.durationMs ? formatDur(t.durationMs) : (t.status === 'running' ? 'running…' : '—');
  const cost = t.costUsd != null ? '$' + t.costUsd.toFixed(4) : '—';
  document.getElementById('stats-bar').innerHTML = \`
    <div class="stat"><div class="stat-val">\${dur}</div><div class="stat-label">Duration</div></div>
    <div class="stat"><div class="stat-val">\${t.totalTurns}</div><div class="stat-label">LLM Turns</div></div>
    <div class="stat"><div class="stat-val">\${t.totalToolCalls}</div><div class="stat-label">Tool Calls</div></div>
    <div class="stat"><div class="stat-val">\${(t.inputTokens + t.outputTokens).toLocaleString()}</div><div class="stat-label">Total Tokens</div></div>
    <div class="stat"><div class="stat-val">\${cost}</div><div class="stat-label">Cost</div></div>
    <div class="stat"><div class="stat-val"><span class="badge badge-\${t.status}">\${t.status}</span></div><div class="stat-label">Status</div></div>
  \`;

  renderFlamegraph();
  renderSpanList(currentSpans.length);  // show all initially
  updateReplayUI();
}

function renderFlamegraph() {
  const spans = currentSpans;
  if (!spans.length) return;
  
  const canvas = document.getElementById('flame-canvas');
  if (!spans.length) { canvas.innerHTML = ''; return; }
  
  const minT = Math.min(...spans.map(s => s.startTimeMs));
  const maxT = Math.max(...spans.map(s => s.endTimeMs || s.startTimeMs + 100));
  const totalMs = maxT - minT || 1;
  
  // Assign lanes to spans (simple greedy bin-packing)
  const lanes = [];
  const spanLanes = new Map();
  
  for (const span of spans) {
    const endT = span.endTimeMs || span.startTimeMs + 100;
    let placed = false;
    for (let i = 0; i < lanes.length; i++) {
      if (lanes[i] <= span.startTimeMs) {
        lanes[i] = endT;
        spanLanes.set(span.spanId, i);
        placed = true;
        break;
      }
    }
    if (!placed) {
      spanLanes.set(span.spanId, lanes.length);
      lanes.push(endT);
    }
  }
  
  const containerWidth = canvas.parentElement.offsetWidth - 32;
  canvas.style.width = containerWidth + 'px';
  canvas.style.height = (lanes.length * 24 + 4) + 'px';
  
  canvas.innerHTML = spans.map(span => {
    const left = ((span.startTimeMs - minT) / totalMs) * 100;
    const endT = span.endTimeMs || span.startTimeMs + 100;
    const width = Math.max(0.5, ((endT - span.startTimeMs) / totalMs) * 100);
    const lane = spanLanes.get(span.spanId) || 0;
    const top = lane * 24;
    const label = span.name.replace(/^(tool:|llm:|agent:|error:)/, '');
    const dur = span.durationMs ? formatDur(span.durationMs) : '';
    return \`<div class="flame-bar kind-\${span.kind}" 
      style="left:\${left}%;width:\${width}%;top:\${top}px;"
      title="\${span.name} — \${dur}"
      onclick="highlightSpan('\${span.spanId}')">\${escHtml(label)}</div>\`;
  }).join('');
}

function renderSpanList(showUpTo) {
  const spans = currentSpans.slice(0, showUpTo);
  const html = spans.map((span, i) => {
    const dur = span.durationMs != null ? formatDur(span.durationMs) : (span.status === 'running' ? '…' : '?');
    const isErr = span.status === 'error';
    return \`<div class="span-row" id="spanrow-\${span.spanId}" style="padding-left:\${span.parentSpanId ? 28 : 0}px">
      <div class="span-dot kind-\${span.kind} status-\${span.status}"></div>
      <div class="span-card" id="spancard-\${span.spanId}" onclick="toggleSpan('\${span.spanId}', \${i})">
        <div class="span-main">
          <span class="badge badge-\${span.kind}">\${span.kind}</span>
          <span class="span-name\${isErr ? ' ' : ''}" style="\${isErr ? 'color:var(--red)' : ''}">\${escHtml(span.name)}</span>
          <span class="span-duration">\${dur}</span>
        </div>
        <div class="span-detail" id="spandetail-\${span.spanId}" style="display:none;">
          <div class="detail-grid">
            \${renderAttrs(span.attributes)}
            \${span.events && span.events.length ? '<div class="detail-key" style="grid-column:1/-1;margin-top:6px;font-weight:600">Events</div>' + span.events.map(e => \`<div class="detail-key">\${e.name}</div><div class="detail-val">\${new Date(e.timeMs).toISOString()}</div>\`).join('') : ''}
          </div>
        </div>
      </div>
    </div>\`;
  }).join('');
  document.getElementById('span-list').innerHTML = html;
}

function renderAttrs(attrs) {
  return Object.entries(attrs || {}).map(([k, v]) => {
    const val = typeof v === 'string' && v.length > 200 ? v : String(v);
    const isPreview = k.includes('preview') || k.includes('params');
    const isError = k.includes('error');
    return \`<div class="detail-key">\${escHtml(k)}</div>
      <div class="detail-val \${isPreview ? 'preview' : ''} \${isError && v ? 'error' : ''}">\${escHtml(val)}</div>\`;
  }).join('');
}

function toggleSpan(spanId) {
  const detail = document.getElementById('spandetail-' + spanId);
  const card = document.getElementById('spancard-' + spanId);
  if (detail.style.display === 'none') {
    detail.style.display = 'block';
    card.classList.add('expanded');
  } else {
    detail.style.display = 'none';
    card.classList.remove('expanded');
  }
}

function highlightSpan(spanId) {
  document.querySelectorAll('.span-card').forEach(el => el.classList.remove('expanded'));
  const card = document.getElementById('spancard-' + spanId);
  if (card) {
    card.classList.add('expanded');
    document.getElementById('spandetail-' + spanId).style.display = 'block';
    card.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
}

// ── Replay ─────────────────────────────────────────────────────────────────

function startReplay() {
  if (replayTimer) { stopReplay(); return; }
  replayIndex = 0;
  renderSpanList(1);
  updateReplayUI();
  document.getElementById('replay-stop').style.display = '';
  document.getElementById('replay-btn').textContent = '⏸ Pause';
  
  replayTimer = setInterval(() => {
    replayIndex++;
    if (replayIndex >= currentSpans.length) {
      stopReplay();
      renderSpanList(currentSpans.length);
      return;
    }
    renderSpanList(replayIndex + 1);
    updateReplayUI();
    // Scroll to latest
    const lastId = currentSpans[replayIndex]?.spanId;
    if (lastId) {
      const el = document.getElementById('spanrow-' + lastId);
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'end' });
    }
  }, 600);
}

function stopReplay() {
  if (replayTimer) { clearInterval(replayTimer); replayTimer = null; }
  document.getElementById('replay-stop').style.display = 'none';
  document.getElementById('replay-btn').textContent = '▶ Replay';
}

function replayStep(delta) {
  stopReplay();
  replayIndex = Math.max(-1, Math.min(currentSpans.length - 1, replayIndex + delta));
  renderSpanList(replayIndex + 1);
  updateReplayUI();
}

function seekReplay(event) {
  const rect = event.currentTarget.getBoundingClientRect();
  const pct = (event.clientX - rect.left) / rect.width;
  replayIndex = Math.floor(pct * currentSpans.length) - 1;
  stopReplay();
  renderSpanList(replayIndex + 1);
  updateReplayUI();
}

function updateReplayUI() {
  const idx = Math.max(0, replayIndex + 1);
  const total = currentSpans.length;
  const pct = total ? (idx / total) * 100 : 0;
  document.getElementById('replay-fill').style.width = pct + '%';
  document.getElementById('replay-time').textContent = idx + ' / ' + total;
}

// ── Export ─────────────────────────────────────────────────────────────────

function exportOtlp() {
  if (!currentTrace) return;
  const url = API + '/traces/' + currentTrace.traceId + '/export';
  const a = document.createElement('a');
  a.href = url;
  a.download = 'trace-' + currentTrace.traceId.slice(0, 8) + '.otlp.json';
  a.click();
}

// ── Utilities ──────────────────────────────────────────────────────────────

function formatDur(ms) {
  if (ms < 1000) return ms + 'ms';
  if (ms < 60000) return (ms / 1000).toFixed(1) + 's';
  return Math.floor(ms / 60000) + 'm ' + Math.floor((ms % 60000) / 1000) + 's';
}

function escHtml(str) {
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ── Init ───────────────────────────────────────────────────────────────────
loadTraces();
// Auto-refresh every 30s
setInterval(loadTraces, 30000);
</script>
</body>
</html>`;
}
