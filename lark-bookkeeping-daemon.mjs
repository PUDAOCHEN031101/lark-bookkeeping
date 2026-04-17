#!/usr/bin/env node
/**
 * lark-bookkeeping-daemon.mjs — 飞书聊天记账守护进程
 *
 * 监听指定群聊（LARK_CHAT_ID / LARK_BOOKKEEPING_CHAT_ID）→ AI 解析 → 写多维表 → 发确认
 *
 * 支持的消息格式（直接发送，无需前缀）：
 *   "晚餐68微信"       → 支出记账
 *   "工资8000招行"     → 收入记账
 *   "借给小明500"      → 负债记录
 *   "查余额"           → 查看账户余额
 *
 * Usage:
 *   node lark-bookkeeping-daemon.mjs
 *   node lark-bookkeeping-daemon.mjs --dry-run   # 不写 Feishu，只打印解析结果
 */

import { createServer } from "http";
import { spawn, spawnSync } from "child_process";
import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, readdirSync } from "fs";
import { join, resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { VOUCHER_MODEL_SET } from "./scripts/lib/silicon-voucher-models.mjs";
import {
  BOOKKEEPING_MULTI_INSTRUCTIONS,
  entriesFromAiJson,
  parseAiJsonFromContent,
} from "./scripts/lib/bookkeeping-multi.mjs";

const __dir = dirname(fileURLToPath(import.meta.url));

/** 开源仓库：从项目根目录 .env 注入（与 LARK_* 变量名一致） */
function loadEnvFromDotenv() {
  const envPath = resolve(__dir, ".env");
  if (!existsSync(envPath)) return;
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
  }
}
loadEnvFromDotenv();

// ─── Config ───────────────────────────────────────────────────────────────────

const CHAT_ID       = process.env.LARK_CHAT_ID || process.env.LARK_BOOKKEEPING_CHAT_ID || "";
const APP_TOKEN     = process.env.LARK_APP_TOKEN || process.env.LARK_BOOKKEEPING_APP_TOKEN || "";
const LEDGER_TABLE  = process.env.LARK_LEDGER_TABLE || process.env.LARK_BOOKKEEPING_LEDGER_TABLE || "";
const ACCOUNT_TABLE = process.env.LARK_ACCOUNT_TABLE || process.env.LARK_BOOKKEEPING_ACCOUNT_TABLE || "";
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
const SILICONFLOW_KEY = process.env.SILICONFLOW_API_KEY || "";
const MODEL_FALLBACK = "deepseek-ai/DeepSeek-V3";
const OCR_MODEL = process.env.LARK_OCR_MODEL || "deepseek-ai/DeepSeek-OCR";

// SiliconFlow router（可选；未配置则直接用 MODEL_FALLBACK）
const ROUTER_PYTHON = process.env.SILICON_ROUTER_PYTHON;
const ROUTER_CLI    = process.env.SILICON_ROUTER_CLI;

function routeModel(taskDesc) {
  if (!ROUTER_PYTHON || !ROUTER_CLI || !existsSync(ROUTER_CLI)) {
    return MODEL_FALLBACK;
  }
  try {
    const r = spawnSync(
      ROUTER_PYTHON,
      ["-B", ROUTER_CLI, "route", taskDesc, "--profile", "siliconflow"],
      { encoding: "utf8", timeout: 8_000, env: { ...process.env } }
    );
    if (r.error || r.status !== 0) throw new Error(r.stderr || r.error?.message);
    const out = (r.stdout || "").trim();
    const i = out.indexOf("{");
    if (i < 0) throw new Error("no JSON from router");
    const result = JSON.parse(out.slice(i));
    const model = result["推荐模型"];
    if (!model) throw new Error("no model in router output");
    log(`[router] ${taskDesc.slice(0,30)}… → ${model} (${result["意图分析"]})`);
    return model;
  } catch (e) {
    log(`[router] fallback to ${MODEL_FALLBACK}: ${e.message}`);
    return MODEL_FALLBACK;
  }
}

