#!/usr/bin/env node
// codex-p-proxy — local OpenAI-compatible API server backed by `codex exec`
// Personal use only: calls the Codex CLI logged in with your ChatGPT subscription.
// Supports: text, streaming (sent once complete), image input, function calling (tool use). No dependencies (Node 18+).
// Run: node server.mjs

import http from "node:http";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, existsSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

// Find the codex CLI: CODEX_BIN → CLI installed by npm install → codex on PATH
const HERE = dirname(fileURLToPath(import.meta.url));
function findCodex() {
  if (process.env.CODEX_BIN) return process.env.CODEX_BIN;
  const local = join(HERE, "node_modules", ".bin", process.platform === "win32" ? "codex.cmd" : "codex");
  return existsSync(local) ? local : "codex";
}

// --port 9000 (or PORT=9000). If not set explicitly and 8790 is busy, move on to the next free port
const argPort = process.argv.includes("--port") ? process.argv[process.argv.indexOf("--port") + 1] : undefined;
const CFG = {
  host: process.env.HOST || "127.0.0.1",           // local access only (do not expose)
  port: Number(argPort || process.env.PORT || 8790),
  portExplicit: Boolean(argPort || process.env.PORT),
  apiKey: process.env.LOCAL_API_KEY || "",          // if set, check the Bearer token
  codexBin: findCodex(),
  defaultModel: process.env.DEFAULT_MODEL || "",    // empty → Codex default model
  defaultEffort: process.env.DEFAULT_EFFORT || "low",
  maxConcurrent: Number(process.env.MAX_CONCURRENT || 2),
  timeoutMs: Number(process.env.TIMEOUT_MS || 300_000),
  maxImageBytes: Number(process.env.MAX_IMAGE_BYTES || 10 * 1024 * 1024),
  defaultSystem: process.env.DEFAULT_SYSTEM ||
    "You are a helpful assistant. Answer the user's latest message directly.",
};

const TAG_OPEN = "<tool_calls>", TAG_CLOSE = "</tool_calls>";
const EFFORTS = ["low", "medium", "high", "xhigh", "max", "ultra"];

// Codex is a coding agent and adds lots of tool/skill/plugin instructions by default → turn them all off for a plain chatbot
const DISABLED_FEATURES = ["apps", "browser_use", "browser_use_external", "code_mode_host", "computer_use", "goals",
  "hooks", "image_generation", "in_app_browser", "multi_agent", "plugins", "remote_plugin", "shell_tool", "skill_search",
  "sleep_tool", "tool_suggest", "unified_exec", "view_image"];
const CODEX_OVERRIDES = ["skills.include_instructions=false", "skills.bundled.enabled=false",
  "include_permissions_instructions=false", "include_environment_context=false",
  "include_collaboration_mode_instructions=false", 'web_search="disabled"'];
// Built-in tools that can't be turned off (Code Mode etc.) fail because their host is off, but each attempt adds a round trip, so forbid them
const NO_BUILTIN_TOOLS = "\n\nYou cannot run code, read files, browse, or use any built-in tools. Never try to; answer directly from your own knowledge.";

