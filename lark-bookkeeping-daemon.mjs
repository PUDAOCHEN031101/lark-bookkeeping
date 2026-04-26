#!/usr/bin/env node
/**
 * lark-bookkeeping-daemon.mjs — 飞书聊天记账守护进程
 *
 * 监听机器人收到的飞书消息 → AI 解析 → 写多维表 → 在原会话发确认
 * 双人记账：发言人映射记账人、按「账户拥有者」解析账户、归属不一致时「确认记账」；见 .env.example
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
import { spawnSync } from "child_process";
import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, readdirSync } from "fs";
import { join, resolve, dirname } from "path";
import { homedir } from "os";
import { fileURLToPath } from "url";
import { VOUCHER_MODEL_SET } from "./scripts/lib/silicon-voucher-models.mjs";
import { loadEnvFile } from "./scripts/lib/local-env.mjs";
import { getLarkCliBin, larkCliWindowsHint, runLarkCliJson, spawnLarkCli, spawnLarkCliSync } from "./scripts/lib/lark-cli-local.mjs";
import {
  BOOKKEEPING_MULTI_INSTRUCTIONS,
  entriesFromAiJson,
} from "./scripts/lib/bookkeeping-multi.mjs";
import { normalizeBookkeepingLine, parseFastBookkeepingLines } from "./scripts/lib/bookkeeping-comma-triple.mjs";
import { getLlmApiKey, getLlmChatUrl, parseBookkeepingWithLLM } from "./scripts/lib/bookkeeping-parse-llm.mjs";
import {
  fuzzyMatchAccountRecordId,
  pickCanonicalAccountKey,
  reconcileParsedAccountFromUserText,
} from "./scripts/lib/bookkeeping-account-resolve.mjs";

const __dir = dirname(fileURLToPath(import.meta.url));

/** 开源仓库：从项目根目录 .env 注入（与 LARK_* 变量名一致） */
function loadEnvFromDotenv() {
  loadEnvFile(resolve(__dir, ".env"));
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
const LONG_WATCHDOG_MS = Number(process.env.LARK_LONG_WATCHDOG_MS) || 300_000;
const LONG_ERROR_RECONNECT_MS = Number(process.env.LARK_LONG_ERROR_RECONNECT_MS) || 30_000;
const CATCHUP_POLL_INTERVAL_MS = Number(process.env.LARK_CATCHUP_POLL_INTERVAL_MS) || 600_000;
const LARK_CLI_EVENT_SUBSCRIBE_FORCE = process.env.LARK_CLI_EVENT_SUBSCRIBE_FORCE !== "0";
const WEBHOOK_PORT  = Number(process.env.LARK_WEBHOOK_PORT) || 0;
const WEBHOOK_HOST  = process.env.LARK_WEBHOOK_HOST || "0.0.0.0";
const VERIFY_TOKEN  = process.env.LARK_VERIFICATION_TOKEN || "";
const DATA_DIR      = process.env.LARK_BOOKKEEPING_DATA_DIR || join(homedir(), ".local", "share", "lark-bookkeeping");
const STATE_FILE    = process.env.LARK_BOOKKEEPING_STATE_FILE || join(DATA_DIR, "state.json");
const FEEDBACK_FILE = process.env.LARK_BOOKKEEPING_FEEDBACK_FILE || join(DATA_DIR, "feedback.ndjson");
const FEATURE_FILE  = process.env.LARK_BOOKKEEPING_FEATURE_FILE || join(DATA_DIR, "feature-requests.ndjson");
const CHAT_IDS_RAW = process.env.LARK_BOOKKEEPING_CHAT_IDS || "";
const ENABLE_CHAT_REPLY = process.env.LARK_BOOKKEEPING_ENABLE_CHAT_REPLY === "1";
const REPLY_AS = (() => {
  const value = (process.env.LARK_REPLY_AS || "auto").toLowerCase();
  return ["auto", "bot", "user"].includes(value) ? value : "auto";
})();

/** 飞书 open_id / user_id / 显示名 → 流水表「记账人」单选值（与多维表选项一致） */
const USER_OWNER_MAP = (() => {
  const map = {};
  const raw = process.env.LARK_BOOKKEEPING_USER_OWNER_MAP || "";
  if (!raw) return map;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return { ...map, ...parsed };
    }
  } catch (e) {
    console.warn(`[lark-bookkeeping] user-owner map parse failed: ${e.message}`);
  }
  return map;
})();

/** 「查一下二老师的账户」等昵称 → 账户拥有者（与账户表「账户拥有者」一致） */
const OWNER_TOKEN_ALIASES = (() => {
  const base = {};
  const raw = process.env.LARK_BOOKKEEPING_OWNER_TOKEN_ALIASES || "";
  if (!raw) return base;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return { ...base, ...parsed };
    }
  } catch (e) {
    console.warn(`[lark-bookkeeping] OWNER_TOKEN_ALIASES parse failed: ${e.message}`);
  }
  return base;
})();

const DEFAULT_BOOKKEEPER = process.env.LARK_BOOKKEEPING_DEFAULT_BOOKKEEPER || "Darcen";
const ALLOWED_CHAT_IDS = (() => {
  const ids = new Set();
  for (const id of CHAT_IDS_RAW.split(",").map(s => s.trim()).filter(Boolean)) ids.add(id);
  if (CHAT_ID) ids.add(CHAT_ID);
  return ids;
})();
/** 记账人 vs 账户拥有者 不一致时暂存，待用户回复「确认记账」 */
const LEDGER_GUARD_PENDING = new Map();
/** 账户表无匹配时暂存，待「确认开户」后写入（与 Obsidian 版对齐） */
const ACCOUNT_CREATE_PENDING = new Map();
const LEDGER_GUARD_TTL_MS = 15 * 60 * 1000;
/** 设为 0 可关闭归属校验（默认开启） */
const OWNER_GUARD_ENABLED = process.env.LARK_BOOKKEEPING_OWNER_GUARD !== "0";
const LEDGER_EXPAND_DETAIL_CAP = Math.max(3, Math.min(50, Number(process.env.LARK_BOOKKEEPING_EXPAND_DETAIL_CAP) || 20));
const DETAIL_CONTEXT_TTL_MS = Math.max(60_000, Number(process.env.LARK_BOOKKEEPING_DETAIL_CONTEXT_TTL_MS) || 10 * 60_000);

let ACCOUNT_CACHE = { ts: 0, rows: [], fields: [], recIds: [] };
const DETAIL_CONTEXT = new Map();

/** 记账解析可改 BOOKKEEPING_LLM_CHAT_URL；OCR 仍可用 LARK_OCR_CHAT_URL 指硅基 */
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

function freshState() {
  return {
    processedIds: [],
    processedEventIds: [],
    lastPollTime: null,
    lastHandledId: "",
    observedChatIds: [],
    lastLongCatchupByChat: {},
    lastLongCatchupTime: null,
    longConnAwaitingRecover: false,
    lastLongDisconnectAt: "",
    lastLongRecoverAt: "",
  };
}

function normalizeState(s) {
  const state = s && typeof s === "object" ? s : freshState();
  if (!Array.isArray(state.processedIds)) state.processedIds = [];
  if (!Array.isArray(state.processedEventIds)) state.processedEventIds = [];
  if (!Array.isArray(state.observedChatIds)) state.observedChatIds = [];
  if (!state.lastLongCatchupByChat || typeof state.lastLongCatchupByChat !== "object") state.lastLongCatchupByChat = {};
  if (!Object.prototype.hasOwnProperty.call(state, "lastPollTime")) state.lastPollTime = null;
  if (!Object.prototype.hasOwnProperty.call(state, "lastHandledId")) state.lastHandledId = "";
  if (!Object.prototype.hasOwnProperty.call(state, "lastLongCatchupTime")) state.lastLongCatchupTime = null;
  if (!Object.prototype.hasOwnProperty.call(state, "longConnAwaitingRecover")) state.longConnAwaitingRecover = false;
  if (!Object.prototype.hasOwnProperty.call(state, "lastLongDisconnectAt")) state.lastLongDisconnectAt = "";
  if (!Object.prototype.hasOwnProperty.call(state, "lastLongRecoverAt")) state.lastLongRecoverAt = "";
  return state;
}

function loadState() {
  if (!existsSync(STATE_FILE)) return freshState();
  try {
    return normalizeState(JSON.parse(readFileSync(STATE_FILE, "utf8")));
  } catch {
    return freshState();
  }
}