/** 路由返回的模型必须在代金券清单内，否则回退（避免选到不可计费/不覆盖的模型）。 */
function pickVoucherSafeRouterModel(taskDesc) {
  const raw = routeModel(taskDesc);
  if (process.env.SILICON_ROUTER_VOUCHER_DISABLE === "1") return raw;
  if (!VOUCHER_MODEL_SET.has(raw)) {
    log(`[router] "${raw}" not in voucher allowlist (${VOUCHER_MODEL_SET.size} ids) → ${MODEL_FALLBACK}`);
    return MODEL_FALLBACK;
  }
  return raw;
}

// Routed once at startup, cached for the session
let MODEL = MODEL_FALLBACK;

const DRY_RUN = process.argv.includes("--dry-run");

// ─── Account mapping ──────────────────────────────────────────────────────────

const DEFAULT_ACCOUNTS = {
  "港币":              "recve9k54blEyY",
  "中原银行_self":      "recve9k5nLC6Dw",
  "中原银行_school":    "recve9k5Hfi20q",
  "邮政_父母":         "recve9k60gOs1f",
  "建行":              "recve9k6mHeLah",
  "建行(L1)":          "recve9k6mHeLah",
  "中国银行_self":     "recve9k6IpMNRH",
  "中国银行":          "recve9k6IpMNRH",
  "中国农业银行":      "recve9k72jUWuk",
  "农行":              "recve9k72jUWuk",
  "中国银行社保卡":    "recve9k7nYWnMm",
  "社保卡":            "recve9k7nYWnMm",
  "招商金葵花":        "recve9k7JM4MU0",
  "招行":              "recve9k7JM4MU0",
  "金葵花":            "recve9k7JM4MU0",
  "余额宝":            "recve9k99GkOCj",
  "月付-N8":           "recve9kazPY9gA",
  "月付":              "recve9kazPY9gA",
  "人民币":            "recve9lFuzHowZ",
  "现金":              "recve9lFuzHowZ",
  "招行黄金":          "recve9o8IWxl8Z",
  "微信零钱":          "recve9pxYQx94K",
  "微信":              "recve9pxYQx94K",
  "零钱":              "recve9pxYQx94K",
  "微信零钱通":        "recve9pyki2V0n",
  "零钱通":            "recve9pyki2V0n",
  "币安":              "recveNNeSfJ108",
  "支付宝黄金":        "recveNNIH1T8E3",
};
const ACCOUNTS = loadAccounts();

function loadAccounts() {
  const extra = process.env.LARK_BOOKKEEPING_ACCOUNTS_JSON || "";
  const paths = [extra, resolve(__dir, "config/accounts.json"), resolve(__dir, "accounts.json")].filter(Boolean);
  let merged = { ...DEFAULT_ACCOUNTS };
  for (const p of paths) {
    if (!existsSync(p)) continue;
    try {
      const parsed = JSON.parse(readFileSync(p, "utf8"));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        merged = { ...merged, ...parsed };
      }
    } catch (e) {
      log(`accounts config load failed (${p}): ${e.message}`);
    }
  }
  return merged;
}

// ─── State persistence ────────────────────────────────────────────────────────

function loadState() {
  if (!existsSync(STATE_FILE)) return { processedIds: [], processedEventIds: [], lastPollTime: null, lastHandledId: "" };
  try {
    const s = JSON.parse(readFileSync(STATE_FILE, "utf8"));
    if (!Array.isArray(s.processedIds)) s.processedIds = [];
    if (!Array.isArray(s.processedEventIds)) s.processedEventIds = [];
    if (!Object.prototype.hasOwnProperty.call(s, "lastHandledId")) s.lastHandledId = "";
    return s;
  } catch {
    return { processedIds: [], processedEventIds: [], lastPollTime: null, lastHandledId: "" };
  }
}

