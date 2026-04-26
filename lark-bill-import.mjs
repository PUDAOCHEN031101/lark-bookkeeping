#!/usr/bin/env node
/**
 * lark-bill-import.mjs — 支付宝/微信账单 CSV 批量导入飞书多维表格
 *
 * Usage:
 *   node lark-bill-import.mjs --file ~/Downloads/alipay.csv --type alipay
 *   node lark-bill-import.mjs --file ~/Downloads/wechat.csv --type wxpay
 *   node lark-bill-import.mjs --file xxx.csv --type alipay --dry-run
 *   node lark-bill-import.mjs --file xxx.csv --type alipay --month 2026-04
 *
 * Environment variables: LARK_APP_TOKEN, LARK_LEDGER_TABLE (see .env.example)
 * Exit: 0=ok, 1=error
 */

import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { homedir } from "os";
import { loadEnvFile } from "./scripts/lib/local-env.mjs";
import { runLarkCliJson } from "./scripts/lib/lark-cli-local.mjs";

const __dir = dirname(fileURLToPath(import.meta.url));

function loadEnv() {
  loadEnvFile(resolve(__dir, ".env"));
}
loadEnv();

const APP_TOKEN    = process.env.LARK_APP_TOKEN;
const LEDGER_TABLE = process.env.LARK_LEDGER_TABLE;

// ─── lark-cli helper ──────────────────────────────────────────────────────────

function lark(args, timeout = 60_000) {
  return runLarkCliJson(args, { timeout });
}

// ─── Category mapping ─────────────────────────────────────────────────────────

const CATEGORY_MAP = {
  "餐饮美食": "食", "超市便利": "食", "生鲜果蔬": "食", "外卖": "食",
  "服饰装扮": "衣", "美容美发": "衣",
  "住房物业": "住", "水电煤": "住", "租房": "住",
  "交通出行": "行", "网约车": "行", "公共交通": "行",
  "教育培训": "学", "图书": "学",
  "休闲娱乐": "娱", "游戏": "娱", "运动健身": "娱",
};

function mapCategory(raw) {
  if (!raw) return "其他支出";
  return CATEGORY_MAP[raw.trim()] || "其他支出";
}

// ─── CSV helpers ──────────────────────────────────────────────────────────────

function parseCSVLine(line) {
  const result = []; let cur = "", inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') { if (inQuote && line[i+1] === '"') { cur += '"'; i++; } else inQuote = !inQuote; }
    else if (ch === "," && !inQuote) { result.push(cur.trim()); cur = ""; }
    else cur += ch;
  }
  result.push(cur.trim()); return result;
}

function findHeaderIndex(lines) {
  for (let i = 0; i < lines.length; i++) if (lines[i].includes("交易时间")) return i;
  throw new Error("CSV 中未找到'交易时间' header 行");
}

function parseAmount(raw) { return parseFloat(String(raw).replace(/[¥,\s]/g, "")) || 0; }

// ─── Alipay parser ────────────────────────────────────────────────────────────

function parseAlipay(lines) {
  const hIdx = findHeaderIndex(lines), headers = parseCSVLine(lines[hIdx]);
  const [iTime, iCat, iCounterpart, iGoods, iDir, iAmount, iTradeNo, iRemark] =
    ["交易时间","交易分类","交易对方","商品说明","收/支","金额(元)","交易单号","备注"].map(h => headers.indexOf(h));
  const records = [];
  for (let i = hIdx+1; i < lines.length; i++) {
    const cols = parseCSVLine(lines[i].trim());
    if (cols.length < 8) continue;
    const dir = (cols[iDir]||"").trim();
    if (dir !== "支出" && dir !== "收入") continue;
    const tradeNo = (cols[iTradeNo]||"").trim(), amount = parseAmount(cols[iAmount]);
    if (!tradeNo || amount <= 0) continue;
    const note = [[cols[iCounterpart], cols[iGoods], cols[iRemark]].filter(Boolean).join(" "), `[alipay:${tradeNo}]`].join(" ").trim();
    records.push({ datetime: (cols[iTime]||"").trim(), amount, direction: dir, tradeType: "日常消费", category: dir === "支出" ? mapCategory(cols[iCat]) : null, note, tradeNo });
  }
  return records;
}

// ─── WeChat parser ────────────────────────────────────────────────────────────