// ---------- Model list (codex debug models) ----------
function loadModels() {
  const r = spawnSync(CFG.codexBin, ["debug", "models"], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
  try {
    const j = JSON.parse(r.stdout);
    return (j.models || j).filter((m) => m.visibility !== "hide").map((m) => m.slug || m.id).filter(Boolean);
  } catch { return []; }
}

// Names in the list are used as is; anything else (gpt-4o etc.) goes to DEFAULT_MODEL (or the Codex default)
function mapModel(name) {
  if (name && MODELS.includes(name)) return name;
  return CFG.defaultModel || undefined;
}

// =====================================================================
// 1. Input normalization: OpenAI messages → internal format
//    turn = { role: "user"|"assistant", parts: [...] }
//    part = {kind:"text",text} | {kind:"image",url|media_type+data}
//         | {kind:"tool_call",id,name,args} | {kind:"tool_result",id,name,parts}
// =====================================================================
function imageFromUrl(url) {
  const m = /^data:([^;,]+);base64,(.*)$/s.exec(url || "");
  return m ? { kind: "image", media_type: m[1], data: m[2] } : { kind: "image", url };
}

function oaParts(content) {
  if (content == null) return [];
  if (typeof content === "string") return [{ kind: "text", text: content }];
  return content.flatMap((p) => {
    if (typeof p === "string") return [{ kind: "text", text: p }];
    if (p.type === "text" || p.type === "input_text") return [{ kind: "text", text: p.text ?? "" }];
    if (p.type === "image_url") return [imageFromUrl(typeof p.image_url === "string" ? p.image_url : p.image_url?.url)];
    if (p.type === "input_image") return [imageFromUrl(p.image_url)];
    return [];
  });
}

function normalizeOpenAI(messages = []) {
  const system = [], turns = [], callNames = {};
  for (const m of messages) {
    if (m.role === "system" || m.role === "developer") { system.push(oaParts(m.content).map((p) => p.text).join("\n")); continue; }
    if (m.role === "assistant") {
      const parts = oaParts(m.content);
      for (const tc of m.tool_calls || []) {
        callNames[tc.id] = tc.function?.name;
        parts.push({ kind: "tool_call", id: tc.id, name: tc.function?.name, args: safeJson(tc.function?.arguments, {}) });
      }
      if (m.function_call) parts.push({ kind: "tool_call", id: "legacy", name: m.function_call.name, args: safeJson(m.function_call.arguments, {}) });
      turns.push({ role: "assistant", parts });
    } else if (m.role === "tool" || m.role === "function") {
      turns.push({ role: "user", parts: [{ kind: "tool_result", id: m.tool_call_id || "legacy", name: m.name || callNames[m.tool_call_id], parts: oaParts(m.content) }] });
    } else {
      turns.push({ role: "user", parts: oaParts(m.content) });
    }
  }
  return { system: system.join("\n\n"), turns };
}

// Tool definitions → [{name, description, schema}]
function normalizeTools(body) {
  const list = body.tools || (body.functions || []).map((f) => ({ type: "function", function: f }));
  return list.filter((t) => t.type === "function" && t.function?.name)
    .map((t) => ({ name: t.function.name, description: t.function.description || "", schema: t.function.parameters || { type: "object", properties: {} } }));
}

// tool_choice → {mode:"auto"|"none"|"required"|"specific", name?}
function normalizeChoice(tc) {
  if (!tc) return { mode: "auto" };
  if (typeof tc === "string") return { mode: tc === "required" ? "required" : tc === "none" ? "none" : "auto" };
  if (tc.type === "function") return { mode: "specific", name: tc.function?.name };
  if (tc.name) return { mode: "specific", name: tc.name };             // legacy function_call: {name}
  return { mode: "auto" };
}

// =====================================================================
// 2. Internal format → codex exec input (prompt text + image files)
// =====================================================================
async function resolveImage(p) {
  if (p.data) return p;
  const r = await fetch(p.url);
  if (!r.ok) throw new Error(`image download failed (${r.status}): ${p.url}`);
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.length > CFG.maxImageBytes) throw new Error(`image too large: ${p.url}`);
  const media_type = (r.headers.get("content-type") || "image/png").split(";")[0];
  return { kind: "image", media_type, data: buf.toString("base64") };
}

async function buildInput(turns) {
  const images = [];
  const render = async (parts) => {
    const out = [], calls = [];
    for (const p of parts) {
      if (p.kind === "text") out.push(p.text);
      else if (p.kind === "image") { images.push(await resolveImage(p)); out.push(`[image ${images.length}]`); }
      else if (p.kind === "tool_call") calls.push({ id: p.id, name: p.name, arguments: p.args });
      else if (p.kind === "tool_result") {
        const inner = await render(p.parts || []);
        out.push(`<tool_result id="${p.id}"${p.name ? ` name="${p.name}"` : ""}>\n${inner}\n</tool_result>`);
      }
    }
    if (calls.length) out.push(`${TAG_OPEN}\n${JSON.stringify(calls)}\n${TAG_CLOSE}`);
    return out.filter(Boolean).join("\n");
  };

  // Merge consecutive turns with the same role (e.g. several tool results)
  const merged = [];
  for (const t of turns) {
    const prev = merged[merged.length - 1];
    if (prev && prev.role === t.role) prev.parts.push(...t.parts); else merged.push({ role: t.role, parts: [...t.parts] });
  }
  const rendered = [];
  for (const t of merged) rendered.push({ role: t.role, text: await render(t.parts) });

  let text;
  const last = rendered[rendered.length - 1];
  if (rendered.length === 1 && last.role === "user") text = last.text;
  else {
    const history = rendered.slice(0, -1).map((t) => `<${t.role}>\n${t.text}\n</${t.role}>`).join("\n");
    text = `<conversation_history>\n${history}\n</conversation_history>\n\n` +
      (last?.role === "user"
        ? `Continue the conversation. Reply only as the assistant to this latest message:\n\n${last.text}`
        : `Continue the assistant's last message:\n\n${last?.text ?? ""}`);
  }
  return { text, images };
}

