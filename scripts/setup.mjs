#!/usr/bin/env node

import { spawnSync } from "child_process";
import { existsSync } from "fs";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";
import { createInterface } from "readline/promises";
import { stdin as input, stdout as output } from "process";
import { readEnvFile, writeEnvFile } from "./lib/local-env.mjs";
import { runLarkCliJson, spawnLarkCliSync } from "./lib/lark-cli-local.mjs";

const __dir = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dir, "..");
const ENV_PATH = resolve(ROOT, ".env");
const MIN_LARK_CLI = "1.0.19";

const rl = createInterface({ input, output });

function log(message = "") {
  console.log(message);
}

function fail(message) {
  console.error(`\n[setup] ${message}`);
  process.exit(1);
}

async function ask(question, defaultValue = "") {
  const suffix = defaultValue ? ` (${defaultValue})` : "";
  const answer = (await rl.question(`${question}${suffix}: `)).trim();
  return answer || defaultValue;
}

async function askYesNo(question, defaultYes = true) {
  const suffix = defaultYes ? "Y/n" : "y/N";
  const answer = (await rl.question(`${question} [${suffix}]: `)).trim().toLowerCase();
  if (!answer) return defaultYes;
  return ["y", "yes", "是", "好"].includes(answer);
}

function run(bin, args, options = {}) {
  return spawnSync(bin, args, {
    cwd: ROOT,
    encoding: "utf8",
    windowsHide: true,
    shell: process.platform === "win32" && /\.(cmd|bat)$/i.test(bin),
    ...options,
  });
}

function parseVersion(text) {
  const m = String(text || "").match(/(\d+\.\d+\.\d+)/);
  return m ? m[1] : "";
}

