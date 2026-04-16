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
 *   "查最近5笔"        → 查询最近记录
 *   "删除上一笔"       → 删除最新一笔
 *   "删除 recxxxx"     → 按 ID 删除
 *   "修改 recxxxx 金额=88 备注=午饭 分类=食 账户=微信" → 按 ID 修改
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

import { createServer } from "http";
import { spawn, spawnSync } from "child_process";
import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync } from "fs";
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
const POLL_BACKFILL_SECONDS = Number(process.env.LARK_POLL_BACKFILL_SECONDS) || 86_400;
const EVENT_MODE    = (process.env.LARK_EVENT_MODE || "long").toLowerCase(); // long|webhook|poll
const LONG_RESTART_MS = Number(process.env.LARK_LONG_RESTART_MS) || 3_000;
const WEBHOOK_PORT  = Number(process.env.LARK_WEBHOOK_PORT) || 0;
const WEBHOOK_HOST  = process.env.LARK_WEBHOOK_HOST || "0.0.0.0";
const VERIFY_TOKEN  = process.env.LARK_VERIFICATION_TOKEN || "";
const STATE_FILE    = `${process.env.HOME}/.local/share/lark-bookkeeping/state.json`;
const FEEDBACK_FILE = `${process.env.HOME}/.local/share/lark-bookkeeping/feedback.ndjson`;
const FEATURE_FILE  = `${process.env.HOME}/.local/share/lark-bookkeeping/feature-requests.ndjson`;

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
  if (!existsSync(STATE_FILE)) return { processedIds: [], processedEventIds: [], lastPollTime: null };
  try {
    const state = JSON.parse(readFileSync(STATE_FILE, "utf8"));
    if (!Array.isArray(state.processedIds)) state.processedIds = [];
    if (!Array.isArray(state.processedEventIds)) state.processedEventIds = [];
    if (!Object.prototype.hasOwnProperty.call(state, "lastPollTime")) state.lastPollTime = null;
    return state;
  } catch {
    return { processedIds: [], processedEventIds: [], lastPollTime: null };
  }
}