function saveState(state) {
  const dir = STATE_FILE.substring(0, STATE_FILE.lastIndexOf("/"));
  mkdirSync(dir, { recursive: true });
  // keep only last 200 processed IDs to prevent unbounded growth
  if (state.processedIds.length > 200) {
    state.processedIds = state.processedIds.slice(-200);
  }
  if (state.processedEventIds.length > 200) {
    state.processedEventIds = state.processedEventIds.slice(-200);
  }
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
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
    timeout,
    env: { ...process.env },
  });
  if (r.error) throw new Error(`lark spawn: ${r.error.message}`);
  // JSON always goes to stdout; WARN/errors go to stderr.
  const out = (r.stdout || "").trim();
  const i = out.indexOf("{");
  if (i < 0) {
    const err = (r.stderr || "").trim();
    throw new Error(`no JSON: ${(err || out).slice(0, 300)}`);
  }
  return JSON.parse(out.slice(i));
}

// ─── AI parsing ───────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `你是个人记账助手。分析用户消息是否为记账请求，并解析为 JSON。

## 账户列表
微信零钱 / 微信零钱通 / 余额宝 / 招商金葵花 / 招行黄金 / 建行(L1) / 中国银行_self / 中国银行社保卡 / 中国农业银行 / 中原银行_self / 邮政_父母 / 人民币 / 港币 / 月付-N8 / 币安 / 支付宝黄金

## 交易类型
支出 / 收入 / 转账 / 负债 / 还款

## 支出分类
衣 / 食 / 住 / 行 / 娱 / 学 / 持续黑洞 / 其他支出

## 收入分类
工资 / 奖金补贴 / 报销返还 / 兼职劳务 / 投资利息 / 退款返现 / 他人转账 / 其他收入

## 日期规则
不说日期 → 日期留空 → 默认今天

## 特殊命令（精确匹配）
- "查余额" / "余额" / "balance" → 返回 {"command": "balance"}
- "本月汇总" / "月报" → 返回 {"command": "monthly"}

## 不是记账
如果消息不是记账请求（聊天、问候、无关信息等），返回 {"not_bookkeeping": true}

## 输出格式（纯 JSON，禁止解释）
正常记账返回：
{
  "交易类型": "支出",
  "金额": 68,
  "账户": "微信零钱",
  "转出账户": "",
  "转入账户": "",
  "支出分类": "食",
  "收入分类": "",
  "借贷方向": "",
  "借款人": "",
  "备注": "晚餐",
  "日期": ""
}` + BOOKKEEPING_MULTI_INSTRUCTIONS;

/** 默认 120s：多笔 + max_tokens=2000 时 Qwen 可能较慢 */
const PARSE_TIMEOUT_MS = Math.max(
  15_000,
  Number(process.env.LARK_BOOKKEEPING_PARSE_TIMEOUT_MS || process.env.LARK_PARSE_TIMEOUT_MS) || 120_000
);
const PARSE_RETRIES = Math.max(1, Math.min(5, Number(process.env.LARK_BOOKKEEPING_PARSE_RETRIES) || 2));

async function parseWithAI(text) {
  let lastErr;
  for (let attempt = 1; attempt <= PARSE_RETRIES; attempt++) {
    try {
      const resp = await fetch(SILICONFLOW_API, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${SILICONFLOW_KEY}` },
        body: JSON.stringify({
          model: MODEL,
          messages: [
            { role: "system", content: SYSTEM_PROMPT },
            { role: "user", content: text },
          ],
          temperature: 0.1,
          max_tokens: 2_000,
        }),
        signal: AbortSignal.timeout(PARSE_TIMEOUT_MS),
      });
      if (!resp.ok) throw new Error(`AI HTTP ${resp.status}`);
      const data = await resp.json();
      const content = data?.choices?.[0]?.message?.content || "";
      return parseAiJsonFromContent(content);
    } catch (e) {
      lastErr = e;
      const msg = e?.message || String(e);
      const isTimeout = /timeout|aborted/i.test(msg);
      if (isTimeout && attempt < PARSE_RETRIES) {
        log(`AI parse attempt ${attempt}/${PARSE_RETRIES} failed (${msg}), retrying…`);
        continue;
      }
      throw e;
    }
  }
  throw lastErr;
}