function compareVersions(a, b) {
  const pa = String(a).split(".").map(n => Number(n) || 0);
  const pb = String(b).split(".").map(n => Number(n) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] || 0) - (pb[i] || 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

function npmBin() {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}

function installLatestLarkCli() {
  log("\nInstalling latest @larksuite/cli...");
  const r = run(npmBin(), ["install", "-g", "@larksuite/cli@latest"], { stdio: "inherit" });
  if (r.error || r.status !== 0) {
    fail("lark-cli install failed. Please run: npm install -g @larksuite/cli@latest");
  }
}

async function ensureLarkCli() {
  let r = spawnLarkCliSync(["--version"], { encoding: "utf8", timeout: 10_000 });
  if (r.error) {
    if (await askYesNo("未检测到 lark-cli，是否现在安装最新版？", true)) {
      installLatestLarkCli();
      r = spawnLarkCliSync(["--version"], { encoding: "utf8", timeout: 10_000 });
    }
  }
  if (r.error) fail("仍未检测到 lark-cli。请先执行: npm install -g @larksuite/cli@latest");

  const version = parseVersion(r.stdout || r.stderr);
  log(`lark-cli: ${version || "unknown"}`);
  if (!version || compareVersions(version, MIN_LARK_CLI) < 0) {
    if (await askYesNo(`检测到 lark-cli 版本低于 ${MIN_LARK_CLI}，是否升级到最新版？`, true)) {
      installLatestLarkCli();
    }
  }
}

async function ensureAuth() {
  const r = spawnLarkCliSync(["auth", "status"], { encoding: "utf8", timeout: 10_000 });
  let ok = false;
  try {
    const status = JSON.parse(r.stdout || "{}");
    ok = status.tokenStatus === "valid";
    if (ok) log(`飞书登录: ${status.userName || status.userOpenId || "已登录"}`);
  } catch {}

  if (ok) return;
  log("\n需要先登录飞书。浏览器会打开/显示设备码，请按提示完成授权。");
  const login = spawnLarkCliSync(["auth", "login"], { cwd: ROOT, stdio: "inherit", timeout: 120_000 });
  if (login.error || login.status !== 0) {
    fail("飞书登录失败。请手动运行: lark-cli auth login");
  }
}

function parseBaseUrl(value) {
  const token = String(value || "").match(/\/base\/([^/?#]+)/)?.[1] || "";
  const table = String(value || "").match(/[?&]table=([^&#]+)/)?.[1] || "";
  return { token, table };
}

function extractRows(result, keys) {
  const candidates = [
    result?.data?.items,
    result?.data?.tables,
    result?.data?.data,
    result?.data,
    result?.items,
    result?.tables,
    result?.data,
  ];
  for (const item of candidates) {
    if (Array.isArray(item)) return item;
  }
  if (keys.length) {
    for (const key of keys) {
      const value = result?.data?.[key] || result?.[key];
      if (Array.isArray(value)) return value;
    }
  }
  return [];
}

function normalizeTable(row) {
  return {
    id: row.table_id || row.tableId || row.id || row.tableIdStr || "",
    name: row.name || row.table_name || row.tableName || "",
  };
}

function normalizeChat(row) {
  return {
    id: row.chat_id || row.chatId || row.id || "",
    name: row.name || row.chat_name || row.chatName || row.avatar?.name || "",
  };
}

function pickByName(items, names) {
  const wanted = names.map(s => s.toLowerCase());
  return items.find(item => wanted.includes(String(item.name || "").toLowerCase()))
    || items.find(item => wanted.some(name => String(item.name || "").toLowerCase().includes(name)));
}

async function chooseItem(label, items, currentId = "") {
  if (!items.length) return await ask(`${label} ID`, currentId);
  log("");
  for (let i = 0; i < items.length; i++) {
    log(`${i + 1}. ${items[i].name || "(unnamed)"}  ${items[i].id}`);
  }
  const answer = await ask(`选择${label}序号，或直接粘贴 ID`, currentId ? currentId : "1");
  const idx = Number(answer);
  if (Number.isInteger(idx) && idx >= 1 && idx <= items.length) return items[idx - 1].id;
  return answer;
}

async function configureBase(env) {
  log("\n=== 多维表格 ===");
  const currentUrl = env.LARK_APP_TOKEN ? `https://xxx.feishu.cn/base/${env.LARK_APP_TOKEN}` : "";
  const baseInput = await ask("粘贴你复制后的多维表格 URL，或直接输入 APP_TOKEN", currentUrl);
  const parsed = parseBaseUrl(baseInput);
  const appToken = parsed.token || baseInput.trim();
  if (!appToken) fail("缺少 LARK_APP_TOKEN。");

  let tables = [];
  try {
    const result = runLarkCliJson(["base", "+table-list", "--base-token", appToken, "--limit", "100"], { timeout: 30_000 });
    tables = extractRows(result, ["items", "tables"]).map(normalizeTable).filter(x => x.id);
  } catch (e) {
    log(`[warn] 读取表列表失败：${e.message}`);
  }

  const ledger = pickByName(tables, ["收支明细", "ledger", "流水", "记账"]);
  const account = pickByName(tables, ["账户", "account", "accounts"]);

  env.LARK_APP_TOKEN = appToken;
  env.LARK_LEDGER_TABLE = ledger?.id || parsed.table || await chooseItem("收支明细表", tables, env.LARK_LEDGER_TABLE || "");
  env.LARK_ACCOUNT_TABLE = account?.id || await chooseItem("账户表", tables, env.LARK_ACCOUNT_TABLE || "");
  log(`收支明细表: ${env.LARK_LEDGER_TABLE}`);
  log(`账户表: ${env.LARK_ACCOUNT_TABLE}`);
}

async function configureChat(env) {
  log("\n=== 记账群 ===");
  const existing = env.LARK_CHAT_ID || env.LARK_BOOKKEEPING_CHAT_ID || "";
  const query = await ask("输入群名关键词；如果已知道 chat_id，可直接粘贴 oc_xxx", existing);
  if (query.startsWith("oc_")) {
    env.LARK_CHAT_ID = query;
    return;
  }

  let chats = [];
  try {
    const result = runLarkCliJson(["im", "+chat-search", "--query", query, "--page-size", "10"], { timeout: 30_000 });
    chats = extractRows(result, ["items", "chats"]).map(normalizeChat).filter(x => x.id);
  } catch (e) {
    log(`[warn] 搜索群聊失败：${e.message}`);
  }

  env.LARK_CHAT_ID = await chooseItem("记账群", chats, existing);
}

async function configureEventMode(env) {
  log("\n=== 消息接入方式 ===");
  log("1. 机器人自动响应（推荐）：不需要群 ID，机器人收到消息就回复原会话");
  log("2. 轮询兼容模式：需要群 ID，适合无法配置机器人事件时排障");
  log("3. Webhook：需要公网回调地址，适合服务器部署");
  const current = (env.LARK_EVENT_MODE || "long").toLowerCase();
  const defaultChoice = current === "poll" ? "2" : current === "webhook" ? "3" : "1";
  const choice = await ask("选择接入方式", defaultChoice);

  if (choice === "2" || choice.toLowerCase() === "poll") {
    env.LARK_EVENT_MODE = "poll";
    await configureChat(env);
    return;
  }

  if (choice === "3" || choice.toLowerCase() === "webhook") {
    env.LARK_EVENT_MODE = "webhook";
    env.LARK_WEBHOOK_PORT = await ask("Webhook 本地端口", env.LARK_WEBHOOK_PORT || "9326");
    env.LARK_WEBHOOK_HOST = await ask("Webhook 监听地址", env.LARK_WEBHOOK_HOST || "0.0.0.0");
    delete env.LARK_CHAT_ID;
    delete env.LARK_BOOKKEEPING_CHAT_ID;
    return;
  }

  env.LARK_EVENT_MODE = "long";
  if (env.LARK_CHAT_ID || env.LARK_BOOKKEEPING_CHAT_ID) {
    const keep = await askYesNo("检测到旧的聊天 ID。是否把它作为聊天白名单保留？", false);
    if (!keep) {
      delete env.LARK_CHAT_ID;
      delete env.LARK_BOOKKEEPING_CHAT_ID;
    }
  }
}

async function configureLlm(env) {
  log("\n=== LLM ===");
  log("LLM Key 用于自由自然语言解析；如果只用「晚餐，68，微信」这类快捷格式，可以先跳过。");
  log("1. SiliconFlow（推荐）");
  log("2. OpenAI 官方");
  log("3. 其他 OpenAI-compatible 网关");
  log("4. 跳过，稍后手动配置");
  const choice = await ask("选择 LLM 提供商", env.OPENAI_API_KEY ? "2" : env.LLM_API_KEY ? "3" : "1");
  if (choice === "4") return;

  if (choice === "2") {
    env.OPENAI_BASE_URL = await ask("OPENAI_BASE_URL", env.OPENAI_BASE_URL || "https://api.openai.com/v1");
    env.OPENAI_API_KEY = await ask("OPENAI_API_KEY", env.OPENAI_API_KEY || "");
    delete env.SILICONFLOW_API_KEY;
    delete env.LLM_API_KEY;
    delete env.BOOKKEEPING_LLM_CHAT_URL;
    return;
  }

  if (choice === "3") {
    env.BOOKKEEPING_LLM_CHAT_URL = await ask("兼容接口 chat/completions URL", env.BOOKKEEPING_LLM_CHAT_URL || "");
    env.LLM_API_KEY = await ask("LLM_API_KEY", env.LLM_API_KEY || "");
    delete env.SILICONFLOW_API_KEY;
    delete env.OPENAI_API_KEY;
    return;
  }

  env.SILICONFLOW_API_KEY = await ask("SILICONFLOW_API_KEY", env.SILICONFLOW_API_KEY || "");
  delete env.OPENAI_API_KEY;
  delete env.LLM_API_KEY;
  delete env.BOOKKEEPING_LLM_CHAT_URL;
}

function applyDefaults(env) {
  env.LARK_EVENT_MODE ||= "long";
  env.LARK_REPLY_AS ||= "auto";
  env.LARK_RECORD_SEND_IM ||= "1";
}

function writeEnv(env) {
  const ordered = {
    LARK_APP_TOKEN: env.LARK_APP_TOKEN,
    LARK_LEDGER_TABLE: env.LARK_LEDGER_TABLE,
    LARK_ACCOUNT_TABLE: env.LARK_ACCOUNT_TABLE,
    LARK_CHAT_ID: env.LARK_CHAT_ID,
    LARK_EVENT_MODE: env.LARK_EVENT_MODE,
    LARK_REPLY_AS: env.LARK_REPLY_AS,
    LARK_RECORD_SEND_IM: env.LARK_RECORD_SEND_IM,
    SILICONFLOW_API_KEY: env.SILICONFLOW_API_KEY,
    OPENAI_BASE_URL: env.OPENAI_BASE_URL,
    OPENAI_API_KEY: env.OPENAI_API_KEY,
    BOOKKEEPING_LLM_CHAT_URL: env.BOOKKEEPING_LLM_CHAT_URL,
    LLM_API_KEY: env.LLM_API_KEY,
    ...Object.fromEntries(Object.entries(env).filter(([key]) => ![
      "LARK_APP_TOKEN",
      "LARK_LEDGER_TABLE",
      "LARK_ACCOUNT_TABLE",
      "LARK_CHAT_ID",
      "LARK_EVENT_MODE",
      "LARK_REPLY_AS",
      "LARK_RECORD_SEND_IM",
      "SILICONFLOW_API_KEY",
      "OPENAI_BASE_URL",
      "OPENAI_API_KEY",
      "BOOKKEEPING_LLM_CHAT_URL",
      "LLM_API_KEY",
    ].includes(key))),
  };
  writeEnvFile(ENV_PATH, ordered, {
    header: "# Generated by node scripts/setup.mjs\n# You can edit this file manually.",
  });
}

async function main() {
  log("lark-bookkeeping setup");
  log("这个向导会生成 .env。默认走机器人自动响应，不需要手动填写群 ID。");
  if (existsSync(ENV_PATH)) log(`已检测到现有 .env，会在保留未知配置的基础上更新。`);

  await ensureLarkCli();
  await ensureAuth();

  const env = readEnvFile(ENV_PATH);
  await configureBase(env);
  await configureEventMode(env);
  await configureLlm(env);
  applyDefaults(env);
  writeEnv(env);

  log(`\n已写入 ${ENV_PATH}`);
  log("建议现在运行: npm run doctor");
  if (await askYesNo("是否现在运行 doctor 检查？", true)) {
    const r = run(process.execPath, [resolve(ROOT, "scripts/doctor.mjs")], { stdio: "inherit" });
    if (r.status !== 0) process.exit(r.status || 1);
  }
  log("\n启动命令: npm start");
}

main()
  .catch((e) => fail(e.message))
  .finally(() => rl.close());
