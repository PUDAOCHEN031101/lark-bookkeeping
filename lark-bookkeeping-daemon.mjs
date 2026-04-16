#!/usr/bin/env node
/**
 * lark-bookkeeping-daemon.mjs — 飞书聊天记账守护进程
 *
 * 监听指定飞书群聊/单聊，收到消息 → SiliconFlow AI 解析 → 写飞书多维表格 → 发确认
 *
 * 支持的消息格式（直接发送，无需前缀）：
 *   "晚餐68微信"       → 支出记账
 *   "工资8000招行"     → 收入记账
 *   "借给小明500"      → 负债记录
 *   "微信转招行1000"   → 转账
 *   "查余额"           → 查看账户余额
 *   其他消息           → 返回使用提示
 *
 * Usage:
 *   node lark-bookkeeping-daemon.mjs
 *   node lark-bookkeeping-daemon.mjs --dry-run   # 不写飞书，只打印解析结果
 *
 * Environment variables (see .env.example):
 *   LARK_APP_TOKEN, LARK_LEDGER_TABLE, LARK_ACCOUNT_TABLE,
 *   LARK_CHAT_ID, SILICONFLOW_API_KEY
 */

import { spawnSync } from "child_process";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dir = dirname(fileURLToPath(import.meta.url));

// ─── Load .env ────────────────────────────────────────────────────────────────

function loadEnv() {
  const envPath = resolve(__dir, ".env");
  if (!existsSync(envPath)) return;
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
  }
}
loadEnv();

// ─── Config ───────────────────────────────────────────────────────────────────

const CHAT_ID       = process.env.LARK_CHAT_ID;
const APP_TOKEN     = process.env.LARK_APP_TOKEN;
const LEDGER_TABLE  = process.env.LARK_LEDGER_TABLE;
const ACCOUNT_TABLE = process.env.LARK_ACCOUNT_TABLE;
const POLL_MS       = Number(process.env.LARK_POLL_MS) || 8_000;
const STATE_FILE    = `${process.env.HOME}/.local/share/lark-bookkeeping/state.json`;

const SILICONFLOW_API = "https://api.siliconflow.cn/v1/chat/completions";
const SILICONFLOW_KEY = process.env.SILICONFLOW_API_KEY;
const MODEL_FALLBACK  = "deepseek-ai/DeepSeek-V3";

// Optional: SiliconFlow model router (https://github.com/PUDAOCHEN031101/model-router-mcp)
// Set SILICON_ROUTER_PYTHON + SILICON_ROUTER_CLI in .env to enable dynamic model routing.
// If not configured, falls back to DeepSeek-V3.
const ROUTER_PYTHON = process.env.SILICON_ROUTER_PYTHON;
const ROUTER_CLI    = process.env.SILICON_ROUTER_CLI;

function routeModel(taskDesc) {
  if (!ROUTER_PYTHON || !ROUTER_CLI || !existsSync(ROUTER_CLI)) return MODEL_FALLBACK;
  try {
    const r = spawnSync(
      ROUTER_PYTHON,
      ["-B", ROUTER_CLI, "route", taskDesc, "--profile", "siliconflow"],
      { encoding: "utf8", timeout: 8_000, env: { ...process.env } }
    );
    if (r.error || r.status !== 0) throw new Error(r.stderr || r.error?.message);
    const out = (r.stdout || "").trim();
    const i = out.indexOf("{");
    if (i < 0) throw new Error("no JSON");
    const result = JSON.parse(out.slice(i));
    const model = result["推荐模型"];
    if (!model) throw new Error("no model");
    log(`[router] ${model} (${result["意图分析"]})`);
    return model;
  } catch (e) {
    log(`[router] fallback to ${MODEL_FALLBACK}: ${e.message}`);
    return MODEL_FALLBACK;
  }
}

let MODEL = MODEL_FALLBACK;

const DRY_RUN = process.argv.includes("--dry-run");

// ─── Validate required env ────────────────────────────────────────────────────

function validateConfig() {
  const required = { LARK_CHAT_ID: CHAT_ID, LARK_APP_TOKEN: APP_TOKEN, LARK_LEDGER_TABLE: LEDGER_TABLE, SILICONFLOW_API_KEY: SILICONFLOW_KEY };
  const missing = Object.entries(required).filter(([, v]) => !v).map(([k]) => k);
  if (missing.length) {
    console.error(`[daemon] Missing required env vars: ${missing.join(", ")}`);
    console.error("  Copy .env.example to .env and fill in your values.");
    process.exit(1);
  }
}

// ─── Account mapping ──────────────────────────────────────────────────────────
// Load from config/accounts.json — run: node lark-record.mjs --list-accounts