function parseWxpay(lines) {
  const hIdx = findHeaderIndex(lines), headers = parseCSVLine(lines[hIdx]);
  const [iTime, iType, iCounterpart, iGoods, iDir, iAmount, iTradeNo, iRemark] =
    ["交易时间","交易类型","交易对方","商品","收/支","金额(元)","交易单号","备注"].map(h => headers.indexOf(h));
  const records = [];
  for (let i = hIdx+1; i < lines.length; i++) {
    const cols = parseCSVLine(lines[i].trim());
    if (cols.length < 8) continue;
    const dir = (cols[iDir]||"").trim();
    if (dir !== "支出" && dir !== "收入") continue;
    const txType = (cols[iType]||"").trim();
    if (txType === "转账" || txType === "微信红包") continue;
    const tradeNo = (cols[iTradeNo]||"").trim(), amount = parseAmount(cols[iAmount]);
    if (!tradeNo || amount <= 0) continue;
    const noteBase = [cols[iCounterpart], cols[iGoods], cols[iRemark]].filter(s => s && s !== "/").join(" ");
    records.push({ datetime: (cols[iTime]||"").trim(), amount, direction: dir, tradeType: "日常消费", category: dir === "支出" ? mapCategory(txType) : null, note: `${noteBase} [wxpay:${tradeNo}]`.trim(), tradeNo });
  }
  return records;
}

// ─── Dedup ────────────────────────────────────────────────────────────────────

function readExistingTradeNos() {
  console.log("[bill-import] 读取已有记录（去重）...");
  try {
    const r = lark(["base", "+record-list", "--base-token", APP_TOKEN, "--table-id", LEDGER_TABLE, "--limit", "200"]);
    if (!r.ok) return new Set();
    const rows = r.data.data || [], fields = r.data.fields || [];
    const iNote = fields.indexOf("备注");
    const existing = new Set();
    for (const row of rows) { const m = String(row[iNote]||"").match(/\[(alipay|wxpay):([^\]]+)\]/); if (m) existing.add(m[2]); }
    console.log(`[bill-import] 已有去重单号: ${existing.size} 条`);
    return existing;
  } catch (e) { console.warn(`[bill-import] 读取失败，跳过去重: ${e.message}`); return new Set(); }
}

// ─── Write ────────────────────────────────────────────────────────────────────

function writeRecord(rec) {
  const fields = { "日期": rec.datetime, "金额": rec.amount, "借贷方向": rec.direction, "交易类型": rec.tradeType, "备注": rec.note };
  if (rec.direction === "支出" && rec.category) fields["支出分类"] = rec.category;
  return lark(["base", "+record-upsert", "--base-token", APP_TOKEN, "--table-id", LEDGER_TABLE, "--json", JSON.stringify(fields)]);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  if (!APP_TOKEN || !LEDGER_TABLE) { console.error("[bill-import] Missing LARK_APP_TOKEN or LARK_LEDGER_TABLE"); process.exit(1); }
  const argv = process.argv.slice(2);
  const dryRun = argv.includes("--dry-run");
  const getArg = flag => { const i = argv.indexOf(flag); return i !== -1 ? argv[i+1] : null; };
  const fileArg = getArg("--file"), typeArg = getArg("--type"), monthArg = getArg("--month");

  if (!fileArg) { console.error("[bill-import] 缺少 --file"); process.exit(1); }
  if (!["alipay","wxpay"].includes(typeArg)) { console.error("[bill-import] --type 必须为 alipay 或 wxpay"); process.exit(1); }

  const filePath = fileArg.startsWith("~") ? resolve(homedir(), fileArg.slice(2)) : resolve(fileArg);
  const lines = readFileSync(filePath, "utf8").replace(/\r\n/g,"\n").replace(/\r/g,"\n").split("\n");
  let parsed = typeArg === "alipay" ? parseAlipay(lines) : parseWxpay(lines);
  if (monthArg) parsed = parsed.filter(r => r.datetime.startsWith(monthArg));

  const existing = readExistingTradeNos();
  const toImport = parsed.filter(r => !existing.has(r.tradeNo));
  console.log(`[bill-import] 解析: ${parsed.length} 条有效，已存在 ${parsed.length - toImport.length} 条，待导入 ${toImport.length} 条`);
  if (toImport.length === 0) { console.log("[bill-import] 无新记录"); return; }

  if (dryRun) {
    toImport.slice(0,3).forEach((r,i) => console.log(`  [${i+1}] ${r.datetime} | ${r.direction} | ¥${r.amount} | ${r.note}`));
    console.log(`[bill-import] [DRY RUN] 共 ${toImport.length} 条`); return;
  }

  let success = 0, failed = 0;
  for (let i = 0; i < toImport.length; i++) {
    process.stdout.write(`\r[bill-import] ${"█".repeat(Math.round(i/toImport.length*20))}${"░".repeat(20-Math.round(i/toImport.length*20))} ${i}/${toImport.length}`);
    try { const r = writeRecord(toImport[i]); (r.ok||r.code===0) ? success++ : (failed++, console.error(`\n  失败 [${i+1}]: ${r.msg}`)); }
    catch (e) { failed++; console.error(`\n  异常 [${i+1}]: ${e.message}`); }
  }
  process.stdout.write(`\r[bill-import] ${"█".repeat(20)} ${toImport.length}/${toImport.length}\n`);
  console.log(`[bill-import] ${failed===0?"✅":"⚠️ "} 成功 ${success} 条，失败 ${failed} 条`);
  if (failed > 0) process.exit(1);
}

main().catch(e => { console.error("[bill-import] Fatal:", e.message); process.exit(1); });