// ─── Account resolution ───────────────────────────────────────────────────────

function resolveAccount(name) {
  if (!name) return null;
  if (ACCOUNTS[name]) return ACCOUNTS[name];
  for (const [k, v] of Object.entries(ACCOUNTS)) {
    if (name.includes(k) || k.includes(name)) return v;
  }
  return null;
}

// ─── Build record fields ──────────────────────────────────────────────────────

function buildFields(parsed) {
  const fields = {};
  fields["交易类型"] = parsed["交易类型"];
  fields["金额"] = Number(parsed["金额"]);
  if (parsed["备注"]) fields["备注"] = parsed["备注"];
  fields["日期"] = parsed["日期"] || (() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} 00:00:00`;
  })();
  if (parsed["支出分类"]) fields["支出分类"] = parsed["支出分类"];
  if (parsed["收入分类"]) fields["收入分类"] = parsed["收入分类"];
  if (parsed["借贷方向"]) fields["借贷方向"] = parsed["借贷方向"];
  if (parsed["借款人"]) fields["借款人"] = parsed["借款人"];
  if (parsed["账户"]) {
    const rid = resolveAccount(parsed["账户"]);
    if (rid) fields["账户"] = [rid];
  }
  if (parsed["转出账户"]) {
    const rid = resolveAccount(parsed["转出账户"]);
    if (rid) fields["转出账户"] = [rid];
  }
  if (parsed["转入账户"]) {
    const rid = resolveAccount(parsed["转入账户"]);
    if (rid) fields["转入账户"] = [rid];
  }
  return fields;
}

// ─── Feishu writes ────────────────────────────────────────────────────────────

function writeRecord(fields) {
  return lark([
    "base", "+record-upsert",
    "--base-token", APP_TOKEN,
    "--table-id", LEDGER_TABLE,
    "--json", JSON.stringify(fields),
  ]);
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
    lark([
      "im", "+messages-send",
      "--as", "user",
      "--chat-id", CHAT_ID,
      "--text", text,
    ]);
  } catch (e) {
    log(`IM send failed (non-fatal): ${e.message}`);
  }
}

// ─── Balance query ────────────────────────────────────────────────────────────

function getBalanceSummary() {
  const r = lark([
    "base", "+record-list",
    "--base-token", APP_TOKEN,
    "--table-id", ACCOUNT_TABLE,
    "--limit", "50",
  ]);
  const rows   = r.data.data || [];
  const fields = r.data.fields || [];
  const nameIdx    = fields.indexOf("账户名称");
  const balanceIdx = fields.indexOf("当前余额");
  let lines = ["账户余额："];
  let total = 0;
  for (const row of rows) {
    const name = String(row[nameIdx] || "");
    const bal  = parseFloat(row[balanceIdx] || "0");
    if (bal !== 0) {
      lines.push(`  ${name.padEnd(16)}¥${bal.toFixed(2)}`);
      total += bal;
    }
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

function summarizeFeedback(limit = 5) {
  const rows = readRecentJsonLines(FEEDBACK_FILE, limit);
  if (!rows.length) return "最近没有反馈记录。";
  const lines = [`最近 ${rows.length} 条反馈：`];
  for (const row of rows) {
    const detail = row.detail || row.raw_text || "(空)";
    const rid = row.last_record_id ? ` | 记录: ${row.last_record_id}` : "";
    lines.push(`- ${detail}${rid} | ${row.ts || "-"}`);
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
  if (/^(增加功能|新增功能)/.test(t)) {
    const body = t.replace(/^(增加功能|新增功能)[\s:：]*/,"").trim();
    const items = body
      .split(/\n+/)
      .map(x => x.replace(/^\s*[\-\d\.、]+\s*/, "").trim())
      .filter(Boolean);
    return { action: "feature_bulk", items };
  }
  const featureListMatch = t.match(/^查需求\s*(\d+)?\s*条?$/);
  if (featureListMatch) return { action: "list_features", limit: Number(featureListMatch[1] || 5) };
  const feedbackListMatch = t.match(/^查反馈\s*(\d+)?\s*条?$/);
  if (feedbackListMatch) return { action: "list_feedback", limit: Number(feedbackListMatch[1] || 5) };
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

async function chatWithAI(text) {
  const resp = await fetch(SILICONFLOW_API, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${SILICONFLOW_KEY}` },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        {
          role: "system",
          content: "你是记账机器人，支持简短自然聊天。回复控制在2句以内，中文，友好，不要编造外部事实。"
        },
        { role: "user", content: text },
      ],
      temperature: 0.5,
      max_tokens: 120,
    }),
    signal: AbortSignal.timeout(12_000),
  });
  if (!resp.ok) throw new Error(`chat HTTP ${resp.status}`);
  const data = await resp.json();
  return (data?.choices?.[0]?.message?.content || "").trim() || "收到。";
}

