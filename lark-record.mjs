#!/usr/bin/env node
/**
 * lark-record.mjs — AI-powered natural language bookkeeping via lark-cli
 *
 * Flow: NL input → SiliconFlow DeepSeek-V3 → lark-cli +record-upsert → IM confirmation
 *
 * Usage:
 *   node lark-record.mjs "晚餐68微信"
 *   node lark-record.mjs "工资8000招行"
 *   node lark-record.mjs "借给小明500人民币"
 *   node lark-record.mjs "微信转招行1000"
 *   node lark-record.mjs --balance              # show account balances
 *   node lark-record.mjs --monthly 2026-04      # monthly summary
 *   node lark-record.mjs --list-accounts        # list accounts + record_ids
 *   node lark-record.mjs --dry-run "晚餐68"     # parse only, no write
 *
 * Environment variables (see .env.example):
 *   LARK_APP_TOKEN, LARK_LEDGER_TABLE, LARK_ACCOUNT_TABLE,
 *   LARK_CHAT_ID, LARK_RECORD_SEND_IM, SILICONFLOW_API_KEY
 *
 * Exit codes: 0 ok, 1 parse/config error, 2 write error
 */

import { spawnSync } from "child_process";
import { readFileSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

// ─── Load .env if present ──────────────────────────────────────────────────────

const __dir = dirname(fileURLToPath(import.meta.url));

function loadEnv() {
  const envPath = resolve(__dir, ".env");
  if (!existsSync(envPath)) return;
  const lines = readFileSync(envPath, "utf8").split("\n");
  for (const line of lines) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
  }
}
loadEnv();

// ─── Config ───────────────────────────────────────────────────────────────────

const APP_TOKEN     = process.env.LARK_APP_TOKEN;
const LEDGER_TABLE  = process.env.LARK_LEDGER_TABLE;
const ACCOUNT_TABLE = process.env.LARK_ACCOUNT_TABLE;
const IM_CHAT_ID    = process.env.LARK_CHAT_ID;
const SEND_IM       = process.env.LARK_RECORD_SEND_IM !== "0";

const SILICONFLOW_API = "https://api.siliconflow.cn/v1/chat/completions";
const SILICONFLOW_KEY = process.env.SILICONFLOW_API_KEY;
const MODEL_FALLBACK  = "deepseek-ai/DeepSeek-V3";

// Optional: SiliconFlow model router (https://github.com/PUDAOCHEN031101/model-router-mcp)
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
    console.log(`[router] ${model} (${result["意图分析"]})`);
    return model;
  } catch (e) {
    console.warn(`[router] fallback to ${MODEL_FALLBACK}: ${e.message}`);
    return MODEL_FALLBACK;
  }
}

function requireEnv(...vars) {
  const missing = vars.filter(v => !process.env[v]);
  if (missing.length) {
    console.error(`[record] Missing required env vars: ${missing.join(", ")}`);
    console.error("  Copy .env.example to .env and fill in your values.");
    process.exit(1);
  }
}

// ─── Account mapping ──────────────────────────────────────────────────────────
// Loaded from config/accounts.json (copy config/accounts.example.json to start)
// Or run: node lark-record.mjs --list-accounts

function loadAccounts() {
  const paths = [
    resolve(__dir, "config/accounts.json"),
    resolve(__dir, "accounts.json"),
  ];
  for (const p of paths) {
    if (existsSync(p)) {
      try { return JSON.parse(readFileSync(p, "utf8")); } catch {}
    }
  }
  return {};
}

const ACCOUNTS = loadAccounts();

// ─── lark-cli helper ──────────────────────────────────────────────────────────

function lark(args, timeout = 30_000) {
  const r = spawnSync("lark-cli", args, {
    encoding: "utf8", maxBuffer: 10 * 1024 * 1024, timeout,
    env: { ...process.env },
  });
  if (r.error) throw new Error(`lark spawn: ${r.error.message}`);
  const out = (r.stdout || "").trim();
  const i = out.indexOf("{");
  if (i < 0) {
    const err = (r.stderr || "").trim();
    throw new Error(`no JSON: ${(err || out).slice(0, 300)}`);
  }
  return JSON.parse(out.slice(i));
}

// ─── AI parsing ───────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `你是个人记账助手，把用户的自然语言记账请求解析成 JSON。

## 账户列表（只能选这些，输出账户的中文名）
${Object.keys(ACCOUNTS).join(" / ") || "（请先配置 config/accounts.json）"}

## 交易类型
- 支出：买/花/消费/付
- 收入：工资/收到/到账/报销
- 转账：X转到Y / X打给Y
- 负债：借给/借出
- 还款：还款/还了/归还

## 支出分类
衣 / 食 / 住 / 行 / 娱 / 学 / 持续黑洞 / 其他支出