// Tool-use instructions (appended to the system prompt)
function toolInstructions(tools, choice) {
  if (!tools.length || choice.mode === "none") return "";
  const defs = tools.map((t) => ({ name: t.name, description: t.description, parameters: t.schema }));
  let rule = "Call tools only when they are needed; otherwise answer normally without the block.";
  if (choice.mode === "required") rule = "You MUST call at least one tool in this reply.";
  if (choice.mode === "specific") rule = `You MUST call the tool "${choice.name}" in this reply.`;
  return `

# Tools
You can call these tools (JSON Schema for each tool's arguments):
${JSON.stringify(defs, null, 2)}

To call tools, end your reply with exactly this block and nothing after it:
${TAG_OPEN}
[{"name": "<tool name>", "arguments": { ... }}]
${TAG_CLOSE}

Rules:
- The block must contain a valid JSON array; several calls may go in one array.
- Use only the tools listed above, with arguments that match their schema.
- After the block, stop. Tool results will come back to you in <tool_result> tags.
- You can write a short sentence before the block, but never invent tool results yourself.
- ${rule}`;
}

// Extract the tool-call block from model output
function safeJson(s, fallback) {
  if (s && typeof s === "object") return s;
  try { return JSON.parse(s); } catch { return fallback; }
}
function parseToolCalls(text, tools) {
  const i = text.indexOf(TAG_OPEN);
  if (i < 0 || !tools.length) return { text, calls: [] };
  const j = text.indexOf(TAG_CLOSE, i);
  let raw = text.slice(i + TAG_OPEN.length, j < 0 ? undefined : j).trim()
    .replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  let arr = safeJson(raw, null);
  if (arr && !Array.isArray(arr)) arr = [arr];
  const names = new Set(tools.map((t) => t.name));
  const calls = (arr || [])
    .filter((c) => c && names.has(c.name))
    .map((c) => ({ name: c.name, args: safeJson(c.arguments ?? c.input ?? c.parameters, {}) ?? {} }));
  if (!calls.length) return { text, calls: [] };           // parse failed → treat as plain text
  return { text: text.slice(0, i).trim(), calls };
}

// =====================================================================
// 3. Run codex exec
// =====================================================================
let running = 0;
const queue = [];
function acquire() {
  return new Promise((res) => { if (running < CFG.maxConcurrent) { running++; res(); } else queue.push(res); });
}
function release() { const next = queue.shift(); if (next) next(); else running--; }

const EXT = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp" };

// Codex error messages often come wrapped in a JSON string → pull out the inner message
function codexError(msg) {
  const j = safeJson(msg, null);
  return j?.error?.message || j?.message || msg || "codex error";
}

