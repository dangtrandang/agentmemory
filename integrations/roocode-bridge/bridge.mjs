/**
 * Bridge: Nhập task history từ Roo Code / Zoo Code vào agentmemory
 *
 * Usage:
 *   node bridge.mjs [--dry-run] [--workspace "path-filter"] [--quiet]
 *   npx @agentmemory/roocode-bridge --dry-run
 *
 * State file: ~/.agentmemory/bridge-state.json — tracks taskId → {mtime, sessionId, importedAt}
 *
 * Cơ chế:
 *   - Active guard: file sửa < 10 phút → skip (đang được agent dùng)
 *   - New task: chưa có trong state → import mới
 *   - Updated task: mtime mới hơn state → tạo session mới (session cũ giữ nguyên completed)
 *   - Unchanged: mtime bằng state → skip
 *
 * API contracts (agentmemory v0.9.x):
 *   POST /agentmemory/session/start  { sessionId, project, cwd, title? }
 *   POST /agentmemory/session/end    { sessionId }
 *   POST /agentmemory/observe        { hookType, sessionId, project, cwd, timestamp, data }
 */

import fs from "fs";
import path from "path";
import crypto from "crypto";

const AGENTMEMORY_URL = process.env.AGENTMEMORY_URL || "http://localhost:3111";
const AGENTMEMORY_SECRET = process.env.AGENTMEMORY_SECRET || "";
const TASKS_DIR = path.join(
  process.env.APPDATA || path.join(process.env.HOME || "", "AppData", "Roaming"),
  "Code", "User", "globalStorage", "zoocodeorganization.zoo-code", "tasks"
);
const STATE_DIR = path.join(process.env.USERPROFILE || process.env.HOME || "", ".agentmemory");
const STATE_PATH = path.join(STATE_DIR, "bridge-state.json");
const ACTIVE_THRESHOLD = 10 * 60 * 1000; // 10 phút

function uuid() { return crypto.randomUUID(); }
function now() { return new Date().toISOString(); }

// --- State management ---

function loadState() {
  try {
    if (fs.existsSync(STATE_PATH)) return JSON.parse(fs.readFileSync(STATE_PATH, "utf-8"));
  } catch { /* corrupted state? start fresh */ }
  return {};
}

function saveState(state) {
  if (!fs.existsSync(STATE_DIR)) fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

// --- API helpers ---

function authHeaders() {
  const h = { "Content-Type": "application/json" };
  if (AGENTMEMORY_SECRET) h["Authorization"] = `Bearer ${AGENTMEMORY_SECRET}`;
  return h;
}

async function api(method, urlPath, body) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    const res = await fetch(`${AGENTMEMORY_URL}${urlPath}`, {
      method,
      headers: authHeaders(),
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`${method} ${urlPath} → ${res.status}: ${text.slice(0, 200)}`);
    }
    try { return JSON.parse(text); } catch { return text; }
  } finally {
    clearTimeout(timeout);
  }
}

async function startSession(sessionId, project, cwd, title) {
  return api("POST", "/agentmemory/session/start", {
    sessionId,
    project,
    cwd,
    ...(title ? { title: title.slice(0, 200) } : {}),
  });
}

async function postObserve(sessionId, hookType, project, cwd, ts, data) {
  return api("POST", "/agentmemory/observe", {
    hookType,
    sessionId,
    project,
    cwd,
    timestamp: new Date(ts).toISOString(),
    data,
  });
}

async function endSession(sessionId) {
  return api("POST", "/agentmemory/session/end", { sessionId });
}

// --- Conversation parsing ---

function extractConversation(messages) {
  const turns = [];
  let currentUser = null;

  for (const msg of messages) {
    if (msg.role === "user") {
      const content = Array.isArray(msg.content)
        ? msg.content
        : [{ type: "text", text: String(msg.content || "") }];
      const textContent = content
        .filter(c => c.type === "text")
        .map(c => c.text)
        .join("\n");
      const userMsgMatch = textContent.match(/<user_message>\s*\n?(.*?)\n?\s*<\/user_message>/s);
      if (userMsgMatch) {
        currentUser = { prompt: userMsgMatch[1].trim(), ts: msg.ts, toolCalls: [] };
      }
    } else if (msg.role === "assistant" && currentUser) {
      const content = Array.isArray(msg.content)
        ? msg.content
        : [{ type: "text", text: String(msg.content || "") }];
      const textParts = content
        .filter(c => c.type === "text")
        .map(c => c.text)
        .join("\n");
      const toolParts = content.filter(c => c.type === "tool_use");
      currentUser.assistantResponse = textParts.slice(0, 2000);
      currentUser.toolCalls = toolParts.map(t => t.name).slice(0, 20);
      turns.push(currentUser);
      currentUser = null;
    }
  }
  return turns;
}

function extractTokenUsage(messages) {
  const lastAssistant = [...messages].reverse().find(m => m.role === "assistant");
  if (!lastAssistant) return null;
  return {
    tokensIn: lastAssistant.usage?.input_tokens || 0,
    tokensOut: lastAssistant.usage?.output_tokens || 0,
  };
}

// --- Import one task ---