function saveState(state) {
  mkdirSync(STATE_FILE.substring(0, STATE_FILE.lastIndexOf("/")), { recursive: true });
  if (state.processedIds.length > 200) state.processedIds = state.processedIds.slice(-200);
  if (state.processedEventIds.length > 200) state.processedEventIds = state.processedEventIds.slice(-200);
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

const STATE = loadState();
const PROCESSED_IDS = new Set(STATE.processedIds || []);
const PROCESSED_EVENT_IDS = new Set(STATE.processedEventIds || []);

function persistState() {
  STATE.processedIds = [...PROCESSED_IDS];
  STATE.processedEventIds = [...PROCESSED_EVENT_IDS];
  saveState(STATE);
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

function extractRecordId(result) {
  return (
    result?.data?.record?.record_id ??
    result?.data?.record?.record_id_list?.[0] ??
    result?.data?.record_id_list?.[0] ??
    result?.data?.upserted?.[0]?.record_id ??
    "?"
  );
}

function updateRecord(recordId, fields) {
  return lark([
    "base", "+record-update",
    "--base-token", APP_TOKEN,
    "--table-id", LEDGER_TABLE,
    "--record-id", recordId,
    "--fields", JSON.stringify(fields),
  ]);
}

function deleteRecord(recordId) {
  return lark([
    "base", "+record-delete",
    "--base-token", APP_TOKEN,
    "--table-id", LEDGER_TABLE,
    "--record-id", recordId,
    "--yes",
  ]);
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

function listRecentRecords(limit = 5) {
  const safeLimit = Math.max(1, Math.min(20, Number(limit) || 5));
  const r = lark([
    "base", "+record-list",
    "--base-token", APP_TOKEN,
    "--table-id", LEDGER_TABLE,
    "--limit", String(safeLimit),
  ]);
  const rows = r.data?.data || [];
  const ids = r.data?.record_id_list || [];
  const fields = r.data?.fields || [];
  const idxType = fields.indexOf("交易类型");
  const idxAmount = fields.indexOf("金额");
  const idxNote = fields.indexOf("备注");
  const idxDate = fields.indexOf("日期");
  return rows.map((row, i) => ({
    id: ids[i],
    type: String(row[idxType] || ""),
    amount: Number(row[idxAmount] || 0),
    note: String(row[idxNote] || ""),
    date: String(row[idxDate] || ""),
  })).filter(x => x.id);
}

function summarizeRecentRecords(limit = 5) {
  const rows = listRecentRecords(limit);
  if (!rows.length) return "最近没有可用记账记录。";
  const lines = [`最近 ${rows.length} 笔：`];
  for (const r of rows) {
    lines.push(`${r.id} | ${r.type} | ¥${r.amount.toFixed(2)} | ${r.note || "-"} | ${r.date || "-"}`);
  }
  return lines.join("\n");
}

function readRecentJsonLines(file, limit = 5) {
  if (!existsSync(file)) return [];
  try {
    const lines = readFileSync(file, "utf8").split("\n").map(s => s.trim()).filter(Boolean);
    const picked = lines.slice(-Math.max(1, Math.min(20, Number(limit) || 5)));
    const rows = [];
    for (const line of picked) {
      try { rows.push(JSON.parse(line)); } catch {}
    }
    return rows.reverse();
  } catch {
    return [];
  }
}

function summarizeFeatureRequests(limit = 5) {
  const rows = readRecentJsonLines(FEATURE_FILE, limit);
  if (!rows.length) return "最近没有功能需求记录。";
  const lines = [`最近 ${rows.length} 条功能需求：`];
  for (const row of rows) {
    lines.push(`- ${row.detail || row.raw_text || "(空)"} | ${row.ts || "-"}`);
  }
  return lines.join("\n");
}

function parseControlCommand(text) {
  const t = text.trim();
  if (/^(查余额|余额|balance)$/i.test(t)) return { action: "balance" };
  if (/^(本月汇总|月报)$/i.test(t)) return { action: "monthly" };
  const listMatch = t.match(/^(查最近|最近)\s*(\d+)?\s*笔?$/);
  if (listMatch) return { action: "list", limit: Number(listMatch[2] || 5) };
  if (/^(撤销上一笔|删除上一笔|删除这条|撤销这条|删除这笔|撤销这笔|删除这条记录|撤销这条记录)$/.test(t)) return { action: "delete_last" };
  const delMatch = t.match(/^(删除|撤销)\s*(rec[a-zA-Z0-9]+)$/);
  if (delMatch) return { action: "delete_id", recordId: delMatch[2] };
  const updateMatch = t.match(/^修改\s*(rec[a-zA-Z0-9]+)\s+(.+)$/);
  if (updateMatch) {
    const kv = {};
    for (const part of updateMatch[2].split(/\s+/)) {
      const i = part.indexOf("=");
      if (i <= 0) continue;
      const k = part.slice(0, i).trim();
      const v = part.slice(i + 1).trim();
      if (k && v) kv[k] = v;
    }
    return { action: "update", recordId: updateMatch[1], kv };
  }
  const feedbackMatch = t.match(/^反馈[\s:：]+(.+)$/);
  if (feedbackMatch) return { action: "feedback", content: feedbackMatch[1].trim() };
  const featureMatch = t.match(/^(需求|建议|新功能|我要功能)[\s:：]+(.+)$/);
  if (featureMatch) return { action: "feature_request", content: featureMatch[2].trim() };
  const featureListMatch = t.match(/^查需求\s*(\d+)?\s*条?$/);
  if (featureListMatch) return { action: "list_features", limit: Number(featureListMatch[1] || 5) };
  return null;
}

function buildUpdateFieldsFromKv(kv) {
  const fields = {};
  if (kv["金额"]) fields["金额"] = Number(kv["金额"]);
  if (kv["备注"]) fields["备注"] = kv["备注"];
  if (kv["日期"]) fields["日期"] = kv["日期"];
  if (kv["交易类型"]) fields["交易类型"] = kv["交易类型"];
  if (kv["账户"]) {
    const rid = resolveAccount(kv["账户"]);
    if (rid) fields["账户"] = [rid];
  }
  if (kv["支出分类"]) fields["支出分类"] = kv["支出分类"];
  if (kv["收入分类"]) fields["收入分类"] = kv["收入分类"];
  if (kv["分类"]) fields["支出分类"] = kv["分类"];
  return fields;
}

function appendFeedbackEntry(rawText, detail, lastRecordId = "") {
  const dir = FEEDBACK_FILE.substring(0, FEEDBACK_FILE.lastIndexOf("/"));
  mkdirSync(dir, { recursive: true });
  const row = {
    ts: new Date().toISOString(),
    raw_text: rawText,
    detail,
    last_record_id: lastRecordId || "",
  };
  appendFileSync(FEEDBACK_FILE, `${JSON.stringify(row, null, 0)}\n`);
}

function appendFeatureRequestEntry(rawText, detail) {
  const dir = FEATURE_FILE.substring(0, FEATURE_FILE.lastIndexOf("/"));
  mkdirSync(dir, { recursive: true });
  const row = {
    ts: new Date().toISOString(),
    raw_text: rawText,
    detail,
  };
  appendFileSync(FEATURE_FILE, `${JSON.stringify(row, null, 0)}\n`);
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

  // Skip bot's own confirmation/hint messages to prevent feedback loop
  if (text.startsWith("✅ 已记账") || text.startsWith("❌ 记账失败") || text.startsWith("🤖 记账机器人")) return;
  if (text.startsWith("账户余额：")) return;

  log(`Processing: "${text}"`);

  const cmd = parseControlCommand(text);
  if (cmd) {
    if (DRY_RUN) { log(`[dry-run] control command: ${JSON.stringify(cmd)}`); return; }
    try {
      if (cmd.action === "balance") { sendIM(getBalanceSummary()); return; }
      if (cmd.action === "monthly") { sendIM("月度汇总请使用命令行: node lark-record.mjs --monthly"); return; }
      if (cmd.action === "list") { sendIM(summarizeRecentRecords(cmd.limit)); return; }
      if (cmd.action === "delete_last") {
        const last = listRecentRecords(1)[0];
        if (!last) { sendIM("没有可撤销的记录。"); return; }
        deleteRecord(last.id);
        sendIM(`✅ 已删除上一笔: ${last.id} ¥${last.amount.toFixed(2)} ${last.note || ""}`.trim());
        return;
      }
      if (cmd.action === "delete_id") {
        deleteRecord(cmd.recordId);
        sendIM(`✅ 已删除记录: ${cmd.recordId}`);
        return;
      }
      if (cmd.action === "update") {
        const fields = buildUpdateFieldsFromKv(cmd.kv || {});
        if (!Object.keys(fields).length) {
          sendIM("修改失败：请使用 关键字=值，例如：修改 recxxxx 金额=88 备注=午饭 分类=食 账户=微信");
          return;
        }
        updateRecord(cmd.recordId, fields);
        sendIM(`✅ 已修改记录: ${cmd.recordId}\n更新字段: ${Object.keys(fields).join(", ")}`);
        return;
      }
      if (cmd.action === "feedback") {
        const last = listRecentRecords(1)[0];
        appendFeedbackEntry(text, cmd.content || "", last?.id || "");
        sendIM(`✅ 已收到反馈\n内容: ${cmd.content}\n最近记录: ${last?.id || "-"}`);
        return;
      }
      if (cmd.action === "feature_request") {
        appendFeatureRequestEntry(text, cmd.content || "");
        sendIM(`✅ 已记录新功能需求\n内容: ${cmd.content}`);
        return;
      }
      if (cmd.action === "list_features") {
        sendIM(summarizeFeatureRequests(cmd.limit));
        return;
      }
    } catch (e) {
      appendFeedbackEntry(text, `命令执行失败: ${e.message}`);
      sendIM(`❌ 操作失败: ${e.message}`);
      return;
    }
  }

  let parsed;
  try { parsed = await parseWithAI(text); } catch (e) { log(`AI error: ${e.message}`); return; }

  if (parsed.command === "balance") {
    if (DRY_RUN) { log("[dry-run] Would query balance"); return; }
    try { sendIM(getBalanceSummary()); } catch (e) { sendIM(`查余额失败: ${e.message}`); }
    return;
  }

  if (parsed.not_bookkeeping) {
    log("  → Not bookkeeping, sending hint");
    if (!DRY_RUN) {
      const recent = listRecentRecords(1)[0];
      if (/(删除|撤销).*(这条|这笔)/.test(text)) {
        appendFeedbackEntry(text, "自动检测：删除意图未命中", recent?.id || "");
        sendIM(`🤖 我理解你想删除记录，但还没定位到具体 ID。\n可直接发：删除上一笔\n或：删除 ${recent?.id || "recxxxx"}\n也可反馈：反馈 删除意图未命中`);
      } else if (/(不对|错了|不是这个)/.test(text)) {
        appendFeedbackEntry(text, "自动检测：纠错意图触发", recent?.id || "");
        sendIM(`🤖 收到纠错信号。\n最近记录: ${recent?.id || "-"}\n可发：修改 ${recent?.id || "recxxxx"} 金额=xx 备注=xx\n或发：反馈 你的纠错说明`);
      } else {
        sendIM(`🤖 记账机器人在线\n示例：晚餐68微信 / 工资8000招行 / 借给小明500\n发"查余额"查账户余额`);
      }
    }
    return;
  }

  if (!parsed["金额"] || !parsed["交易类型"]) { log("  → Missing fields, skipping"); return; }

  const fields = buildFields(parsed);
  if (DRY_RUN) { log(`[dry-run] Would write: ${JSON.stringify(fields)}`); return; }

  try {
    const result = writeRecord(fields);
    if (!result.ok && result.code !== 0) throw new Error(`code=${result.code}: ${result.msg}`);
    const recId = extractRecordId(result);
    log(`✅ Written: ${recId}`);
    const { 交易类型: type, 金额: amt, 账户: acct, 支出分类: c1, 收入分类: c2, 备注: note } = parsed;
    let confirmMsg = `✅ 已记账\nID: ${recId}\n类型: ${type}  金额: ¥${amt}`;
    if (acct)   confirmMsg += `  账户: ${acct}`;
    if (c1||c2) confirmMsg += `  分类: ${c1||c2}`;
    if (note)   confirmMsg += `\n备注: ${note}`;
    sendIM(confirmMsg);
  } catch (e) {
    log(`Write failed: ${e.message}`);
    appendFeedbackEntry(text, `写入失败: ${e.message}`);
    sendIM(`❌ 记账失败: ${e.message}`);
  }
}

function verifyWebhookToken(token) {
  return !VERIFY_TOKEN || token === VERIFY_TOKEN;
}

function parseWebhookMessage(event) {
  if (!event?.message) return null;
  return {
    id: event.message.message_id,
    message_id: event.message.message_id,
    content: event.message.content,
    body: { content: event.message.content },
    sender: {
      sender_type: event.sender?.sender_type || "user",
    },
    chat_id: event.message.chat_id,
    chat_type: event.message.chat_type,
    message_type: event.message.message_type,
  };
}

function parseLongEventMessage(payload) {
  const event = payload?.event || payload?.data?.event || payload?.body?.event;
  if (!event?.message) return null;
  return parseWebhookMessage(event);
}

async function handleWebhookEvent(payload) {
  const eventId = payload?.header?.event_id;
  const event = payload?.event;
  const msg = parseWebhookMessage(event);
  const msgId = msg?.message_id || msg?.id;

  if (eventId && PROCESSED_EVENT_IDS.has(eventId)) return;
  if (!msgId || !msg) return;
  if (CHAT_ID && msg.chat_id && msg.chat_id !== CHAT_ID) {
    log(`Skip message from unmatched chat: ${msg.chat_id}`);
    return;
  }
  if (msg.message_type && msg.message_type !== "text") {
    log(`Skip non-text message: ${msg.message_type}`);
    return;
  }
  if (PROCESSED_IDS.has(msgId)) return;

  if (eventId) PROCESSED_EVENT_IDS.add(eventId);
  PROCESSED_IDS.add(msgId);
  persistState();

  try {
    await processMessage(msg);
  } catch (e) {
    log(`Webhook process error: ${e.message}`);
  }
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", chunk => {
      body += chunk;
      if (body.length > 1024 * 1024) {
        reject(new Error("payload too large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      if (!body) return resolve({});
      try {
        resolve(JSON.parse(body));
      } catch (e) {
        reject(new Error(`invalid JSON: ${e.message}`));
      }
    });
    req.on("error", reject);
  });
}

function startWebhookServer() {
  const server = createServer(async (req, res) => {
    if (req.method !== "POST") {
      res.writeHead(405, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ code: 405, msg: "method not allowed" }));
      return;
    }

    try {
      const payload = await readJsonBody(req);
      const token = payload?.header?.token || payload?.token || "";
      if (!verifyWebhookToken(token)) {
        res.writeHead(403, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ code: 403, msg: "invalid token" }));
        return;
      }

      if (payload?.type === "url_verification") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ challenge: payload.challenge }));
        return;
      }

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ code: 0 }));

      if (payload?.header?.event_type === "im.message.receive_v1") {
        setImmediate(() => {
          handleWebhookEvent(payload).catch(e => log(`Webhook async error: ${e.message}`));
        });
      }
    } catch (e) {
      log(`Webhook request error: ${e.message}`);
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ code: 400, msg: e.message }));
    }
  });

  server.listen(WEBHOOK_PORT, WEBHOOK_HOST, () => {
    log(`Webhook server listening on http://${WEBHOOK_HOST}:${WEBHOOK_PORT}`);
    if (VERIFY_TOKEN) log("Webhook verification token enabled");
  });
}