function loadAccounts() {
  const paths = [resolve(__dir, "config/accounts.json"), resolve(__dir, "accounts.json")];
  for (const p of paths) {
    if (existsSync(p)) {
      try { return JSON.parse(readFileSync(p, "utf8")); } catch {}
    }
  }
  console.warn("[daemon] config/accounts.json not found — account linking will be skipped");
  return {};
}

const ACCOUNTS = loadAccounts();

// ─── State persistence ────────────────────────────────────────────────────────

function loadState() {
  if (!existsSync(STATE_FILE)) return { processedIds: [], lastPollTime: null };
  try { return JSON.parse(readFileSync(STATE_FILE, "utf8")); } catch { return { processedIds: [], lastPollTime: null }; }
}

function saveState(state) {
  mkdirSync(STATE_FILE.substring(0, STATE_FILE.lastIndexOf("/")), { recursive: true });
  if (state.processedIds.length > 200) state.processedIds = state.processedIds.slice(-200);
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

// ─── lark-cli helper ──────────────────────────────────────────────────────────

function lark(args, timeout = 30_000) {
  const r = spawnSync("lark-cli", args, {
    encoding: "utf8", maxBuffer: 10 * 1024 * 1024, timeout, env: { ...process.env },
  });
  if (r.error) throw new Error(`lark spawn: ${r.error.message}`);
  const out = (r.stdout || "").trim();
  const i = out.indexOf("{");
  if (i < 0) throw new Error(`no JSON: ${((r.stderr || "").trim() || out).slice(0, 300)}`);
  return JSON.parse(out.slice(i));
}

// ─── AI parsing ───────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `你是个人记账助手。分析用户消息是否为记账请求，并解析为 JSON。

## 账户列表
${Object.keys(ACCOUNTS).join(" / ") || "（请先配置 config/accounts.json）"}

## 交易类型: 支出 / 收入 / 转账 / 负债 / 还款
## 支出分类: 衣 / 食 / 住 / 行 / 娱 / 学 / 持续黑洞 / 其他支出
## 收入分类: 工资 / 奖金补贴 / 报销返还 / 兼职劳务 / 投资利息 / 退款返现 / 他人转账 / 其他收入

## 特殊命令（精确匹配）
- "查余额" / "余额" / "balance" → {"command": "balance"}

## 不是记账
聊天、问候、无关信息 → {"not_bookkeeping": true}

## 输出格式（纯 JSON，禁止解释）
{"交易类型":"支出","金额":68,"账户":"微信零钱","转出账户":"","转入账户":"","支出分类":"食","收入分类":"","借贷方向":"","借款人":"","备注":"晚餐","日期":""}`;

async function parseWithAI(text) {
  const resp = await fetch(SILICONFLOW_API, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${SILICONFLOW_KEY}` },
    body: JSON.stringify({ model: MODEL, messages: [{ role: "system", content: SYSTEM_PROMPT }, { role: "user", content: text }], temperature: 0.1, max_tokens: 300 }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!resp.ok) throw new Error(`AI HTTP ${resp.status}`);
  const data = await resp.json();
  const content = data?.choices?.[0]?.message?.content || "";
  const m = content.match(/\{[\s\S]*\}/);
  if (!m) throw new Error(`AI no JSON: ${content.slice(0, 200)}`);
  return JSON.parse(m[0]);
}

// ─── Account / field helpers ──────────────────────────────────────────────────

function resolveAccount(name) {
  if (!name) return null;
  if (ACCOUNTS[name]) return ACCOUNTS[name];
  for (const [k, v] of Object.entries(ACCOUNTS)) {
    if (name.includes(k) || k.includes(name)) return v;
  }
  return null;
}

function buildFields(parsed) {
  const fields = { "交易类型": parsed["交易类型"], "金额": Number(parsed["金额"]) };
  if (parsed["备注"]) fields["备注"] = parsed["备注"];
  fields["日期"] = parsed["日期"] || (() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")} 00:00:00`;
  })();
  for (const k of ["支出分类","收入分类","借贷方向","借款人"]) if (parsed[k]) fields[k] = parsed[k];
  for (const k of ["账户","转出账户","转入账户"]) {
    if (parsed[k]) { const rid = resolveAccount(parsed[k]); if (rid) fields[k] = [rid]; }
  }
  return fields;
}

// ─── Feishu operations ────────────────────────────────────────────────────────

function writeRecord(fields) {
  return lark(["base", "+record-upsert", "--base-token", APP_TOKEN, "--table-id", LEDGER_TABLE, "--json", JSON.stringify(fields)]);
}

function sendIM(text) {
  try {
    lark(["im", "+messages-send", "--as", "user", "--chat-id", CHAT_ID, "--text", text]);
  } catch (e) { log(`IM send failed (non-fatal): ${e.message}`); }
}