function saveState(state) {
  mkdirSync(dirname(STATE_FILE), { recursive: true });
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

function observeChatId(chatId) {
  const id = String(chatId || "").trim();
  if (!id) return;
  if (!STATE.observedChatIds.includes(id)) {
    STATE.observedChatIds.push(id);
    if (STATE.observedChatIds.length > 50) STATE.observedChatIds = STATE.observedChatIds.slice(-50);
  }
}

// ─── lark-cli helper ──────────────────────────────────────────────────────────

function lark(args, timeout = 30_000) {
  return runLarkCliJson(args, { timeout });
}

// ─── AI parsing ───────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `你是个人记账助手。分析用户消息是否为记账请求，并解析为 JSON。

## 账户列表（须与「当前记账人」在飞书账户表里已开户的名称一致；两人卡名可以不同）
- 常见（Darcen 侧示例）：招商金葵花（口语「招行」「招商」）、**零钱通（所有微信支付场景：微信/零钱/微信零钱通 一律输出账户名「零钱通」）**、余额宝、招行黄金、建行(L1)、中国银行_self、**中国银行社保卡（用户说「社保卡」时填社保卡或中国银行社保卡）**、中国农业银行、中原银行_self、邮政_父母、人民币、港币、月付-N8、币安、支付宝黄金
- 另一人（如 Erkou）若表内账户名不同（例如「零钱」「招商」），按该人表里实际名称选，不要硬套上表别名。

## 交易类型
支出 / 收入 / 转账 / 负债 / 还款

## 支出分类
衣 / 食 / 住 / 行 / 娱 / 学 / 持续黑洞 / 其他支出

## 收入分类
工资 / 奖金补贴 / 报销返还 / 兼职劳务 / 投资利息 / 退款返现 / 他人转账 / 其他收入

## 日期规则
不说日期 → 日期留空 → 默认今天

## 账户列（重要）
- **微信相关（Darcen 常用口径）**：凡微信支付/红包/零钱/零钱通口语，「账户」优先填 **零钱通**（与飞书表内名称一致时）。
- **社保卡**：指中国银行社保卡，勿写成泛称「银行卡」。
- **支出、收入**：只填「账户」，「转出账户」「转入账户」必须留空字符串。
- **转账**：才同时填「转出账户」「转入账户」。
- **负债、还款**：一般只填「账户」及借贷相关列；非转账时不要填转出/转入。

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
  "账户": "零钱通",
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
  const chatUrl = getLlmChatUrl();
  const apiKey = getLlmApiKey();
  let lastErr;
  for (let attempt = 1; attempt <= PARSE_RETRIES; attempt++) {
    try {
      return await parseBookkeepingWithLLM({
        chatUrl,
        apiKey,
        model: MODEL,
        systemPrompt: SYSTEM_PROMPT,
        userText: text,
        signal: AbortSignal.timeout(PARSE_TIMEOUT_MS),
        onLog: (s) => log(s),
        maxTokens: 2_000,
      });
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

// ─── Account resolution（双人：按记账人 + 飞书账户表「账户拥有者」）────────────────

function accountTableLabel(rawName = "", owner = "") {
  const n0 = String(rawName || "").trim();
  const o = String(owner || "").trim();
  if (o === "Erkou") {
    if (n0 === "支付宝小荷花") return "小荷包";
    if (n0 === "微信" || n0 === "微信零钱") return "零钱";
    if (n0 === "零钱通" || n0 === "微信零钱通") return "零钱";
    if (n0 === "零钱") return "零钱";
    if (n0 === "招商" || n0 === "招行" || n0 === "金葵花" || n0 === "招商金葵花") return "招商";
    return n0;
  }
  if (o === "Darcen") {
    if (n0 === "微信" || n0 === "零钱" || n0 === "微信零钱" || n0 === "零钱通" || n0 === "微信零钱通") return "零钱通";
    if (n0 === "社保卡" || n0 === "中国银行社保卡") return "中国银行社保卡";
    if (n0 === "招商" || n0 === "招行" || n0 === "金葵花" || n0 === "招商金葵花") return "招商金葵花";
    return n0;
  }
  if (n0 === "微信" || n0 === "零钱" || n0 === "微信零钱" || n0 === "微信零钱通") return "零钱通";
  return n0;
}

function resolveAccount(name) {
  if (!name) return null;
  let n0 = String(name).trim();
  if (n0 === "微信" || n0 === "零钱" || n0 === "微信零钱" || n0 === "微信零钱通") n0 = "零钱通";
  if (n0 === "支付宝小荷花") n0 = "小荷包";
  if (ACCOUNTS[n0]) return ACCOUNTS[n0];
  return fuzzyMatchAccountRecordId(n0, ACCOUNTS);
}

function inferAccountMeta(rawName = "") {
  const n = String(rawName || "").trim();
  if (/月付/i.test(n)) return { accountType: "其他", accountAttr: "负债" };
  if (/微信|零钱|支付宝|小荷包|币安/i.test(n)) return { accountType: "电子支付", accountAttr: "资产" };
  if (/银行|招行|招商|中行|农行|建行|邮政/i.test(n)) return { accountType: "银行卡", accountAttr: "资产" };
  if (/港币|人民币|现金/i.test(n)) return { accountType: "现金", accountAttr: "资产" };
  return { accountType: "其他", accountAttr: "资产" };
}

function canonicalAccountName(rawName = "", owner = "") {
  const o = String(owner || "").trim();
  if (o) return accountTableLabel(String(rawName || "").trim(), o);
  let n = String(rawName || "").trim();
  if (n === "微信" || n === "零钱" || n === "微信零钱" || n === "微信零钱通") n = "零钱通";
  if (n === "支付宝小荷花") n = "小荷包";
  if (ACCOUNTS[n]) return n;
  return pickCanonicalAccountKey(n, ACCOUNTS);
}

function getCellSelectText(cell) {
  if (Array.isArray(cell)) {
    const first = cell[0];
    if (typeof first === "string") return first;
    if (first && typeof first === "object" && first.name) return String(first.name);
  }
  return String(cell || "").trim();
}

function listAccountTableRows(force = false) {
  const now = Date.now();
  if (!force && ACCOUNT_CACHE.rows.length && now - ACCOUNT_CACHE.ts < 60_000) {
    return ACCOUNT_CACHE;
  }
  const r = lark([
    "base", "+record-list",
    "--base-token", APP_TOKEN,
    "--table-id", ACCOUNT_TABLE,
    "--limit", "200",
  ]);
  ACCOUNT_CACHE = {
    ts: now,
    rows: r.data?.data || [],
    fields: r.data?.fields || [],
    recIds: r.data?.record_id_list || [],
  };
  return ACCOUNT_CACHE;
}

function findBestOwnerAccountRecordId(owner, rawAccountName) {
  if (!owner || !rawAccountName) return null;
  const { rows, fields, recIds } = listAccountTableRows();
  const idxName = fields.indexOf("账户名称");
  const idxOwner = fields.indexOf("账户拥有者");
  if (idxName < 0 || idxOwner < 0) return null;

  const target = canonicalAccountName(rawAccountName, owner);
  const raw = String(rawAccountName).trim();

  const nameToId = {};
  for (let i = 0; i < rows.length; i++) {
    const ownerName = getCellSelectText(rows[i][idxOwner]);
    if (ownerName !== owner) continue;
    const acctName = String(rows[i][idxName] || "").trim();
    const rid = recIds[i] || null;
    if (!acctName || !rid) continue;
    if (acctName === target || acctName === raw) return rid;
    nameToId[acctName] = rid;
  }
  let hit = fuzzyMatchAccountRecordId(target, nameToId);
  if (hit) return hit;
  hit = fuzzyMatchAccountRecordId(raw, nameToId);
  return hit || null;
}

function ensureAccountForOwner(owner, rawAccountName, options = {}) {
  if (!owner || !rawAccountName) return null;
  const {
    createIfMissing = true,
    initialBalance = 0,
    forceAccountType = "",
    forceAccountAttr = "",
    forceEnabled = true,
  } = options || {};

  const existing = findBestOwnerAccountRecordId(owner, rawAccountName);
  if (existing) return existing;
  if (!createIfMissing) return null;

  const target = canonicalAccountName(rawAccountName, owner);
  const meta = inferAccountMeta(target);
  const accountType = forceAccountType || meta.accountType;
  const accountAttr = forceAccountAttr || meta.accountAttr;
  const payload = {
    "账户名称": target,
    "账户类型": [accountType],
    "账户属性": [accountAttr],
    "账户拥有者": [owner],
    "是否启用": !!forceEnabled,
    "初始余额": Number(initialBalance) || 0,
  };
  const created = lark([
    "base", "+record-upsert",
    "--base-token", APP_TOKEN,
    "--table-id", ACCOUNT_TABLE,
    "--json", JSON.stringify(payload),
  ]);
  ACCOUNT_CACHE.ts = 0;
  return (
    created?.data?.record?.record_id ??
    created?.data?.record?.record_id_list?.[0] ??
    created?.data?.record_id_list?.[0] ??
    null
  );
}

function resolveAccountForOwner(owner, rawAccountName) {
  if (!rawAccountName) return null;
  if (!owner) return resolveAccount(rawAccountName);
  const fromTable = findBestOwnerAccountRecordId(owner, rawAccountName);
  if (fromTable) return fromTable;
  return resolveAccount(rawAccountName);
}

function listMissingAccountRefs(bookkeeper, parsed) {
  const missing = [];
  const tt = parsed["交易类型"];
  if (parsed["账户"] && !resolveAccountForOwner(bookkeeper, parsed["账户"])) {
    missing.push({ field: "账户", raw: String(parsed["账户"]).trim() });
  }
  if (tt === "转账") {
    if (parsed["转出账户"] && !resolveAccountForOwner(bookkeeper, parsed["转出账户"])) {
      missing.push({ field: "转出账户", raw: String(parsed["转出账户"]).trim() });
    }
    if (parsed["转入账户"] && !resolveAccountForOwner(bookkeeper, parsed["转入账户"])) {
      missing.push({ field: "转入账户", raw: String(parsed["转入账户"]).trim() });
    }
  }
  return missing;
}

function dedupeAccountMissing(entries, bookkeeper) {
  const seen = new Set();
  const out = [];
  for (const ent of entries) {
    for (const m of listMissingAccountRefs(bookkeeper, ent)) {
      const k = `${m.field}:${m.raw}`;
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(m);
    }
  }
  return out;
}

function resolveOwnerAliasToken(v) {
  const compact = String(v || "").replace(/\s+/g, "").trim();
  if (!compact) return undefined;
  if (OWNER_TOKEN_ALIASES[compact]) return OWNER_TOKEN_ALIASES[compact];
  if (OWNER_TOKEN_ALIASES[String(v || "").trim()]) return OWNER_TOKEN_ALIASES[String(v || "").trim()];
  const lower = compact.toLowerCase();
  for (const [k, val] of Object.entries(OWNER_TOKEN_ALIASES)) {
    const kk = String(k).replace(/\s+/g, "");
    if (kk.toLowerCase() === lower) return val;
  }
  return undefined;
}

function resolveOwnerToken(raw, fallbackOwner = "") {
  const v = String(raw || "").trim();
  if (!v) return fallbackOwner;
  if (/^(我|我的|me|self)$/i.test(v)) return fallbackOwner;
  const mapped = resolveOwnerAliasToken(v);
  if (mapped) return mapped;
  if (v === "Darcen" || v === "Erkou") return v;
  return null;
}

function resolveBookkeeper(msg) {
  const sender = msg?.sender || {};
  const candidates = [
    sender.id,
    sender.open_id,
    sender.user_id,
    sender.union_id,
    sender.name,
  ]
    .filter(Boolean)
    .map((x) => String(x).trim());
  for (const key of candidates) {
    if (Object.prototype.hasOwnProperty.call(USER_OWNER_MAP, key)) {
      const v = USER_OWNER_MAP[key];
      if (v) return String(v);
    }
  }
  return DEFAULT_BOOKKEEPER;
}

function ledgerGuardKey(msg) {
  const id = msg?.sender?.id || msg?.sender?.open_id || "unknown";
  return `${msg?.chat_id || ""}:${id}`;
}

function collectLinkedAccountRecordIds(fields) {
  const ids = [];
  for (const k of ["账户", "转出账户", "转入账户"]) {
    const v = fields[k];
    if (!Array.isArray(v)) continue;
    for (const x of v) {
      const id = typeof x === "string" ? x : x?.id;
      if (id && typeof id === "string" && /^rec[a-zA-Z0-9]+$/.test(id)) ids.push(id);
    }
  }
  return [...new Set(ids)];
}

function getAccountMetaForRecordId(recordId) {
  try {
    const r = lark(
      [
        "base", "+record-get",
        "--base-token", APP_TOKEN,
        "--table-id", ACCOUNT_TABLE,
        "--record-id", recordId,
      ],
      25_000
    );
    const rec = r?.data?.record;
    if (!rec) return { owner: "", name: recordId };
    return {
      owner: getCellSelectText(rec["账户拥有者"]),
      name: String(rec["账户名称"] || "").trim() || recordId,
    };
  } catch (e) {
    log(`getAccountMetaForRecordId failed (${recordId}): ${e.message}`);
    return { owner: "", name: recordId };
  }
}

function verifyLedgerOwnerGuard(bookkeeper, fields) {
  const ids = collectLinkedAccountRecordIds(fields);
  if (!ids.length) return { ok: true, mismatches: [] };
  const mismatches = [];
  for (const id of ids) {
    const { owner, name } = getAccountMetaForRecordId(id);
    if (!owner) continue;
    if (owner !== bookkeeper) mismatches.push({ id, owner, name });
  }
  if (!mismatches.length) return { ok: true, mismatches: [] };
  return { ok: false, mismatches };
}

// ─── Build record fields ──────────────────────────────────────────────────────

function buildFields(parsed, bookkeeper = "") {
  const fields = {};
  fields["交易类型"] = parsed["交易类型"];
  fields["金额"] = Number(parsed["金额"]);
  fields["记账人"] = [bookkeeper || DEFAULT_BOOKKEEPER];
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
    const rid = resolveAccountForOwner(bookkeeper, parsed["账户"]);
    if (rid) fields["账户"] = [rid];
  }
  if (parsed["交易类型"] === "转账") {
    if (parsed["转出账户"]) {
      const rid = resolveAccountForOwner(bookkeeper, parsed["转出账户"]);
      if (rid) fields["转出账户"] = [rid];
    }
    if (parsed["转入账户"]) {
      const rid = resolveAccountForOwner(bookkeeper, parsed["转入账户"]);
      if (rid) fields["转入账户"] = [rid];
    }
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

function sendIM(text, chatId = "", replyToMessageId = "") {
  const cid = chatId || CHAT_ID;
  if (!cid && !replyToMessageId) return;
  const identities = REPLY_AS === "auto" ? ["bot", "user"] : [REPLY_AS];
  let lastError = null;
  for (let idx = 0; idx < identities.length; idx++) {
    const as = identities[idx];
    const fallbackNote = idx < identities.length - 1 ? ", trying fallback" : "";
    if (ENABLE_CHAT_REPLY && replyToMessageId) {
      try {
        lark([
          "im", "+messages-reply",
          "--as", as,
          "--message-id", replyToMessageId,
          "--text", text,
        ]);
        return;
      } catch (e) {
        lastError = e;
        log(`IM reply as ${as} failed${fallbackNote}: ${e.message}`);
      }
    } else if (cid) {
      try {
        lark([
          "im", "+messages-send",
          "--as", as,
          "--chat-id", cid,
          "--text", text,
        ]);
        return;
      } catch (e) {
        lastError = e;
        log(`IM send as ${as} failed${fallbackNote}: ${e.message}`);
      }
    }
  }
  if (lastError) log(`IM send failed (non-fatal): ${lastError.message}`);
}

function gatherGuardMismatchesForEntries(entries, bookkeeper) {
  const seen = new Set();
  const out = [];
  for (const ent of entries) {
    const fields = buildFields(ent, bookkeeper);
    const g = verifyLedgerOwnerGuard(bookkeeper, fields);
    if (g.ok) continue;
    for (const m of g.mismatches) {
      if (seen.has(m.id)) continue;
      seen.add(m.id);
      out.push(m);
    }
  }
  return out;
}

/** 归属校验 + 写流水 + 发确认（与 Obsidian 双人记账对齐） */
async function finalizeIncomingLedgerWrite({
  parsed,
  bookkeeper,
  forceSkipOwnerGuard,
  ownerGuardAlreadyResolved,
  suppressConfirm,
  guardKey,
  replyChatId,
  replyToMessageId,
  text,
  dryRun,
}) {
  const fields = buildFields(parsed, bookkeeper);
  if (dryRun) {
    log(`[dry-run] Would write: ${JSON.stringify(fields)}`);
    return { ok: true };
  }
  const skipOwnerVerify = forceSkipOwnerGuard || ownerGuardAlreadyResolved;
  if (OWNER_GUARD_ENABLED && !skipOwnerVerify) {
    const guard = verifyLedgerOwnerGuard(bookkeeper, fields);
    if (!guard.ok && guard.mismatches.length) {
      LEDGER_GUARD_PENDING.set(guardKey, { entries: [parsed], bookkeeper, ts: Date.now() });
      const lines = guard.mismatches.map((m) => `- ${m.name}（${m.id}）归属：${m.owner}`).join("\n");
      sendIM(
        `⚠️ 记账人（${bookkeeper}）与账户归属不一致：\n${lines}\n\n要继续请回复：确认记账\n要放弃请回复：取消记账\n（也可在原消息加「强制」跳过确认）`,
        replyChatId,
        replyToMessageId
      );
      return { ok: false, reason: "guard_pending" };
    }
  }

  try {
    LEDGER_GUARD_PENDING.delete(guardKey);
    ACCOUNT_CREATE_PENDING.delete(guardKey);
    const result = writeRecord(fields);
    if (!result.ok && result.code !== 0) throw new Error(`code=${result.code}: ${result.msg}`);
    const recId = extractRecordId(result);
    log(`✅ Written: ${recId}`);

    const type = parsed["交易类型"];
    const amt = parsed["金额"];
    const acct = parsed["账户"] || parsed["转出账户"] || "";
    const cat = parsed["支出分类"] || parsed["收入分类"] || "";
    const note = parsed["备注"] || "";
    let confirmMsg = `✅ 已记账\nID: ${recId}\n类型: ${type}  金额: ¥${amt}`;
    if (acct) confirmMsg += `  账户: ${acct}`;
    if (cat) confirmMsg += `  分类: ${cat}`;
    if (note) confirmMsg += `\n备注: ${note}`;
    if (!suppressConfirm) sendIM(confirmMsg, replyChatId, replyToMessageId);
    return { ok: true, recId };
  } catch (e) {
    log(`Write failed: ${e.message}`);
    appendFeedbackEntry(text, `写入失败: ${e.message}`);
    sendIM(`❌ 记账失败: ${e.message}`, replyChatId, replyToMessageId);
    return { ok: false, reason: "write_error" };
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

function listAllLedgerRecords(maxRows = 3000, pageSize = 500) {
  const rows = [];
  let fields = [];
  let offset = 0;
  const safePageSize = Math.max(20, Math.min(500, Number(pageSize) || 200));
  while (rows.length < maxRows) {
    const r = lark([
      "base", "+record-list",
      "--base-token", APP_TOKEN,
      "--table-id", LEDGER_TABLE,
      "--limit", String(Math.min(safePageSize, maxRows - rows.length)),
      "--offset", String(offset),
    ], 45_000);
    const data = r.data || {};
    if (!fields.length) fields = data.fields || [];
    const batch = data.data || [];
    rows.push(...batch);
    if (!data.has_more || !batch.length) break;
    offset += batch.length;
  }
  return { rows, fields };
}

function selectText(value) {
  if (Array.isArray(value)) return String(value[0] || "");
  return String(value || "");
}

function filterLedgerRowsByBookkeeper(rows, fields, bookkeeper = "") {
  const who = String(bookkeeper || "").trim();
  const idx = fields.indexOf("记账人");
  if (!who || idx < 0) return rows;
  const hasAnyBookkeeper = rows.some((row) => selectText(row[idx]));
  if (!hasAnyBookkeeper) return rows;
  return rows.filter((row) => selectText(row[idx]) === who);
}

function parseRecordDate(raw) {
  if (!raw) return null;
  if (raw instanceof Date) return Number.isNaN(raw.getTime()) ? null : raw;
  if (typeof raw === "number") {
    const ms = raw < 1e12 ? raw * 1000 : raw;
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const text = String(raw).trim();
  if (!text) return null;
  let d = new Date(text.includes("T") ? text : text.replace(" ", "T"));
  if (!Number.isNaN(d.getTime())) return d;
  const m = text.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
  if (m) {
    d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return null;
}

function toDateOnlyString(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function formatDisplayDate(raw, parsedDate = null) {
  const s = String(raw || "").trim();
  const m = s.match(/^(\d{4}-\d{2}-\d{2})/);
  if (m) return m[1];
  if (parsedDate && !Number.isNaN(parsedDate.getTime())) return toDateOnlyString(parsedDate);
  return s || "-";
}

function getPeriodBounds(label) {
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const tomorrowStart = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  if (label === "今天") return { label, start: todayStart, end: tomorrowStart };
  if (label === "昨天") {
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
    return { label, start, end: todayStart };
  }
  if (label === "本周") {
    const day = todayStart.getDay();
    const diffToMonday = day === 0 ? -6 : 1 - day;
    const start = new Date(todayStart);
    start.setDate(todayStart.getDate() + diffToMonday);
    return { label, start, end: tomorrowStart };
  }
  if (label === "本月") {
    return { label, start: new Date(now.getFullYear(), now.getMonth(), 1), end: tomorrowStart };
  }
  if (label === "上月") {
    return { label, start: new Date(now.getFullYear(), now.getMonth() - 1, 1), end: new Date(now.getFullYear(), now.getMonth(), 1) };
  }
  return null;
}

function parsePeriodExpression(text, suffixPattern) {
  const t = String(text || "").trim().replace(/的/g, "");
  const named = [
    ["今天", /^(查|查询)?(今天|今日)/],
    ["昨天", /^(查|查询)?(昨天|昨日)/],
    ["本周", /^(查|查询)?(本周|这周|这一周)/],
    ["本月", /^(查|查询)?(本月|这个月)/],
    ["上月", /^(查|查询)?(上月|上个月)/],
  ];
  for (const [label, prefix] of named) {
    if (prefix.test(t) && suffixPattern.test(t)) return getPeriodBounds(label);
  }

  let m = t.match(/^(查|查询)?\s*(\d{4}-\d{2}-\d{2})\s*(.+)$/);
  if (m && suffixPattern.test(m[3])) {
    const start = new Date(`${m[2]}T00:00:00`);
    if (!Number.isNaN(start.getTime())) {
      const end = new Date(start);
      end.setDate(end.getDate() + 1);
      return { label: m[2], start, end };
    }
  }

  m = t.match(/^(查|查询)?\s*(\d{4}-\d{2})\s*(.+)$/);
  if (m && suffixPattern.test(m[3])) {
    const [y, mo] = m[2].split("-").map(Number);
    if (y && mo >= 1 && mo <= 12) {
      return { label: m[2], start: new Date(y, mo - 1, 1), end: new Date(y, mo, 1) };
    }
  }
  return null;
}

function getSpendPeriod(text) {
  return parsePeriodExpression(text, /(花了多少|支出|花费)$/);
}

function getIncomeExpensePeriod(text) {
  return parsePeriodExpression(text, /(收支明细|收支)$/);
}

function ledgerRowsForPeriod(period, bookkeeper = "") {
  const { rows: allRows, fields } = listAllLedgerRecords(3000, 500);
  const rows = filterLedgerRowsByBookkeeper(allRows, fields, bookkeeper);
  const idxType = fields.indexOf("交易类型");
  const idxAmount = fields.indexOf("金额");
  const idxNote = fields.indexOf("备注");
  const idxDate = fields.indexOf("日期");
  if (idxType < 0 || idxAmount < 0 || idxDate < 0) {
    throw new Error("账本字段缺失：交易类型/金额/日期");
  }
  return rows
    .map((row) => {
      const type = String(row[idxType] || "");
      const amount = Number(row[idxAmount] || 0);
      const note = idxNote >= 0 ? String(row[idxNote] || "") : "";
      const dateRaw = String(row[idxDate] || "");
      const date = parseRecordDate(dateRaw);
      return { type, amount, note, dateRaw, date };
    })
    .filter((x) => (x.type === "支出" || x.type === "收入") && x.amount > 0 && x.date)
    .filter((x) => x.date >= period.start && x.date < period.end)
    .sort((a, b) => b.date - a.date);
}

function summarizeSpendOverviewByPeriod(period, bookkeeper = "") {
  const rows = ledgerRowsForPeriod(period, bookkeeper).filter((x) => x.type === "支出");
  const total = rows.reduce((acc, x) => acc + x.amount, 0);
  const who = bookkeeper ? `（${bookkeeper}）` : "";
  return [
    `${period.label} 支出概览${who}`,
    `总计: ¥${total.toFixed(2)}（${rows.length} 笔）`,
    "",
    "如需明细请发：展开明细",
  ].join("\n");
}

function summarizeSpendDetailByPeriod(period, bookkeeper = "") {
  const rows = ledgerRowsForPeriod(period, bookkeeper).filter((x) => x.type === "支出");
  if (!rows.length) return `${period.label} 暂无支出记录${bookkeeper ? `（${bookkeeper}）` : ""}。`;
  const total = rows.reduce((acc, x) => acc + x.amount, 0);
  const lines = [
    `${period.label} 支出明细${bookkeeper ? `（${bookkeeper}）` : ""}`,
    `总计: ¥${total.toFixed(2)}（${rows.length} 笔）`,
    "",
  ];
  for (const x of rows.slice(0, LEDGER_EXPAND_DETAIL_CAP)) {
    lines.push(`- ¥${x.amount.toFixed(2)} | ${x.note || "-"} | ${formatDisplayDate(x.dateRaw, x.date)}`);
  }
  if (rows.length > LEDGER_EXPAND_DETAIL_CAP) lines.push(`... 尚有 ${rows.length - LEDGER_EXPAND_DETAIL_CAP} 笔未列出`);
  return lines.join("\n");
}

function summarizeIncomeExpenseOverviewByPeriod(period, bookkeeper = "") {
  const rows = ledgerRowsForPeriod(period, bookkeeper);
  const spendRows = rows.filter((x) => x.type === "支出");
  const incomeRows = rows.filter((x) => x.type === "收入");
  const spend = spendRows.reduce((acc, x) => acc + x.amount, 0);
  const income = incomeRows.reduce((acc, x) => acc + x.amount, 0);
  const who = bookkeeper ? `（${bookkeeper}）` : "";
  return [
    `${period.label} 收支概览${who}`,
    `收入: ¥${income.toFixed(2)}（${incomeRows.length} 笔）`,
    `支出: ¥${spend.toFixed(2)}（${spendRows.length} 笔）`,
    `净额: ¥${(income - spend).toFixed(2)}`,
    "",
    "如需明细请发：展开明细",
  ].join("\n");
}

function summarizeIncomeExpenseDetailByPeriod(period, bookkeeper = "") {
  const rows = ledgerRowsForPeriod(period, bookkeeper);
  const spendRows = rows.filter((x) => x.type === "支出");
  const incomeRows = rows.filter((x) => x.type === "收入");
  const spend = spendRows.reduce((acc, x) => acc + x.amount, 0);
  const income = incomeRows.reduce((acc, x) => acc + x.amount, 0);
  const lines = [
    `${period.label} 收支明细${bookkeeper ? `（${bookkeeper}）` : ""}`,
    `收入: ¥${income.toFixed(2)}（${incomeRows.length} 笔）`,
    `支出: ¥${spend.toFixed(2)}（${spendRows.length} 笔）`,
    `净额: ¥${(income - spend).toFixed(2)}`,
  ];
  lines.push("", "收入明细：");
  if (incomeRows.length) {
    for (const x of incomeRows.slice(0, LEDGER_EXPAND_DETAIL_CAP)) {
      lines.push(`- ¥${x.amount.toFixed(2)} | ${x.note || "-"} | ${formatDisplayDate(x.dateRaw, x.date)}`);
    }
    if (incomeRows.length > LEDGER_EXPAND_DETAIL_CAP) lines.push(`... 尚有 ${incomeRows.length - LEDGER_EXPAND_DETAIL_CAP} 笔收入未列出`);
  } else {
    lines.push("暂无");
  }
  lines.push("", "支出明细：");
  if (spendRows.length) {
    for (const x of spendRows.slice(0, LEDGER_EXPAND_DETAIL_CAP)) {
      lines.push(`- ¥${x.amount.toFixed(2)} | ${x.note || "-"} | ${formatDisplayDate(x.dateRaw, x.date)}`);
    }
    if (spendRows.length > LEDGER_EXPAND_DETAIL_CAP) lines.push(`... 尚有 ${spendRows.length - LEDGER_EXPAND_DETAIL_CAP} 笔支出未列出`);
  } else {
    lines.push("暂无");
  }
  return lines.join("\n");
}

function setDetailContext(key, ctx) {
  DETAIL_CONTEXT.set(key, { ...ctx, ts: Date.now() });
}

function getDetailContext(key) {
  const ctx = DETAIL_CONTEXT.get(key);
  if (!ctx) return null;
  if (Date.now() - ctx.ts > DETAIL_CONTEXT_TTL_MS) {
    DETAIL_CONTEXT.delete(key);
    return null;
  }
  return ctx;
}

function readRecentJsonLines(file, limit = 5) {
  if (!existsSync(file)) return [];
  try {
    const lines = readFileSync(file, "utf8").split(/\r?\n/).map(s => s.trim()).filter(Boolean);
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
  if (/^(展开明细|查明细|明细)$/i.test(t)) return { action: "expand_details" };

  const spendPeriod = getSpendPeriod(t);
  if (spendPeriod) return { action: "spend_overview", period: spendPeriod };

  const incomeExpensePeriod = getIncomeExpensePeriod(t);
  if (incomeExpensePeriod) return { action: "income_expense_detail", period: incomeExpensePeriod };

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

function buildUpdateFieldsFromKv(kv, bookkeeper = "") {
  const fields = {};
  if (kv["金额"]) fields["金额"] = Number(kv["金额"]);
  if (kv["备注"]) fields["备注"] = kv["备注"];
  if (kv["日期"]) fields["日期"] = kv["日期"];
  if (kv["交易类型"]) fields["交易类型"] = kv["交易类型"];
  if (kv["账户"]) {
    const rid = resolveAccountForOwner(bookkeeper, kv["账户"]);
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
  const resp = await fetch(getLlmChatUrl(), {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${getLlmApiKey()}` },
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

  const base = join(DATA_DIR, "tmp");
  mkdirSync(base, { recursive: true });
  const workDir = mkdtempSync(join(base, "ocr-"));
  const relOut = "img.bin";
  try {
    const r = spawnLarkCliSync(
      [
        "im", "+messages-resources-download",
        "--as", "bot",
        "--message-id", String(messageId),
        "--file-key", String(fileKey),
        "--type", "image",
        "--output", relOut,
      ],
      { cwd: workDir, encoding: "utf8", timeout: 60_000, maxBuffer: 20 * 1024 * 1024 },
    );
    if (r.error) throw new Error(`${r.error.message}.${larkCliWindowsHint()}`);
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
  const ocrUrl = process.env.LARK_OCR_CHAT_URL || SILICONFLOW_API;
  const ocrKey = getLlmApiKey() || SILICONFLOW_KEY;
  const resp = await fetch(ocrUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${ocrKey}` },
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

function chatIdsForFetch() {
  const ids = new Set();
  for (const id of ALLOWED_CHAT_IDS) ids.add(id);
  if (CHAT_ID) ids.add(CHAT_ID);
  for (const id of STATE.observedChatIds || []) ids.add(id);
  return [...ids].filter(Boolean);
}

function getCatchupResumeSinceForChat(chatId) {
  const backfillMs = Math.max(0, POLL_BACKFILL_SECONDS) * 1000;
  const floorSince = new Date(Date.now() - backfillMs).toISOString();
  const map = STATE.lastLongCatchupByChat;
  const perChat = map && typeof map === "object" ? map[chatId] : "";
  let resume = perChat || floorSince;
  if (resume < floorSince) resume = floorSince;
  return resume;
}

function catchupWatermarkIsoFromMsg(msg) {
  const raw = msg?.create_time ?? msg?.create_time_ms ?? msg?.updated_at ?? msg?.update_time ?? "";
  if (raw === "" || raw == null) return new Date().toISOString();
  const n = Number(raw);
  if (!Number.isNaN(n) && n > 0) {
    const ms = n < 1e12 ? n * 1000 : n;
    return new Date(ms).toISOString();
  }
  const d = new Date(String(raw));
  return Number.isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
}

function bumpLongCatchupWatermark(msg) {
  try {
    const chatId = msg?.chat_id || CHAT_ID || "";
    if (!chatId) return;
    observeChatId(chatId);
    const iso = catchupWatermarkIsoFromMsg(msg);
    if (!STATE.lastLongCatchupByChat || typeof STATE.lastLongCatchupByChat !== "object") {
      STATE.lastLongCatchupByChat = {};
    }
    const prev = STATE.lastLongCatchupByChat[chatId] || "";
    if (!prev || iso > prev) STATE.lastLongCatchupByChat[chatId] = iso;
    if (!STATE.lastLongCatchupTime || iso > STATE.lastLongCatchupTime) STATE.lastLongCatchupTime = iso;
  } catch {
    // ignore watermark failures
  }
}

function fetchChatMessagesOnePage({ since, chatId, pageToken = "" }) {
  const args = [
    "im", "+chat-messages-list",
    "--as", "bot",
    "--chat-id", chatId,
    "--sort", "asc",
    "--page-size", "50",
  ];
  if (pageToken) args.push("--page-token", pageToken);
  else if (since) args.push("--start", since);
  const r = lark(args, 25_000);
  const data = r?.data || {};
  return {
    messages: data.messages || [],
    nextPageToken: data.page_token || data.pageToken || data.next_page_token || "",
  };
}

function fetchNewMessages(since, chatId) {
  if (!chatId) return [];
  return fetchChatMessagesOnePage({ since, chatId }).messages;
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

function isSelfGeneratedBookkeepingNotice(text) {
  const t = String(text || "").trim();
  return (
    t.startsWith("✅ 已记账") ||
    t.startsWith("❌ 记账失败") ||
    t.startsWith("🤖 记账机器人") ||
    t.startsWith("账户余额：") ||
    t.startsWith("⚠️ 记账人") ||
    t.startsWith("⚠️ 记账机器人") ||
    t.startsWith("本轮补拉") ||
    t.startsWith("长连接已断开") ||
    t.startsWith("今天 支出") ||
    t.startsWith("昨天 支出") ||
    t.startsWith("本周 支出") ||
    t.startsWith("本月 支出") ||
    t.startsWith("上月 支出") ||
    t.startsWith("今天 收支") ||
    t.startsWith("昨天 收支") ||
    t.startsWith("本周 收支") ||
    t.startsWith("本月 收支") ||
    t.startsWith("上月 收支") ||
    t.startsWith("今天支出") ||
    t.startsWith("本周支出") ||
    t.startsWith("本月支出") ||
    t.startsWith("今天收支") ||
    t.startsWith("本周收支") ||
    t.startsWith("本月收支")
  );
}

async function backfillMissedMessagesBeforeLongSubscribe(reason) {
  const chatIds = chatIdsForFetch();
  if (!chatIds.length) {
    log(`[backfill] skip (${reason}): no chat ids yet`);
    return;
  }

  log(`[backfill] ${reason} chats=${chatIds.join(",")}`);
  const nowIso = new Date().toISOString();
  let replayed = 0;

  for (const chatId of chatIds) {
    const resumeSince = getCatchupResumeSinceForChat(chatId);
    let pageToken = "";
    for (let page = 0; page < 100; page++) {
      let batch;
      try {
        batch = fetchChatMessagesOnePage({ since: pageToken ? "" : resumeSince, chatId, pageToken });
      } catch (e) {
        log(`[backfill] chat=${chatId} page=${page + 1} error: ${e.message}`);
        break;
      }
      const { messages, nextPageToken } = batch;
      if (!messages.length && !nextPageToken) break;
      for (const msg of messages) {
        try {
          await handleIncomingMessage(msg, "");
        } catch (e) {
          log(`[backfill] handle msg=${msg?.message_id || msg?.id}: ${e.message}`);
        }
        replayed++;
      }
      if (!nextPageToken) break;
      pageToken = nextPageToken;
    }
    STATE.lastLongCatchupByChat[chatId] = nowIso;
  }

  STATE.lastLongCatchupTime = nowIso;
  if (STATE.longConnAwaitingRecover) {
    STATE.longConnAwaitingRecover = false;
    STATE.lastLongRecoverAt = nowIso;
  }
  persistState();
  log(`[backfill] ${reason} done, touched≈${replayed} message(s)`);
}

// ─── Process a single message ─────────────────────────────────────────────────

async function processMessage(msg) {
  if (msg?.sender?.sender_type && msg.sender.sender_type !== "user") return;

  const replyChatId = msg?.chat_id || CHAT_ID;
  const replyToMessageId = ENABLE_CHAT_REPLY ? (msg?.message_id || msg?.id || "") : "";
  const guardKey = ledgerGuardKey(msg);
  const bookkeeper = resolveBookkeeper(msg);

  let text = normalizeBookkeepingLine(extractText(msg));
  if (msg?.message_type === "image") {
    const imageKey = extractImageUrlFromMessage(msg);
    if (!imageKey) {
      appendFeedbackEntry("图片消息", "无法从消息体提取 image_key/url");
      if (!DRY_RUN) {
        sendIM("📷 收到图片，但无法读取图片字段。请再发一条文字记账，或稍后重试。", replyChatId, replyToMessageId);
      }
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
      if (!DRY_RUN) {
        sendIM(`📷 OCR 失败：${e.message}\n你也可以再发一条文字记账。`, replyChatId, replyToMessageId);
      }
      return;
    }
    if (!ocrText) {
      appendFeedbackEntry(`图片消息 key=${imageKey}`, "OCR返回空文本");
      if (!DRY_RUN) sendIM("📷 OCR 未识别到文字。请再发一条文字记账。", replyChatId, replyToMessageId);
      return;
    }
    text = normalizeBookkeepingLine(`【图片OCR】${ocrText}`);
    log(`OCR: ${text.slice(0, 200)}`);
  } else if (msg?.message_type && msg.message_type !== "text") {
    appendFeatureRequestEntry(`自动记录: 消息类型 ${msg.message_type}`, "暂不支持该消息类型的自动记账");
    if (!DRY_RUN) {
      sendIM(`暂不支持该类型消息：${msg.message_type}。请用文字记账。`, replyChatId, replyToMessageId);
    }
    return;
  }

  if (!text) return;

  // Skip bot's own confirmation messages and hint messages
  if (text.startsWith("✅ 已记账") || text.startsWith("❌ 记账失败") || text.startsWith("🤖 记账机器人")) return;
  if (text.startsWith("账户余额：")) return;
  if (text.startsWith("⚠️ 记账人")) return;

  if (/^确认记账\s*$/.test(text.trim())) {
    if (DRY_RUN) return;
    const pend = LEDGER_GUARD_PENDING.get(guardKey);
    if (!pend || Date.now() - pend.ts > LEDGER_GUARD_TTL_MS) {
      sendIM("没有待确认的记账，或已超时。请重新发一条记账消息。", replyChatId, replyToMessageId);
      return;
    }
    LEDGER_GUARD_PENDING.delete(guardKey);
    try {
      const lines = [];
      let n = 0;
      for (const ent of pend.entries) {
        n++;
        const fields = buildFields(ent, pend.bookkeeper);
        const result = writeRecord(fields);
        if (!result.ok && result.code !== 0) throw new Error(`code=${result.code}: ${result.msg}`);
        const recId = extractRecordId(result);
        log(`✅ Written (confirmed guard): ${recId}`);
        const type = ent["交易类型"];
        const amt = ent["金额"];
        const acct = ent["账户"] || ent["转出账户"] || "";
        const cat = ent["支出分类"] || ent["收入分类"] || "";
        const note = ent["备注"] || "";
        let line = `${n}. ID: ${recId}  ${type}  ¥${amt}`;
        if (acct) line += `  账户:${acct}`;
        if (cat) line += `  分类:${cat}`;
        if (note) line += `  备注:${note}`;
        lines.push(line);
      }
      const head =
        pend.entries.length > 1
          ? `✅ 已记账 共 ${pend.entries.length} 笔（已确认归属）\n`
          : "✅ 已记账（已确认归属）\n";
      sendIM(head + lines.join("\n"), replyChatId, replyToMessageId);
    } catch (e) {
      log(`Write failed (guard confirm): ${e.message}`);
      sendIM(`❌ 记账失败: ${e.message}`, replyChatId, replyToMessageId);
    }
    return;
  }
  if (/^取消记账\s*$/.test(text.trim())) {
    if (LEDGER_GUARD_PENDING.delete(guardKey)) {
      sendIM("已取消待确认记账。", replyChatId, replyToMessageId);
    } else {
      sendIM("当前没有待确认的记账。", replyChatId, replyToMessageId);
    }
    return;
  }
  if (/^确认开户\s*$/.test(text.trim())) {
    if (DRY_RUN) return;
    const pend = ACCOUNT_CREATE_PENDING.get(guardKey);
    if (!pend || Date.now() - pend.ts > LEDGER_GUARD_TTL_MS) {
      sendIM("没有待开户确认的记账，或已超时。请重新发一条记账消息。", replyChatId, replyToMessageId);
      return;
    }
    ACCOUNT_CREATE_PENDING.delete(guardKey);
    for (const m of pend.missing) {
      ensureAccountForOwner(pend.bookkeeper, m.raw, { createIfMissing: true });
    }
    ACCOUNT_CACHE.ts = 0;
    let ownerGuardFastPath = pend.forceSkipOwnerGuard || !OWNER_GUARD_ENABLED;
    if (OWNER_GUARD_ENABLED && !pend.forceSkipOwnerGuard) {
      const mm = gatherGuardMismatchesForEntries(pend.entries, pend.bookkeeper);
      if (mm.length) {
        LEDGER_GUARD_PENDING.set(guardKey, { entries: pend.entries, bookkeeper: pend.bookkeeper, ts: Date.now() });
        const lines = mm.map((x) => `- ${x.name}（${x.id}）归属：${x.owner}`).join("\n");
        sendIM(
          `⚠️ 账户已创建/匹配，但记账人（${pend.bookkeeper}）与账户归属仍不一致：\n${lines}\n\n要继续请回复：确认记账\n要放弃请回复：取消记账`,
          replyChatId,
          replyToMessageId
        );
        return;
      }
      ownerGuardFastPath = true;
    }
    const confirmLines = [];
    let n = 0;
    for (const ent of pend.entries) {
      n++;
      const r = await finalizeIncomingLedgerWrite({
        parsed: ent,
        bookkeeper: pend.bookkeeper,
        forceSkipOwnerGuard: pend.forceSkipOwnerGuard,
        ownerGuardAlreadyResolved: ownerGuardFastPath,
        suppressConfirm: pend.entries.length > 1,
        guardKey,
        replyChatId,
        replyToMessageId,
        text: "(确认开户)",
        dryRun: false,
      });
      if (!r.ok) return;
      const type = ent["交易类型"];
      const amt = ent["金额"];
      const acct = ent["账户"] || ent["转出账户"] || "";
      const cat = ent["支出分类"] || ent["收入分类"] || "";
      const note = ent["备注"] || "";
      let line = `${n}. ID: ${r.recId}  ${type}  ¥${amt}`;
      if (acct) line += `  账户:${acct}`;
      if (cat) line += `  分类:${cat}`;
      if (note) line += `  备注:${note}`;
      confirmLines.push(line);
    }
    if (pend.entries.length > 1) {
      sendIM(`✅ 已记账 共 ${pend.entries.length} 笔（确认开户）\n${confirmLines.join("\n")}`, replyChatId, replyToMessageId);
    }
    return;
  }
  if (/^取消开户\s*$/.test(text.trim())) {
    if (ACCOUNT_CREATE_PENDING.delete(guardKey)) {
      sendIM("已取消；未新建账户，本条未写入。", replyChatId, replyToMessageId);
    } else {
      sendIM("当前没有待开户确认的记账。", replyChatId, replyToMessageId);
    }
    return;
  }

  log(`Processing: "${text}"`);

  const cmd = parseControlCommand(text);
  if (cmd) {
    if (DRY_RUN) { log(`[dry-run] control command: ${JSON.stringify(cmd)}`); return; }
    try {
      if (cmd.action === "balance") {
        sendIM(getBalanceSummary(), replyChatId, replyToMessageId);
        return;
      }
      if (cmd.action === "monthly") {
        sendIM("月度汇总请用命令行: node scripts/lark-record.mjs --monthly", replyChatId, replyToMessageId);
        return;
      }
      if (cmd.action === "spend_overview") {
        setDetailContext(guardKey, { kind: "spend", period: cmd.period, bookkeeper });
        sendIM(summarizeSpendOverviewByPeriod(cmd.period, bookkeeper), replyChatId, replyToMessageId);
        return;
      }
      if (cmd.action === "income_expense_detail") {
        setDetailContext(guardKey, { kind: "income_expense", period: cmd.period, bookkeeper });
        sendIM(summarizeIncomeExpenseDetailByPeriod(cmd.period, bookkeeper), replyChatId, replyToMessageId);
        return;
      }
      if (cmd.action === "expand_details") {
        const ctx = getDetailContext(guardKey);
        if (!ctx) {
          sendIM("还没有可展开的查询结果。先发：今天花了多少 / 本周收支明细 / 本月花了多少。", replyChatId, replyToMessageId);
          return;
        }
        const msg = ctx.kind === "spend"
          ? summarizeSpendDetailByPeriod(ctx.period, ctx.bookkeeper)
          : summarizeIncomeExpenseDetailByPeriod(ctx.period, ctx.bookkeeper);
        sendIM(msg, replyChatId, replyToMessageId);
        return;
      }
      if (cmd.action === "list") {
        sendIM(summarizeRecentRecords(cmd.limit), replyChatId, replyToMessageId);
        return;
      }
      if (cmd.action === "delete_last") {
        const last = listRecentRecords(1)[0];
        if (!last) {
          sendIM("没有可撤销的记录。", replyChatId, replyToMessageId);
          return;
        }
        deleteRecord(last.id);
        sendIM(`✅ 已删除上一笔: ${last.id} ¥${last.amount.toFixed(2)} ${last.note || ""}`.trim(), replyChatId, replyToMessageId);
        return;
      }
      if (cmd.action === "delete_id") {
        deleteRecord(cmd.recordId);
        sendIM(`✅ 已删除记录: ${cmd.recordId}`, replyChatId, replyToMessageId);
        return;
      }
      if (cmd.action === "update") {
        const fields = buildUpdateFieldsFromKv(cmd.kv || {}, bookkeeper);
        if (!Object.keys(fields).length) {
          sendIM("修改失败：请使用 关键字=值，例如：修改 recxxxx 金额=88 备注=午饭 分类=食 账户=微信", replyChatId, replyToMessageId);
          return;
        }
        updateRecord(cmd.recordId, fields);
        sendIM(`✅ 已修改记录: ${cmd.recordId}\n更新字段: ${Object.keys(fields).join(", ")}`, replyChatId, replyToMessageId);
        return;
      }
      if (cmd.action === "feedback") {
        const last = listRecentRecords(1)[0];
        appendFeedbackEntry(text, cmd.content || "", last?.id || "");
        sendIM(`✅ 已收到反馈\n内容: ${cmd.content}\n最近记录: ${last?.id || "-"}`, replyChatId, replyToMessageId);
        return;
      }
      if (cmd.action === "feature_request") {
        appendFeatureRequestEntry(text, cmd.content || "");
        sendIM(`✅ 已记录新功能需求\n内容: ${cmd.content}`, replyChatId, replyToMessageId);
        return;
      }
      if (cmd.action === "feature_bulk") {
        const items = (cmd.items || []).slice(0, 20);
        if (!items.length) {
          sendIM("请在“增加功能”后按行写需求，例如：增加功能\\n1. 支持聊天\\n2. 支持图片解析", replyChatId, replyToMessageId);
          return;
        }
        for (const item of items) appendFeatureRequestEntry(text, item);
        sendIM(`✅ 已记录 ${items.length} 条功能需求\n- ${items.join("\n- ")}`, replyChatId, replyToMessageId);
        return;
      }
      if (cmd.action === "list_features") {
        sendIM(summarizeFeatureRequests(cmd.limit), replyChatId, replyToMessageId);
        return;
      }
      if (cmd.action === "list_feedback") {
        sendIM(summarizeFeedback(cmd.limit), replyChatId, replyToMessageId);
        return;
      }
    } catch (e) {
      appendFeedbackEntry(text, `命令执行失败: ${e.message}`);
      sendIM(`❌ 操作失败: ${e.message}`, replyChatId, replyToMessageId);
      return;
    }
  }

  const forceSkipOwnerGuard = /强制/.test(text);
  const textForAI = text.replace(/强制/g, "").trim();
  if (!textForAI && forceSkipOwnerGuard) {
    if (!DRY_RUN) {
      sendIM("请在「强制」后写上记账内容，例如：强制 午饭25微信", replyChatId, replyToMessageId);
    }
    return;
  }

  let parsed;
  let entries = parseFastBookkeepingLines(textForAI || text);
  try {
    if (entries.length) {
      parsed = entries.length === 1 ? entries[0] : { entries };
      log(`Local parse: ${JSON.stringify(parsed)}`);
    } else {
      parsed = await parseWithAI(textForAI || text);
      const reconcileSource = textForAI || text;
      entries = entriesFromAiJson(parsed).map((ent) => {
        reconcileParsedAccountFromUserText(ent, reconcileSource);
        return ent;
      });
    }
  } catch (e) {
    log(`AI parse error: ${e.message}`);
    if (!DRY_RUN) {
      appendFeedbackEntry(text, `AI解析失败: ${e.message}`);
      sendIM(
        `❌ 记账解析失败：${e.message}\n可尝试缩短文字、拆成多条发送，或设置 LARK_PARSE_TIMEOUT_MS / LARK_BOOKKEEPING_PARSE_TIMEOUT_MS 后重启守护进程。`,
        replyChatId,
        replyToMessageId
      );
    }
    return;
  }

  // Special commands (AI fallback) — 仅当未解析出记账条目时
  if (entries.length === 0) {
    if (parsed.command === "balance") {
      if (!DRY_RUN) sendIM(getBalanceSummary(), replyChatId, replyToMessageId);
      return;
    }
    if (parsed.command === "monthly") {
      if (!DRY_RUN) sendIM("月度汇总请用命令行: node scripts/lark-record.mjs --monthly", replyChatId, replyToMessageId);
      return;
    }

    // Not a bookkeeping entry — send a brief hint
    if (parsed.not_bookkeeping) {
      log(`  → Not a bookkeeping entry, sending hint`);
      if (!DRY_RUN) {
        const recent = listRecentRecords(1)[0];
        if (/(删除|撤销).*(这条|这笔)/.test(text)) {
          appendFeedbackEntry(text, "自动检测：删除意图未命中", recent?.id || "");
          sendIM(
            `🤖 我理解你想删除记录，但还没定位到具体 ID。\n可直接发：删除上一笔\n或：删除 ${recent?.id || "recxxxx"}\n也可反馈：反馈 删除意图未命中`,
            replyChatId,
            replyToMessageId
          );
        } else if (/(不对|错了|不是这个)/.test(text)) {
          appendFeedbackEntry(text, "自动检测：纠错意图触发", recent?.id || "");
          sendIM(
            `🤖 收到纠错信号。\n最近记录: ${recent?.id || "-"}\n可发：修改 ${recent?.id || "recxxxx"} 金额=xx 备注=xx\n或发：反馈 你的纠错说明`,
            replyChatId,
            replyToMessageId
          );
        } else if (/(帮助|help|怎么用|指令)/i.test(text)) {
          sendIM(
            `🤖 记账机器人在线\n发记账消息：晚餐68微信 / 晚餐，68，微信 / 余额宝转招行500\n查询：查余额 / 查最近5笔 / 今天花了多少 / 本周收支明细\n可一次发多笔（多行或一句话里多笔）`,
            replyChatId,
            replyToMessageId
          );
        } else {
          try {
            const reply = await chatWithAI(text);
            sendIM(reply, replyChatId, replyToMessageId);
          } catch {
            sendIM("收到。你也可以直接发记账内容，比如：午饭25微信。", replyChatId, replyToMessageId);
          }
        }
      }
      return;
    }

    log(`  → Missing required fields, skipping`);
    return;
  }

  const allMissing = dedupeAccountMissing(entries, bookkeeper);
  if (allMissing.length) {
    ACCOUNT_CREATE_PENDING.set(guardKey, {
      entries,
      bookkeeper,
      missing: allMissing,
      forceSkipOwnerGuard,
      ts: Date.now(),
    });
    if (!DRY_RUN) {
      sendIM(
        `⚠️ 以下账户在飞书账户表与本机默认别名中均无法匹配到 rec_id，不能直接落账：\n` +
          allMissing.map((m) => `- ${m.field}：「${m.raw}」`).join("\n") +
          `\n\n回复 **确认开户** 将按上述名称在账户表**新建一行**并完成本笔记账。\n` +
          `回复 **取消开户** 放弃本条。\n` +
          `若已有账户只是名称不一致，请改用与飞书「账户名称」一致的叫法再发。`,
        replyChatId,
        replyToMessageId
      );
    } else {
      log(`[dry-run] Would prompt 确认开户: ${JSON.stringify(allMissing)}`);
    }
    return;
  }

  let ownerGuardFastPath = forceSkipOwnerGuard || !OWNER_GUARD_ENABLED;
  if (OWNER_GUARD_ENABLED && !forceSkipOwnerGuard) {
    const mm = gatherGuardMismatchesForEntries(entries, bookkeeper);
    if (mm.length) {
      LEDGER_GUARD_PENDING.set(guardKey, { entries, bookkeeper, ts: Date.now() });
      const lines = mm.map((m) => `- ${m.name}（${m.id}）归属：${m.owner}`).join("\n");
      sendIM(
        `⚠️ 记账人（${bookkeeper}）与账户归属不一致：\n${lines}\n\n要继续请回复：确认记账\n要放弃请回复：取消记账\n（也可在原消息加「强制」跳过确认）`,
        replyChatId,
        replyToMessageId
      );
      return;
    }
    ownerGuardFastPath = true;
  }

  if (DRY_RUN) {
    for (const ent of entries) {
      log(`[dry-run] Would write: ${JSON.stringify(buildFields(ent, bookkeeper))}`);
    }
    return;
  }

  try {
    const confirmLines = [];
    let n = 0;
    for (const ent of entries) {
      n++;
      const r = await finalizeIncomingLedgerWrite({
        parsed: ent,
        bookkeeper,
        forceSkipOwnerGuard,
        ownerGuardAlreadyResolved: ownerGuardFastPath,
        suppressConfirm: entries.length > 1,
        guardKey,
        replyChatId,
        replyToMessageId,
        text,
        dryRun: false,
      });
      if (!r.ok) return;
      const type = ent["交易类型"];
      const amt = ent["金额"];
      const acct = ent["账户"] || ent["转出账户"] || "";
      const cat = ent["支出分类"] || ent["收入分类"] || "";
      const note = ent["备注"] || "";
      let line = `${n}. ID: ${r.recId}  ${type}  ¥${amt}`;
      if (acct) line += `  账户:${acct}`;
      if (cat) line += `  分类:${cat}`;
      if (note) line += `  备注:${note}`;
      confirmLines.push(line);
    }

    if (entries.length > 1) {
      let confirmMsg = `✅ 已记账 共 ${entries.length} 笔\n${confirmLines.join("\n")}`;
      if (text.startsWith("【图片OCR】")) {
        confirmMsg += `\nOCR: ${text.replace(/^【图片OCR】/, "").slice(0, 300)}`;
      }
      sendIM(confirmMsg, replyChatId, replyToMessageId);
    }
  } catch (e) {
    log(`Write failed: ${e.message}`);
    appendFeedbackEntry(text, `写入失败: ${e.message}`);
    sendIM(`❌ 记账失败: ${e.message}`, replyChatId, replyToMessageId);
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
      id: event.sender?.sender_id?.open_id || "",
      open_id: event.sender?.sender_id?.open_id || "",
      user_id: event.sender?.sender_id?.user_id || "",
      union_id: event.sender?.sender_id?.union_id || "",
      name: event.sender?.sender_id?.name || "",
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
  if (ALLOWED_CHAT_IDS.size > 0 && msg.chat_id && !ALLOWED_CHAT_IDS.has(msg.chat_id)) {
    log(`Skip message from unmatched chat: ${msg.chat_id}`);
    return;
  }
  if (msg.message_type && msg.message_type !== "text" && msg.message_type !== "image") {
    log(`Skip unsupported message type: ${msg.message_type}`);
    return;
  }
  if (PROCESSED_IDS.has(msgId)) return;
  if (isSelfGeneratedBookkeepingNotice(normalizeBookkeepingLine(extractText(msg)))) {
    if (eventId) PROCESSED_EVENT_IDS.add(eventId);
    PROCESSED_IDS.add(msgId);
    bumpLongCatchupWatermark(msg);
    persistState();
    return;
  }

  if (eventId) PROCESSED_EVENT_IDS.add(eventId);
  PROCESSED_IDS.add(msgId);
  bumpLongCatchupWatermark(msg);
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
  if (ALLOWED_CHAT_IDS.size > 0 && msg.chat_id && !ALLOWED_CHAT_IDS.has(msg.chat_id)) return;
  if (msg.message_type && msg.message_type !== "text" && msg.message_type !== "image") return;
  if (PROCESSED_IDS.has(msgId)) return;
  if (isSelfGeneratedBookkeepingNotice(normalizeBookkeepingLine(extractText(msg)))) {
    if (eventId) PROCESSED_EVENT_IDS.add(eventId);
    PROCESSED_IDS.add(msgId);
    bumpLongCatchupWatermark(msg);
    persistState();
    return;
  }

  if (eventId) PROCESSED_EVENT_IDS.add(eventId);
  PROCESSED_IDS.add(msgId);
  bumpLongCatchupWatermark(msg);
  STATE.lastHandledId = msgId;
  persistState();
  await processMessage(msg);
}

async function startLongConnectionLoop() {
  while (true) {
    try {
      await backfillMissedMessagesBeforeLongSubscribe("before_long_subscribe");
    } catch (e) {
      log(`[backfill] fatal (continuing to subscribe): ${e.message}`);
    }
    log(`Long-connection subscribe started via ${getLarkCliBin()}`);
    await new Promise((resolve) => {
      const args = [
        "event", "+subscribe",
        "--as", "bot",
        "--event-types", "im.message.receive_v1",
        "--quiet",
      ];
      if (LARK_CLI_EVENT_SUBSCRIBE_FORCE) args.push("--force");
      const child = spawnLarkCli(args, {
        cwd: process.cwd(),
        stdio: ["ignore", "pipe", "pipe"],
      });

      let buffer = "";
      let suspectSince = 0;
      const watchdog = setInterval(() => {
        if (!suspectSince) return;
        if (Date.now() - suspectSince < Math.min(LONG_WATCHDOG_MS, LONG_ERROR_RECONNECT_MS)) return;
        log("[long-conn] watchdog: subscribe reported a connection error but did not exit; killing to reconnect");
        clearInterval(watchdog);
        try { child.kill("SIGTERM"); } catch {}
      }, 5_000);
      child.stdout.on("data", (chunk) => {
        buffer += chunk.toString();
        let idx = buffer.indexOf("\n");
        while (idx >= 0) {
          const line = buffer.slice(0, idx).trim();
          buffer = buffer.slice(idx + 1);
          if (line) {
            suspectSince = 0;
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
        if (text) {
          log(`[long-conn] ${text}`);
          if (/websocket|disconnect|disconnected|closed|close|timeout|eof|error|failed/i.test(text)) {
            suspectSince ||= Date.now();
          }
        }
      });
      child.on("exit", (code, signal) => {
        clearInterval(watchdog);
        log(`Long-connection exited code=${code ?? "null"} signal=${signal ?? "null"}`);
        STATE.longConnAwaitingRecover = true;
        STATE.lastLongDisconnectAt = new Date().toISOString();
        persistState();
        resolve();
      });
      child.on("error", (e) => {
        clearInterval(watchdog);
        log(`Long-connection spawn error: ${e.message}.${larkCliWindowsHint()}`);
        resolve();
      });
    });
    await new Promise(r => setTimeout(r, LONG_RESTART_MS));
  }
}

function startCatchupPollInterval() {
  if (!CATCHUP_POLL_INTERVAL_MS || EVENT_MODE === "poll") return;
  const interval = Math.max(60_000, CATCHUP_POLL_INTERVAL_MS);
  log(`[catchup-poll] interval=${Math.round(interval / 1000)}s`);
  setInterval(async () => {
    try {
      await backfillMissedMessagesBeforeLongSubscribe("catchup_poll");
    } catch (e) {
      log(`[catchup-poll] error: ${e.message}`);
    }
  }, interval);
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
      const now = new Date().toISOString();
      const chatIds = chatIdsForFetch();
      if (!chatIds.length) throw new Error("poll mode: no chat id configured");

      for (const chatId of chatIds) {
        const msgs = fetchNewMessages(lastPollTime, chatId);
        for (const msg of msgs) {
          const msgId = msg.message_id || msg.id;
          if (!msgId) continue;
          if (PROCESSED_IDS.has(msgId)) continue;

          if (msg.sender?.sender_type === "app") {
            PROCESSED_IDS.add(msgId);
            bumpLongCatchupWatermark(msg);
            continue;
          }

          PROCESSED_IDS.add(msgId);
          bumpLongCatchupWatermark(msg);
          await processMessage(msg);
          STATE.lastHandledId = msgId;
        }
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
  if (!APP_TOKEN || !LEDGER_TABLE || !ACCOUNT_TABLE) {
    throw new Error(
      "missing required env: LARK_APP_TOKEN/LARK_LEDGER_TABLE/LARK_ACCOUNT_TABLE (or LARK_BOOKKEEPING_* aliases)"
    );
  }
  if (EVENT_MODE === "poll" && !chatIdsForFetch().length) {
    throw new Error("missing required env: LARK_CHAT_ID or LARK_BOOKKEEPING_CHAT_IDS (polling mode only). Use LARK_EVENT_MODE=long for bot auto-reply without a fixed chat ID.");
  }
  if (!getLlmApiKey()) {
    log("LLM key not set. Local shortcut formats still work, e.g. 晚餐，68，微信 / 余额宝转招行500; natural-language parsing requires SILICONFLOW_API_KEY, OPENAI_API_KEY, or LLM_API_KEY.");
  }

  MODEL = pickVoucherSafeRouterModel("理解用户说的一句话，识别是否在记账，提取金额和账户信息");
  log(`Daemon started. Chat: ${CHAT_ID || "(all chats)"}  Model: ${MODEL}  DryRun: ${DRY_RUN}  LarkCli: ${getLarkCliBin()}  ReplyAs: ${REPLY_AS}`);
  if (larkCliWindowsHint()) log(`Windows lark-cli note:${larkCliWindowsHint()}`);

  if (EVENT_MODE === "long") {
    log("Mode: long-connection");
    log("Long mode listens to bot message events and replies to the source chat. No LARK_CHAT_ID is required unless you want a chat allowlist.");
    startCatchupPollInterval();
    await startLongConnectionLoop();
    return;
  }

  if (EVENT_MODE === "webhook") {
    if (WEBHOOK_PORT <= 0) throw new Error("missing required env: LARK_WEBHOOK_PORT (webhook mode)");
    log("Mode: webhook");
    try {
      await backfillMissedMessagesBeforeLongSubscribe("webhook_startup");
    } catch (e) {
      log(`[backfill] webhook_startup error: ${e.message}`);
    }
    startWebhookServer();
    startCatchupPollInterval();
    return;
  }

  if (EVENT_MODE !== "poll") {
    throw new Error(`invalid LARK_EVENT_MODE: ${EVENT_MODE} (expected long, webhook, or poll)`);
  }

  log("Mode: polling");
  log(`Polling every ${POLL_MS / 1000}s from ${STATE.lastPollTime || new Date(Date.now() - 60_000).toISOString()}`);
  await pollLoop();
}

main().catch(e => {
  console.error("Fatal:", e.message);
  process.exit(1);
});