async function handleIncomingMessage(msg, eventId = "") {
  const msgId = msg?.message_id || msg?.id;
  if (eventId && PROCESSED_EVENT_IDS.has(eventId)) return;
  if (!msgId || !msg) return;
  if (CHAT_ID && msg.chat_id && msg.chat_id !== CHAT_ID) return;
  if (msg.message_type && msg.message_type !== "text") return;
  if (PROCESSED_IDS.has(msgId)) return;

  if (eventId) PROCESSED_EVENT_IDS.add(eventId);
  PROCESSED_IDS.add(msgId);
  persistState();
  await processMessage(msg);
}

async function startLongConnectionLoop() {
  while (true) {
    log("Long-connection subscribe started");
    await new Promise((resolve) => {
      const args = [
        "event", "+subscribe",
        "--as", "bot",
        "--event-types", "im.message.receive_v1",
        "--quiet",
      ];
      const child = spawn("lark-cli", args, {
        cwd: process.cwd(),
        env: { ...process.env },
        stdio: ["ignore", "pipe", "pipe"],
      });

      let buffer = "";
      child.stdout.on("data", (chunk) => {
        buffer += chunk.toString();
        let idx = buffer.indexOf("\n");
        while (idx >= 0) {
          const line = buffer.slice(0, idx).trim();
          buffer = buffer.slice(idx + 1);
          if (line) {
            try {
              const payload = JSON.parse(line);
              const eventId = payload?.header?.event_id || payload?.event_id || "";
              const msg = parseLongEventMessage(payload);
              if (msg) {
                handleIncomingMessage(msg, eventId).catch(e => log(`Long event process error: ${e.message}`));
              }
            } catch {
              // ignore non-json lines
            }
          }
          idx = buffer.indexOf("\n");
        }
      });

      child.stderr.on("data", (chunk) => {
        const text = chunk.toString().trim();
        if (text) log(`[long-conn] ${text}`);
      });
      child.on("exit", (code, signal) => {
        log(`Long-connection exited code=${code ?? "null"} signal=${signal ?? "null"}`);
        resolve();
      });
      child.on("error", (e) => {
        log(`Long-connection spawn error: ${e.message}`);
        resolve();
      });
    });
    await new Promise(r => setTimeout(r, LONG_RESTART_MS));
  }
}