function extractImageUrlFromMessage(msg) {
  const raw = msg?.content || msg?.body?.content || "";
  if (typeof raw !== "string" || !raw.startsWith("{")) return "";
  try {
    const parsed = JSON.parse(raw);
    const keys = ["image_key", "imageKey", "file_key", "fileKey", "key"];
    for (const k of keys) {
      if (parsed[k]) return String(parsed[k]);
    }
    if (parsed.image_url?.url) return String(parsed.image_url.url);
    if (parsed.url) return String(parsed.url);
  } catch {
    return "";
  }
  return "";
}

function sniffImageMime(buf) {
  if (!buf?.length) return "image/png";
  if (buf[0] === 0x89 && buf[1] === 0x50) return "image/png";
  if (buf[0] === 0xff && buf[1] === 0xd8) return "image/jpeg";
  if (buf[0] === 0x47 && buf[1] === 0x49) return "image/gif";
  if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46) return "image/webp";
  return "image/png";
}

/** 用飞书 open API 经 lark-cli 下载消息内图片，再交给 SiliconFlow（公网 URL 无法直接访问 img_ 资源）。 */
function downloadMessageImageDataUrl(msg) {
  const messageId = msg?.message_id || msg?.id;
  const fileKey = extractImageUrlFromMessage(msg);
  if (!messageId || !fileKey) throw new Error("missing message_id or image file_key");

  const base = join(process.env.HOME || ".", ".local/share/lark-bookkeeping/tmp");
  mkdirSync(base, { recursive: true });
  const workDir = mkdtempSync(join(base, "ocr-"));
  const relOut = "img.bin";
  try {
    const r = spawnSync(
      "lark-cli",
      [
        "im", "+messages-resources-download",
        "--as", "bot",
        "--message-id", String(messageId),
        "--file-key", String(fileKey),
        "--type", "image",
        "--output", relOut,
      ],
      { cwd: workDir, encoding: "utf8", timeout: 60_000, maxBuffer: 20 * 1024 * 1024, env: { ...process.env } },
    );
    if (r.error) throw new Error(r.error.message);
    if (r.status !== 0) {
      const err = (r.stderr || r.stdout || "").trim();
      throw new Error(err.slice(0, 400) || `exit ${r.status}`);
    }
    const absPath = join(workDir, relOut);
    if (!existsSync(absPath)) {
      let names = "";
      try { names = readdirSync(workDir).join(","); } catch {}
      throw new Error(`downloaded file missing (${names || "empty dir"})`);
    }
    const buf = readFileSync(absPath);
    const mime = sniffImageMime(buf);
    return `data:${mime};base64,${buf.toString("base64")}`;
  } finally {
    try { rmSync(workDir, { recursive: true, force: true }); } catch {}
  }
}