function getBalanceSummary() {
  if (!ACCOUNT_TABLE) return "查余额功能需配置 LARK_ACCOUNT_TABLE";
  const r = lark(["base", "+record-list", "--base-token", APP_TOKEN, "--table-id", ACCOUNT_TABLE, "--limit", "50"]);
  const rows = r.data.data || [], fields = r.data.fields || [];
  const nameIdx = fields.indexOf("账户名称"), balIdx = fields.indexOf("当前余额");
  let lines = ["账户余额："], total = 0;
  for (const row of rows) {
    const name = String(row[nameIdx] || ""), bal = parseFloat(row[balIdx] || "0");
    if (bal !== 0) { lines.push(`  ${name.padEnd(16)}¥${bal.toFixed(2)}`); total += bal; }
  }
  lines.push(`  ${"合计".padEnd(16)}¥${total.toFixed(2)}`);
  return lines.join("\n");
}

// ─── Message processing ───────────────────────────────────────────────────────

function fetchNewMessages(since) {
  const args = ["im", "+chat-messages-list", "--chat-id", CHAT_ID, "--sort", "asc", "--page-size", "20"];
  if (since) args.push("--start", since);
  const r = lark(args, 25_000);
  return r?.data?.messages || [];
}

function extractText(msg) {
  const raw = msg.content || msg.body?.content || "";
  if (typeof raw === "string" && raw.startsWith("{")) {
    try { return (JSON.parse(raw).text || "").trim(); } catch {}
  }
  return String(raw).trim();
}

async function processMessage(msg) {
  const text = extractText(msg);
  if (!text) return;
  log(`Processing: "${text}"`);

  let parsed;
  try { parsed = await parseWithAI(text); } catch (e) { log(`AI error: ${e.message}`); return; }

  if (parsed.command === "balance") {
    if (DRY_RUN) { log("[dry-run] Would query balance"); return; }
    try { sendIM(getBalanceSummary()); } catch (e) { sendIM(`查余额失败: ${e.message}`); }
    return;
  }

  if (parsed.not_bookkeeping) {
    log("  → Not bookkeeping, sending hint");
    if (!DRY_RUN) sendIM(`🤖 记账机器人在线\n示例：晚餐68微信 / 工资8000招行 / 借给小明500\n发"查余额"查账户余额`);
    return;
  }

  if (!parsed["金额"] || !parsed["交易类型"]) { log("  → Missing fields, skipping"); return; }

  const fields = buildFields(parsed);
  if (DRY_RUN) { log(`[dry-run] Would write: ${JSON.stringify(fields)}`); return; }

  try {
    const result = writeRecord(fields);
    if (!result.ok && result.code !== 0) throw new Error(`code=${result.code}: ${result.msg}`);
    log(`✅ Written: ${result?.data?.record?.record_id || "?"}`);
    const { 交易类型: type, 金额: amt, 账户: acct, 支出分类: c1, 收入分类: c2, 备注: note } = parsed;
    let confirmMsg = `✅ 已记账\n类型: ${type}  金额: ¥${amt}`;
    if (acct)   confirmMsg += `  账户: ${acct}`;
    if (c1||c2) confirmMsg += `  分类: ${c1||c2}`;
    if (note)   confirmMsg += `\n备注: ${note}`;
    sendIM(confirmMsg);
  } catch (e) {
    log(`Write failed: ${e.message}`);
    sendIM(`❌ 记账失败: ${e.message}`);
  }
}

// ─── Logger ───────────────────────────────────────────────────────────────────

function log(msg) {
  console.log(`[${new Date().toISOString().replace("T"," ").slice(0,19)}] ${msg}`);
}

// ─── Poll loop ────────────────────────────────────────────────────────────────

async function pollLoop() {
  validateConfig();
  const state = loadState();
  const processedIds = new Set(state.processedIds || []);
  let lastPollTime = state.lastPollTime || new Date(Date.now() - 60_000).toISOString();

  MODEL = routeModel("理解用户说的一句话，识别是否在记账，提取金额和账户信息");
  log(`Daemon started. Chat: ${CHAT_ID}  Model: ${MODEL}  DryRun: ${DRY_RUN}`);
  log(`Polling every ${POLL_MS/1000}s`);

  while (true) {
    try {
      const msgs = fetchNewMessages(lastPollTime);
      const now = new Date().toISOString();
      for (const msg of msgs) {
        const msgId = msg.message_id || msg.id;
        if (!msgId || processedIds.has(msgId)) continue;
        if (msg.sender?.sender_type === "app") { processedIds.add(msgId); continue; }
        processedIds.add(msgId);
        await processMessage(msg);
      }
      lastPollTime = now;
      state.lastPollTime = now;
      state.processedIds = [...processedIds];
      saveState(state);
    } catch (e) { log(`Poll error (will retry): ${e.message}`); }
    await new Promise(r => setTimeout(r, POLL_MS));
  }
}

pollLoop().catch(e => { console.error("Fatal:", e.message); process.exit(1); });