## 收入分类
工资 / 奖金补贴 / 报销返还 / 兼职劳务 / 投资利息 / 退款返现 / 他人转账 / 其他收入

## 日期规则
- 不说日期 → 不传
- 昨天/前天 → 传自然语言字符串，lark-cli 自动转
- 具体日期 → "2026-04-01 00:00:00"

## 输出格式（纯 JSON，禁止解释）
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
}`;

async function parseWithAI(input) {
  const model = routeModel("理解用户说的一句话，识别是否在记账，提取金额和账户信息");
  const resp = await fetch(SILICONFLOW_API, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${SILICONFLOW_KEY}` },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: input },
      ],
      temperature: 0.1,
      max_tokens: 300,
    }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!resp.ok) throw new Error(`AI HTTP ${resp.status}`);
  const data = await resp.json();
  const content = data?.choices?.[0]?.message?.content || "";
  const m = content.match(/\{[\s\S]*\}/);
  if (!m) throw new Error(`AI no JSON: ${content.slice(0, 200)}`);
  return JSON.parse(m[0]);
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

// ─── Build fields ─────────────────────────────────────────────────────────────

function buildFields(parsed) {
  const fields = {};
  fields["交易类型"] = parsed["交易类型"];
  fields["金额"] = Number(parsed["金额"]);
  if (parsed["备注"]) fields["备注"] = parsed["备注"];
  fields["日期"] = parsed["日期"] || (() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")} 00:00:00`;
  })();
  if (parsed["支出分类"]) fields["支出分类"] = parsed["支出分类"];
  if (parsed["收入分类"]) fields["收入分类"] = parsed["收入分类"];
  if (parsed["借贷方向"]) fields["借贷方向"] = parsed["借贷方向"];
  if (parsed["借款人"])   fields["借款人"]   = parsed["借款人"];
  for (const key of ["账户", "转出账户", "转入账户"]) {
    if (parsed[key]) {
      const rid = resolveAccount(parsed[key]);
      if (rid) fields[key] = [rid];
      else console.warn(`[record] unknown account: ${parsed[key]}`);
    }
  }
  return fields;
}

// ─── Feishu operations ────────────────────────────────────────────────────────

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

function sendIM(message) {
  if (!IM_CHAT_ID) return;
  try {
    lark(["im", "+messages-send", "--as", "user", "--chat-id", IM_CHAT_ID, "--text", message]);
  } catch (e) {
    console.warn(`[record] IM send failed (non-fatal): ${e.message}`);
  }
}

function showBalance() {
  requireEnv("LARK_APP_TOKEN", "LARK_ACCOUNT_TABLE");
  const r = lark(["base", "+record-list", "--base-token", APP_TOKEN, "--table-id", ACCOUNT_TABLE, "--limit", "50"]);
  const rows = r.data.data || [], fields = r.data.fields || [];
  const nameIdx = fields.indexOf("账户名称"), balIdx = fields.indexOf("当前余额");
  let total = 0;
  console.log("\n账户余额：");
  for (const row of rows) {
    const name = row[nameIdx], bal = parseFloat(row[balIdx] || "0");
    if (bal !== 0) { console.log(`  ${String(name).padEnd(20)} ¥${bal.toFixed(2)}`); total += bal; }
  }
  console.log(`  ${"合计".padEnd(20)} ¥${total.toFixed(2)}`);
}

function listAccounts() {
  requireEnv("LARK_APP_TOKEN", "LARK_ACCOUNT_TABLE");
  const r = lark(["base", "+record-list", "--base-token", APP_TOKEN, "--table-id", ACCOUNT_TABLE, "--limit", "100"]);
  const rows = r.data.data || [], fields = r.data.fields || [];
  const ids = r.data.record_id_list || [];
  const nameIdx = fields.indexOf("账户名称");
  console.log("\n账户映射（复制到 config/accounts.json）：\n{");
  rows.forEach((row, i) => {
    const name = row[nameIdx], id = ids[i];
    if (name && id) console.log(`  "${name}": "${id}",`);
  });
  console.log("}");
}