async function importTask(task, state, turns, messages) {
  const taskLabel = `[${task.mode || "code"}] ${task.task?.slice(0, 180) || "No task"}`;
  const convPath = path.join(TASKS_DIR, task.id, "api_conversation_history.json");
  const fileMtime = fs.statSync(convPath).mtimeMs;
  const existing = state[task.id];

  // Unchanged → skip
  if (existing && existing.mtime === fileMtime) {
    return { action: "skip-unchanged", label: taskLabel };
  }

  // Updated → mark old state entry as stale, but keep session in agentmemory
  // (no DELETE endpoint exists; old session stays as completed)
  if (existing && existing.sessionId && existing.mtime !== fileMtime) {
    // Note: old session already ended; we create a new one below
    delete state[task.id]; // will be re-set with new sessionId at end
  }

  if (turns.length === 0) {
    return { action: "skip-no-turns", label: taskLabel };
  }

  const sessionId = uuid();
  const cwd = task.workspace || process.cwd();
  // project: extract from workspace path (mimics resolveProject in session-start hook)
  const projectName = (task.workspace && path.basename(task.workspace)) || "roocode";

  await startSession(sessionId, projectName, cwd, taskLabel);

  for (let i = 0; i < turns.length; i++) {
    const turn = turns[i];
    const tokenUsage = i === turns.length - 1 ? extractTokenUsage(messages) : null;
    await postObserve(
      sessionId,
      "prompt_submit",
      projectName,
      cwd,
      turn.ts || task.ts,
      {
        prompt: turn.prompt,
        assistantResponse: turn.assistantResponse,
        toolCalls: turn.toolCalls,
        ...(tokenUsage ? { tokenUsage } : {}),
      }
    );
  }

  await endSession(sessionId);

  state[task.id] = { mtime: fileMtime, sessionId, importedAt: now() };
  saveState(state);

  return { action: existing ? "updated" : "new", label: taskLabel, sessionId };
}

// --- Main ---

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const quiet = args.includes("--quiet");
  const wsIdx = args.indexOf("--workspace");
  const workspaceFilter = wsIdx >= 0 ? args[wsIdx + 1] : null;

  const indexPath = path.join(TASKS_DIR, "_index.json");
  let indexData;
  try {
    indexData = JSON.parse(fs.readFileSync(indexPath, "utf-8"));
  } catch (e) {
    console.error("[roocode-bridge] Không đọc được _index.json:", e.message);
    process.exit(1);
  }

  let tasks = indexData.entries || [];
  if (workspaceFilter) {
    tasks = tasks.filter(t =>
      (t.workspace || "").toLowerCase().includes(workspaceFilter.toLowerCase())
    );
  }
  tasks.sort((a, b) => b.ts - a.ts);

  const state = loadState();
  const stats = { new: 0, updated: 0, skipped: 0, unchanged: 0 };
  const NOW = Date.now();

  for (const task of tasks) {
    const convPath = path.join(TASKS_DIR, task.id, "api_conversation_history.json");
    if (!fs.existsSync(convPath)) { stats.skipped++; continue; }

    // Active guard
    const fileStat = fs.statSync(convPath);
    const fileAge = NOW - fileStat.mtimeMs;
    if (fileAge < ACTIVE_THRESHOLD) {
      if (!quiet) {
        console.log(`  SKIP (active ~${Math.round(fileAge / 60_000)}ph): ${(task.task || "").slice(0, 60)}`);
      }
      stats.skipped++;
      continue;
    }

    // Quick unchanged check (tránh parse JSON không cần thiết)
    const existing = state[task.id];
    if (existing && existing.mtime === fileStat.mtimeMs) {
      stats.unchanged++;
      continue;
    }

    // Parse conversation
    let messages;
    try {
      messages = JSON.parse(fs.readFileSync(convPath, "utf-8"));
    } catch { stats.skipped++; continue; }
    if (!Array.isArray(messages) || messages.length === 0) { stats.skipped++; continue; }

    const turns = extractConversation(messages);
    if (turns.length === 0) { stats.skipped++; continue; }

    const taskLabel = `[${task.mode || "code"}] ${task.task?.slice(0, 180) || "No task"}`;

    if (dryRun) {
      const action = existing && existing.mtime !== fileStat.mtimeMs
        ? "CAP NHAT (updated)"
        : "MOI (new)";
      if (!quiet || action.includes("updated")) {
        console.log(`\n  ${action}: ${taskLabel.slice(0, 80)} (${turns.length} turns, ${((task.tokensIn || 0) / 1000).toFixed(0)}K tokens)`);
      }
      if (existing && existing.mtime !== fileStat.mtimeMs) stats.updated++;
      else stats.new++;
      continue;
    }

    console.log(`\n  ${existing ? "CAP NHAT (updated)" : "MOI (new)"}: ${taskLabel.slice(0, 80)} (${turns.length} turns, ${((task.tokensIn || 0) / 1000).toFixed(0)}K tokens)`);

    try {
      const result = await importTask(task, state, turns, messages);
      if (result.action === "new") stats.new++;
      else if (result.action === "updated") stats.updated++;
      else stats.skipped++;
      console.log(`  ✓ ${result.action === "updated" ? "Updated" : "Done"} (session: ${result.sessionId?.slice(0, 12) || "n/a"})`);
    } catch (e) {
      console.error(`  FAIL: ${e.message}`);
    }
  }

  saveState(state);

  console.log(`\n=== KET QUA ===`);
  console.log(`Moi (new):        ${stats.new}`);
  console.log(`Cap nhat (updated): ${stats.updated}`);
  console.log(`Khong doi (unchanged): ${stats.unchanged}`);
  console.log(`Skip:             ${stats.skipped}`);
  console.log(`Total tasks:      ${tasks.length}`);
  if (dryRun) console.log(`Mode:             DRY-RUN (không ghi dữ liệu)`);
  console.log(`Dashboard:        http://localhost:3113`);
}

main().catch(e => { console.error("FATAL:", e); process.exit(1); });