// ─── Logger ───────────────────────────────────────────────────────────────────

function log(msg) {
  console.log(`[${new Date().toISOString().replace("T"," ").slice(0,19)}] ${msg}`);
}

// ─── Poll loop ────────────────────────────────────────────────────────────────

async function pollLoop() {
  const backfillMs = Math.max(0, POLL_BACKFILL_SECONDS) * 1000;
  let lastPollTime =
    STATE.lastPollTime ||
    new Date(Date.now() - backfillMs).toISOString();

  while (true) {
    try {
      const msgs = fetchNewMessages(lastPollTime);
      const now = new Date().toISOString();
      for (const msg of msgs) {
        const msgId = msg.message_id || msg.id;
        if (!msgId || PROCESSED_IDS.has(msgId)) continue;
        if (msg.sender?.sender_type === "app") { PROCESSED_IDS.add(msgId); continue; }
        PROCESSED_IDS.add(msgId);
        await processMessage(msg);
      }
      lastPollTime = now;
      STATE.lastPollTime = now;
      persistState();
    } catch (e) { log(`Poll error (will retry): ${e.message}`); }
    await new Promise(r => setTimeout(r, POLL_MS));
  }
}

async function main() {
  validateConfig();
  MODEL = routeModel("理解用户说的一句话，识别是否在记账，提取金额和账户信息");
  log(`Daemon started. Chat: ${CHAT_ID || "(all chats)"}  Model: ${MODEL}  DryRun: ${DRY_RUN}`);

  if (EVENT_MODE === "long") {
    log("Mode: long-connection");
    await startLongConnectionLoop();
    return;
  }

  if (EVENT_MODE === "webhook" && WEBHOOK_PORT > 0) {
    log("Mode: webhook");
    startWebhookServer();
    return;
  }

  log("Mode: polling");
  log(`Polling every ${POLL_MS / 1000}s`);
  await pollLoop();
}

main().catch(e => { console.error("Fatal:", e.message); process.exit(1); });