function listRecent(limit = 5) {
  requireEnv("LARK_APP_TOKEN", "LARK_LEDGER_TABLE");
  const r = lark([
    "base", "+record-list",
    "--base-token", APP_TOKEN,
    "--table-id", LEDGER_TABLE,
    "--limit", String(Math.max(1, Math.min(20, Number(limit) || 5))),
  ]);
  const ids = r.data.record_id_list || [];
  const rows = r.data.data || [];
  const names = r.data.fields || [];
  const idxType = names.indexOf("交易类型");
  const idxAmount = names.indexOf("金额");
  const idxNote = names.indexOf("备注");
  const idxDate = names.indexOf("日期");
  console.log("\n最近记录：");
  rows.forEach((row, i) => {
    console.log(`${ids[i]} | ${row[idxType] || ""} | ¥${Number(row[idxAmount] || 0).toFixed(2)} | ${row[idxNote] || "-"} | ${row[idxDate] || "-"}`);
  });
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);

  if (args.includes("--balance"))       { requireEnv("LARK_APP_TOKEN", "LARK_ACCOUNT_TABLE"); showBalance(); return; }
  if (args.includes("--list-accounts")) { listAccounts(); return; }
  const listIdx = args.indexOf("--list");
  if (listIdx !== -1) { listRecent(args[listIdx + 1] || 5); return; }
  const delIdx = args.indexOf("--delete");
  if (delIdx !== -1) {
    requireEnv("LARK_APP_TOKEN", "LARK_LEDGER_TABLE");
    const id = args[delIdx + 1];
    if (!id) { console.error("Usage: --delete <record_id>"); process.exit(1); }
    deleteRecord(id);
    console.log(`✅ Deleted: ${id}`);
    return;
  }
  const updIdx = args.indexOf("--update");
  if (updIdx !== -1) {
    requireEnv("LARK_APP_TOKEN", "LARK_LEDGER_TABLE");
    const id = args[updIdx + 1];
    const setIdx = args.indexOf("--set");
    const kvRaw = setIdx !== -1 ? args[setIdx + 1] : "";
    if (!id || !kvRaw) { console.error("Usage: --update <record_id> --set 金额=88,备注=午饭,分类=食"); process.exit(1); }
    const kv = {};
    for (const pair of kvRaw.split(",")) {
      const i = pair.indexOf("=");
      if (i <= 0) continue;
      kv[pair.slice(0, i)] = pair.slice(i + 1);
    }
    const fields = {};
    if (kv["金额"]) fields["金额"] = Number(kv["金额"]);
    if (kv["备注"]) fields["备注"] = kv["备注"];
    if (kv["日期"]) fields["日期"] = kv["日期"];
    if (kv["交易类型"]) fields["交易类型"] = kv["交易类型"];
    if (kv["分类"]) fields["支出分类"] = kv["分类"];
    if (kv["支出分类"]) fields["支出分类"] = kv["支出分类"];
    if (kv["收入分类"]) fields["收入分类"] = kv["收入分类"];
    if (kv["账户"]) {
      const rid = resolveAccount(kv["账户"]);
      if (rid) fields["账户"] = [rid];
    }
    if (!Object.keys(fields).length) { console.error("No valid update fields"); process.exit(1); }
    updateRecord(id, fields);
    console.log(`✅ Updated: ${id} (${Object.keys(fields).join(", ")})`);
    return;
  }

  const monthIdx = args.indexOf("--monthly");
  if (monthIdx !== -1) {
    const month = args[monthIdx+1] || new Date().toISOString().slice(0,7);
    console.log(`月度汇总 ${month}: 请在飞书多维表格中查看月度视图`);
    return;
  }

  requireEnv("LARK_APP_TOKEN", "LARK_LEDGER_TABLE", "SILICONFLOW_API_KEY");

  const dryRun = args.includes("--dry-run");
  const input  = args.filter(a => !a.startsWith("--")).join(" ").trim();

  if (!input) {
    console.error('Usage: lark-record.mjs "晚餐68微信" | "工资8000招行" | "借给小明500"');
    process.exit(1);
  }

  console.log(`[record] Parsing: "${input}"`);
  const parsed = await parseWithAI(input).catch(e => { console.error(`[record] Parse failed: ${e.message}`); process.exit(1); });
  console.log("[record] Parsed:", JSON.stringify(parsed, null, 2));

  if (!parsed["金额"] || !parsed["交易类型"]) {
    console.error("[record] Missing required fields");
    process.exit(1);
  }

  const fields = buildFields(parsed);

  if (dryRun) { console.log("[dry-run] Would write:", JSON.stringify(fields, null, 2)); return; }

  const result = writeRecord(fields);
  if (!result.ok && result.code !== 0) { console.error(`[record] Write failed: ${result.msg}`); process.exit(2); }

  const recId = extractRecordId(result);
  console.log(`[record] ✅ Written: ${recId}`);

  const { 交易类型: type, 金额: amt, 账户: acct, 支出分类: cat1, 收入分类: cat2, 备注: note } = parsed;
  let msg = `✅ 已记账\nID: ${recId}\n类型: ${type}  金额: ¥${amt}`;
  if (acct)       msg += `  账户: ${acct}`;
  if (cat1||cat2) msg += `  分类: ${cat1||cat2}`;
  if (note)       msg += `\n备注: ${note}`;
  console.log(msg);
  if (SEND_IM) sendIM(msg);
}

main().catch(e => { console.error("[record] Fatal:", e.message); process.exit(1); });