/** Run codex exec. Returns { text, usage, model } */
async function runCodex({ input, system, model, effort, signal }) {
  await acquire();
  // Empty temp folder per request: keeps project context (AGENTS.md etc.) out; images and the system prompt file go here too
  const dir = mkdtempSync(join(tmpdir(), "codex-proxy-"));
  try {
    if (signal?.aborted) throw new Error("client disconnected");   // client left while queued → don't run
    writeFileSync(join(dir, "system.md"), system || CFG.defaultSystem);
    const imageArgs = input.images.map((img, n) => {
      const file = join(dir, `image-${n + 1}.${EXT[img.media_type] || "png"}`);
      writeFileSync(file, Buffer.from(img.data, "base64"));
      return `--image=${file}`;
    });
    const args = [
      "exec", "--json", "--ephemeral", "--skip-git-repo-check",
      "--ignore-user-config",           // ignore MCP servers, notify hooks and default model in ~/.codex/config.toml (login still used)
      "-s", "read-only", "-C", dir,
      ...DISABLED_FEATURES.flatMap((f) => ["--disable", f]),
      ...CODEX_OVERRIDES.flatMap((c) => ["-c", c]),
      "-c", `model_instructions_file=${JSON.stringify(join(dir, "system.md"))}`,
      "-c", `model_reasoning_effort="${effort || CFG.defaultEffort}"`,
      ...(model ? ["-m", model] : []),
      ...imageArgs,
      "-",                              // prompt comes from stdin
    ];
    const env = { ...process.env };
    delete env.OPENAI_API_KEY;          // force the ChatGPT subscription login (no API billing)
    delete env.CODEX_API_KEY;

    return await new Promise((resolve, reject) => {
      const child = spawn(CFG.codexBin, args, { cwd: dir, env, stdio: ["pipe", "pipe", "pipe"] });
      let buf = "", texts = [], usage = {}, stderr = "", errMsg = null;
      const timer = setTimeout(() => child.kill("SIGTERM"), CFG.timeoutMs);
      signal?.addEventListener("abort", () => child.kill("SIGTERM"));

      child.stdout.on("data", (chunk) => {
        buf += chunk;
        let i;
        while ((i = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
          if (!line) continue;
          let ev; try { ev = JSON.parse(line); } catch { continue; }
          if (ev.type === "item.completed" && ev.item?.type === "agent_message") texts.push(ev.item.text ?? "");
          else if (ev.type === "turn.completed") usage = ev.usage || {};
          else if (ev.type === "turn.failed") errMsg = codexError(ev.error?.message);
          else if (ev.type === "error") errMsg ??= codexError(ev.message);
          // item.completed with type "error" is only a warning → ignore
        }
      });
      child.stderr.on("data", (d) => { stderr += d; });
      child.stdin.on("error", () => {});
      child.on("error", (e) => { clearTimeout(timer); reject(new Error(`failed to run codex: ${e.message}`)); });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (errMsg) return reject(new Error(errMsg));
        if (!texts.length) return reject(new Error(`codex exited with code ${code}: ${stderr.trim().slice(-500) || "no output (check login / usage limits)"}`));
        resolve({ text: texts.join("\n\n"), usage, model });
      });
      child.stdin.end(input.text || "(empty)");
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
    release();
  }
}

// Shared setup: normalized conversation + tools → runCodex arguments
async function prepare(body) {
  const norm = normalizeOpenAI(body.messages);
  const tools = normalizeTools(body);
  const choice = normalizeChoice(body.tool_choice ?? body.function_call);
  const activeTools = choice.mode === "none" ? [] : tools;
  const input = await buildInput(norm.turns);
  const system = (norm.system || CFG.defaultSystem) + NO_BUILTIN_TOOLS + toolInstructions(activeTools, choice);
  return { input, system, model: mapModel(body.model), effort: effortFrom(body), tools: activeTools };
}

// ---------- HTTP helpers ----------
function send(res, status, obj) {
  res.writeHead(status, { "content-type": "application/json", "access-control-allow-origin": "*" });
  res.end(JSON.stringify(obj));
}
function sse(res) {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive", "access-control-allow-origin": "*" });
}
async function readJson(req) {
  let body = ""; for await (const c of req) body += c;
  try { return body ? JSON.parse(body) : {}; }
  catch (e) { throw Object.assign(new Error(`invalid JSON body: ${e.message}`), { status: 400 }); }
}
function authorized(req) {
  if (!CFG.apiKey) return true;
  const bearer = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  return bearer === CFG.apiKey || req.headers["x-api-key"] === CFG.apiKey;
}
function effortFrom(body) {
  const e = body.reasoning_effort || body.reasoning?.effort;
  if (EFFORTS.includes(e)) return e;
  if (e === "minimal" || e === "none") return "low";
  return undefined;
}

// =====================================================================
// 4. OpenAI: POST /v1/chat/completions
// =====================================================================
function oaUsage(u = {}) {
  const p = u.input_tokens || 0, c = (u.output_tokens || 0) + (u.reasoning_output_tokens || 0);
  return {
    prompt_tokens: p, completion_tokens: c, total_tokens: p + c,
    prompt_tokens_details: { cached_tokens: u.cached_input_tokens || 0 },
    completion_tokens_details: { reasoning_tokens: u.reasoning_output_tokens || 0 },
  };
}
const oaToolCalls = (calls) => calls.map((c, index) => ({
  index, id: `call_${randomUUID().replace(/-/g, "").slice(0, 24)}`, type: "function", function: { name: c.name, arguments: JSON.stringify(c.args) },
}));

async function openaiChat(req, res, body, signal) {
  const p = await prepare(body);
  const id = `chatcmpl-${randomUUID()}`, created = Math.floor(Date.now() / 1000), model = body.model || p.model || "codex";

  if (body.stream) {
    // codex exec doesn't stream tokens → send the finished answer in one go
    sse(res);
    const chunk = (delta, finish = null) => res.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
    chunk({ role: "assistant", content: "" });
    try {
      const r = await runCodex({ ...p, signal });
      const { text, calls } = parseToolCalls(r.text, p.tools);
      if (text) chunk({ content: text });
      if (calls.length) {
        oaToolCalls(calls).forEach((tc) => chunk({ tool_calls: [tc] }));
        chunk({}, "tool_calls");
      } else chunk({}, "stop");
      if (body.stream_options?.include_usage) res.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model, choices: [], usage: oaUsage(r.usage) })}\n\n`);
    } catch (e) {
      res.write(`data: ${JSON.stringify({ error: { message: e.message, type: "server_error" } })}\n\n`);
    }
    res.write("data: [DONE]\n\n"); res.end();
    return;
  }

  const r = await runCodex({ ...p, signal });
  const { text, calls } = parseToolCalls(r.text, p.tools);
  const message = { role: "assistant", content: calls.length ? (text || null) : text };
  if (calls.length) message.tool_calls = oaToolCalls(calls).map(({ index, ...tc }) => tc);
  send(res, 200, {
    id, object: "chat.completion", created, model,
    choices: [{ index: 0, message, finish_reason: calls.length ? "tool_calls" : "stop" }],
    usage: oaUsage(r.usage),
  });
}

// =====================================================================
// 5. Routing
// =====================================================================
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  if (req.method === "OPTIONS") {
    res.writeHead(204, { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "GET,POST,OPTIONS" });
    return res.end();
  }
  if (url.pathname === "/health") return send(res, 200, { ok: true, running, queued: queue.length });
  if (!authorized(req)) return send(res, 401, { error: { type: "invalid_request_error", code: "invalid_api_key", message: "invalid api key" } });

  const ac = new AbortController();
  res.on("close", () => { if (!res.writableEnded) ac.abort(); });

  try {
    if (req.method === "GET" && url.pathname === "/v1/models") {
      return send(res, 200, { object: "list", data: MODELS.map((id) => ({ id, object: "model", created: 0, owned_by: "openai" })) });
    }
    if (req.method === "POST" && url.pathname === "/v1/chat/completions") return await openaiChat(req, res, await readJson(req), ac.signal);
    send(res, 404, { error: { type: "invalid_request_error", code: "not_found", message: `${req.method} ${url.pathname}` } });
  } catch (e) {
    console.error("[error]", e.message);
    if (!res.headersSent) send(res, e.status || 500, { error: { type: e.status === 400 ? "invalid_request_error" : "server_error", message: e.message } });
    else res.end();
  }
});

// Check the CLI before starting
const check = spawnSync(CFG.codexBin, ["--version"], { encoding: "utf8", shell: process.platform === "win32" });
if (check.error || check.status !== 0) {
  console.error(`codex CLI not found (${CFG.codexBin}).
  Run 'npm install' in this folder, or install it with 'npm i -g @openai/codex'.
  Then run 'npx codex login' once to sign in with your ChatGPT account.`);
  process.exit(1);
}
const MODELS = loadModels();
console.log(`codex CLI: ${check.stdout.trim()} (${CFG.codexBin})`);

let port = CFG.port;
server.on("error", (e) => {
  if (e.code === "EADDRINUSE" && !CFG.portExplicit && port < CFG.port + 10) {
    console.log(`port ${port} is in use → trying ${port + 1}`);
    return server.listen(++port, CFG.host);
  }
  console.error(e.code === "EADDRINUSE" ? `port ${port} is already in use. Pick another one with --port.` : e.message);
  process.exit(1);
});
server.listen(port, CFG.host, () => {
  const base = `http://${CFG.host}:${port}`;
  console.log(`codex-p-proxy → ${base}`);
  console.log(`  base_url : ${base}/v1   (OpenAI-compatible, POST /v1/chat/completions)`);
  console.log(`  api_key  : ${CFG.apiKey ? "the LOCAL_API_KEY value" : "any value (e.g. local)"}`);
  console.log(`  models   : ${MODELS.join(", ") || "(none listed)"}`);
  console.log(`  default  : ${CFG.defaultModel || "Codex default"}, effort ${CFG.defaultEffort}, ${CFG.maxConcurrent} concurrent`);
  console.log(`
Example:
  curl ${base}/v1/chat/completions -H 'content-type: application/json' \\
    -d '{"messages":[{"role":"user","content":"Hello"}]}'`);
});