async function runDeepSeekOcr(imageUrlOrDataUrl) {
  const resp = await fetch(SILICONFLOW_API, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${SILICONFLOW_KEY}` },
    body: JSON.stringify({
      model: OCR_MODEL,
      messages: [
        {
          role: "user",
          // DeepSeek-OCR：图片 part 放前面时识别更稳；避免与「仅文本」指令打架。
          content: [
            { type: "image_url", image_url: { url: imageUrlOrDataUrl } },
            {
              type: "text",
              text: "请识别图中全部可见文字（含金额、商户、日期）。只输出纯文本，不要解释。",
            },
          ],
        },
      ],
      temperature: 0.1,
      max_tokens: 800,
    }),
    signal: AbortSignal.timeout(45_000),
  });
  if (!resp.ok) throw new Error(`OCR HTTP ${resp.status}`);
  const data = await resp.json();
  return (data?.choices?.[0]?.message?.content || "").trim();
}

// ─── Message polling ──────────────────────────────────────────────────────────

function fetchNewMessages(since) {
  const args = [
    "im", "+chat-messages-list",
    "--chat-id", CHAT_ID,
    "--sort", "asc",
    "--page-size", "20",
  ];
  if (since) args.push("--start", since);
  const r = lark(args, 25_000);
  // lark-cli returns data.messages (not data.items)
  return r?.data?.messages || [];
}

function extractText(msg) {
  // lark-cli returns content as a plain string (not nested JSON)
  const raw = msg.content || msg.body?.content || "";
  // Some message types wrap in JSON: '{"text":"..."}'
  if (typeof raw === "string" && raw.startsWith("{")) {
    try {
      const parsed = JSON.parse(raw);
      return (parsed.text || "").trim();
    } catch { /* fall through */ }
  }
  return String(raw).trim();
}

// ─── Process a single message ─────────────────────────────────────────────────

async function processMessage(msg) {
  let text = extractText(msg);
  if (msg?.message_type === "image") {
    const imageKey = extractImageUrlFromMessage(msg);
    if (!imageKey) {
      appendFeedbackEntry("图片消息", "无法从消息体提取 image_key/url");
      if (!DRY_RUN) sendIM("📷 收到图片，但无法读取图片字段。请再发一条文字记账，或稍后重试。");
      return;
    }
    let ocrText = "";
    try {
      const imageRef = extractImageUrlFromMessage(msg);
      const payload =
        /^https?:\/\//i.test(imageRef) ? imageRef : downloadMessageImageDataUrl(msg);
      ocrText = await runDeepSeekOcr(payload);
    } catch (e) {
      appendFeedbackEntry(`图片消息 key=${imageKey}`, `OCR失败: ${e.message}`);
      if (!DRY_RUN) sendIM(`📷 OCR 失败：${e.message}\n你也可以再发一条文字记账。`);
      return;
    }
    if (!ocrText) {
      appendFeedbackEntry(`图片消息 key=${imageKey}`, "OCR返回空文本");
      if (!DRY_RUN) sendIM("📷 OCR 未识别到文字。请再发一条文字记账。");
      return;
    }
    text = `【图片OCR】${ocrText}`;
    log(`OCR: ${text.slice(0, 200)}`);
  } else if (msg?.message_type && msg.message_type !== "text") {
    appendFeatureRequestEntry(`自动记录: 消息类型 ${msg.message_type}`, "暂不支持该消息类型的自动记账");
    if (!DRY_RUN) sendIM(`暂不支持该类型消息：${msg.message_type}。请用文字记账。`);
    return;
  }

  if (!text) return;

  // Skip bot's own confirmation messages and hint messages
  if (text.startsWith("✅ 已记账") || text.startsWith("❌ 记账失败") || text.startsWith("🤖 记账机器人")) return;
  if (text.startsWith("账户余额：")) return;

  log(`Processing: "${text}"`);

  const cmd = parseControlCommand(text);
  if (cmd) {
    if (DRY_RUN) { log(`[dry-run] control command: ${JSON.stringify(cmd)}`); return; }
    try {
      if (cmd.action === "balance") {
        sendIM(getBalanceSummary());
        return;
      }
      if (cmd.action === "monthly") {
        sendIM("月度汇总请用命令行: node scripts/lark-record.mjs --monthly");
        return;
      }
      if (cmd.action === "list") {
        sendIM(summarizeRecentRecords(cmd.limit));
        return;
      }
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
      if (cmd.action === "feature_bulk") {
        const items = (cmd.items || []).slice(0, 20);
        if (!items.length) {
          sendIM("请在“增加功能”后按行写需求，例如：增加功能\\n1. 支持聊天\\n2. 支持图片解析");
          return;
        }
        for (const item of items) appendFeatureRequestEntry(text, item);
        sendIM(`✅ 已记录 ${items.length} 条功能需求\n- ${items.join("\n- ")}`);
        return;
      }
      if (cmd.action === "list_features") {
        sendIM(summarizeFeatureRequests(cmd.limit));
        return;
      }
      if (cmd.action === "list_feedback") {
        sendIM(summarizeFeedback(cmd.limit));
        return;
      }
    } catch (e) {
      appendFeedbackEntry(text, `命令执行失败: ${e.message}`);
      sendIM(`❌ 操作失败: ${e.message}`);
      return;
    }
  }

  let parsed;
  try {
    parsed = await parseWithAI(text);
  } catch (e) {
    log(`AI parse error: ${e.message}`);
    if (!DRY_RUN) {
      appendFeedbackEntry(text, `AI解析失败: ${e.message}`);
      sendIM(
        `❌ 记账解析失败：${e.message}\n可尝试缩短文字、拆成多条发送，或设置 LARK_PARSE_TIMEOUT_MS / LARK_BOOKKEEPING_PARSE_TIMEOUT_MS 后重启守护进程。`
      );
    }
    return;
  }

  const entries = entriesFromAiJson(parsed);

  // Special commands (AI fallback) — 仅当未解析出记账条目时
  if (entries.length === 0) {
    if (parsed.command === "balance") {
      if (!DRY_RUN) sendIM(getBalanceSummary());
      return;
    }
    if (parsed.command === "monthly") {
      if (!DRY_RUN) sendIM("月度汇总请用命令行: node scripts/lark-record.mjs --monthly");
      return;
    }

    // Not a bookkeeping entry — send a brief hint
    if (parsed.not_bookkeeping) {
      log(`  → Not a bookkeeping entry, sending hint`);
      if (!DRY_RUN) {
        const recent = listRecentRecords(1)[0];
        if (/(删除|撤销).*(这条|这笔)/.test(text)) {
          appendFeedbackEntry(text, "自动检测：删除意图未命中", recent?.id || "");
          sendIM(`🤖 我理解你想删除记录，但还没定位到具体 ID。\n可直接发：删除上一笔\n或：删除 ${recent?.id || "recxxxx"}\n也可反馈：反馈 删除意图未命中`);
        } else if (/(不对|错了|不是这个)/.test(text)) {
          appendFeedbackEntry(text, "自动检测：纠错意图触发", recent?.id || "");
          sendIM(`🤖 收到纠错信号。\n最近记录: ${recent?.id || "-"}\n可发：修改 ${recent?.id || "recxxxx"} 金额=xx 备注=xx\n或发：反馈 你的纠错说明`);
        } else if (/(帮助|help|怎么用|指令)/i.test(text)) {
          sendIM(`🤖 记账机器人在线\n发记账消息：晚餐68微信 / 工资8000招行 / 借给小明500\n可一次发多笔（多行或一句话里多笔）\n发"查余额"查账户余额`);
        } else {
          try {
            const reply = await chatWithAI(text);
            sendIM(reply);
          } catch {
            sendIM("收到。你也可以直接发记账内容，比如：午饭25微信。");
          }
        }
      }
      return;
    }

    log(`  → Missing required fields, skipping`);
    return;
  }

  if (DRY_RUN) {
    for (const ent of entries) {
      log(`[dry-run] Would write: ${JSON.stringify(buildFields(ent))}`);
    }
    return;
  }

  try {
    const confirmLines = [];
    let n = 0;
    for (const ent of entries) {
      n++;
      const fields = buildFields(ent);
      const result = writeRecord(fields);
      if (!result.ok && result.code !== 0) throw new Error(`code=${result.code}: ${result.msg}`);
      const recId = extractRecordId(result);
      log(`✅ Written: ${recId}`);

      const type = ent["交易类型"];
      const amt = ent["金额"];
      const acct = ent["账户"] || ent["转出账户"] || "";
      const cat = ent["支出分类"] || ent["收入分类"] || "";
      const note = ent["备注"] || "";
      let line = `${n}. ID: ${recId}  ${type}  ¥${amt}`;
      if (acct) line += `  账户:${acct}`;
      if (cat) line += `  分类:${cat}`;
      if (note) line += `  备注:${note}`;
      confirmLines.push(line);
    }

    let confirmMsg =
      entries.length > 1
        ? `✅ 已记账 共 ${entries.length} 笔\n${confirmLines.join("\n")}`
        : `✅ 已记账\n${confirmLines[0]}`;
    if (text.startsWith("【图片OCR】")) {
      confirmMsg += `\nOCR: ${text.replace(/^【图片OCR】/, "").slice(0, 300)}`;
    }
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
  if (msg.message_type && msg.message_type !== "text" && msg.message_type !== "image") {
    log(`Skip unsupported message type: ${msg.message_type}`);
    return;
  }
  if (PROCESSED_IDS.has(msgId)) return;

  if (eventId) PROCESSED_EVENT_IDS.add(eventId);
  PROCESSED_IDS.add(msgId);
  STATE.lastHandledId = msgId;
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
  if (msg.message_type && msg.message_type !== "text" && msg.message_type !== "image") return;
  if (PROCESSED_IDS.has(msgId)) return;

  if (eventId) PROCESSED_EVENT_IDS.add(eventId);
  PROCESSED_IDS.add(msgId);
  STATE.lastHandledId = msgId;
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
  const ts = new Date().toISOString().replace("T", " ").slice(0, 19);
  console.log(`[${ts}] ${msg}`);
}

// ─── Main poll loop ───────────────────────────────────────────────────────────

async function pollLoop() {
  // On first start (no state yet), look back a configurable window (default 24h).
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
        if (!msgId) continue;
        if (PROCESSED_IDS.has(msgId)) continue;

        // Skip bot's own messages (sender type "app")
        if (msg.sender?.sender_type === "app") {
          PROCESSED_IDS.add(msgId);
          continue;
        }

        PROCESSED_IDS.add(msgId);
        await processMessage(msg);
        STATE.lastHandledId = msgId;
      }

      lastPollTime = now;
      STATE.lastPollTime = now;
      persistState();
    } catch (e) {
      log(`Poll error (will retry): ${e.message}`);
    }

    await new Promise(r => setTimeout(r, POLL_MS));
  }
}

async function main() {
  if (!APP_TOKEN || !LEDGER_TABLE || !ACCOUNT_TABLE || !SILICONFLOW_KEY) {
    throw new Error("missing required env: LARK_BOOKKEEPING_APP_TOKEN/LARK_BOOKKEEPING_LEDGER_TABLE/LARK_BOOKKEEPING_ACCOUNT_TABLE/SILICONFLOW_API_KEY");
  }
  if (!CHAT_ID && WEBHOOK_PORT <= 0) {
    throw new Error("missing required env: LARK_BOOKKEEPING_CHAT_ID (polling mode)");
  }

  MODEL = pickVoucherSafeRouterModel("理解用户说的一句话，识别是否在记账，提取金额和账户信息");
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
  log(`Polling every ${POLL_MS / 1000}s from ${STATE.lastPollTime || new Date(Date.now() - 60_000).toISOString()}`);
  await pollLoop();
}

main().catch(e => {
  console.error("Fatal:", e.message);
  process.exit(1);
});
