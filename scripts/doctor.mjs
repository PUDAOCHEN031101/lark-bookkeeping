#!/usr/bin/env node

import { existsSync } from "fs";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";
import { readEnvFile } from "./lib/local-env.mjs";
import { runLarkCliJson, spawnLarkCliSync } from "./lib/lark-cli-local.mjs";

const __dir = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dir, "..");
const ENV_PATH = resolve(ROOT, ".env");
const MIN_NODE = 18;
const MIN_LARK_CLI = "1.0.19";

const checks = [];

function add(status, name, detail = "") {
  checks.push({ status, name, detail });
  const mark = status === "ok" ? "OK" : status === "warn" ? "WARN" : "FAIL";
  console.log(`[${mark}] ${name}${detail ? ` - ${detail}` : ""}`);
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

function extractRows(result, keys) {
  const candidates = [
    result?.data?.items,
    result?.data?.tables,
    result?.data?.data,
    result?.data,
    result?.items,
    result?.tables,
  ];
  for (const item of candidates) {
    if (Array.isArray(item)) return item;
  }
  for (const key of keys) {
    const value = result?.data?.[key] || result?.[key];
    if (Array.isArray(value)) return value;
  }
  return [];
}

function tableId(row) {
  return row.table_id || row.tableId || row.id || "";
}

function hasLlmKey(env) {
  return Boolean(env.SILICONFLOW_API_KEY || env.OPENAI_API_KEY || env.LLM_API_KEY);
}

async function checkLlm(env) {
  if (!process.argv.includes("--llm")) {
    add("warn", "LLM API", "已配置 key；如需联网验证，运行 npm run doctor -- --llm");
    return;
  }
  const chatUrl =
    env.BOOKKEEPING_LLM_CHAT_URL
    || (env.OPENAI_BASE_URL ? `${env.OPENAI_BASE_URL.replace(/\/$/, "")}/chat/completions` : "")
    || "https://api.siliconflow.cn/v1/chat/completions";
  const key = env.SILICONFLOW_API_KEY || env.OPENAI_API_KEY || env.LLM_API_KEY;
  const model = env.BOOKKEEPING_LLM_MODEL || env.LARK_LLM_MODEL || "deepseek-ai/DeepSeek-V3";
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    const res = await fetch(chatUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: "ping" }],
        max_tokens: 1,
      }),
      signal: controller.signal,
    });
    if (res.ok) add("ok", "LLM API", "联网验证通过");
    else add("fail", "LLM API", `HTTP ${res.status}`);
  } catch (e) {
    add("fail", "LLM API", e.message);
  } finally {
    clearTimeout(timeout);
  }
}

async function main() {
  console.log("lark-bookkeeping doctor\n");

  const nodeMajor = Number(process.versions.node.split(".")[0]);
  add(nodeMajor >= MIN_NODE ? "ok" : "fail", "Node.js", process.version);

  const versionResult = spawnLarkCliSync(["--version"], { encoding: "utf8", timeout: 10_000 });
  if (versionResult.error) {
    add("fail", "lark-cli", "未安装；运行 npm install -g @larksuite/cli@latest");
  } else {
    const version = parseVersion(versionResult.stdout || versionResult.stderr);
    add(
      version && compareVersions(version, MIN_LARK_CLI) >= 0 ? "ok" : "warn",
      "lark-cli",
      `${version || "unknown"}；建议最新版 @larksuite/cli@latest`,
    );
  }

  let authOk = false;
  const auth = spawnLarkCliSync(["auth", "status"], { encoding: "utf8", timeout: 10_000 });
  if (auth.error || auth.status !== 0) {
    add("fail", "Feishu auth", "未登录；运行 lark-cli auth login");
  } else {
    try {
      const status = JSON.parse(auth.stdout || "{}");
      authOk = status.tokenStatus === "valid";
      add(authOk ? "ok" : "fail", "Feishu auth", status.userName || status.tokenStatus || "unknown");
    } catch {
      add("fail", "Feishu auth", "无法解析 auth status");
    }
  }

  if (!existsSync(ENV_PATH)) {
    add("fail", ".env", "不存在；运行 npm run setup");
    process.exit(1);
  }
  add("ok", ".env", ENV_PATH);
  const env = readEnvFile(ENV_PATH);

  for (const key of ["LARK_APP_TOKEN", "LARK_LEDGER_TABLE", "LARK_ACCOUNT_TABLE"]) {
    add(env[key] ? "ok" : "fail", key, env[key] ? "已配置" : "缺失");
  }

  add(
    hasLlmKey(env) ? "ok" : "warn",
    "LLM key",
    hasLlmKey(env)
      ? "已配置"
      : "未配置；快捷格式仍可用，自由自然语言解析需要 SILICONFLOW_API_KEY / OPENAI_API_KEY / LLM_API_KEY",
  );
  if (hasLlmKey(env)) await checkLlm(env);

  const mode = (env.LARK_EVENT_MODE || "long").toLowerCase();
  add(["poll", "long", "webhook"].includes(mode) ? "ok" : "warn", "LARK_EVENT_MODE", mode);
  if (mode === "long") {
    add("ok", "bot auto-reply", "不需要 LARK_CHAT_ID；机器人收到消息后回复原会话");
    add("warn", "long mode", "需要 bot 权限、事件订阅、机器人入群，并避免多实例订阅");
  }
  if (mode === "poll") {
    add(env.LARK_CHAT_ID ? "ok" : "fail", "LARK_CHAT_ID", env.LARK_CHAT_ID ? "poll 模式已配置" : "poll 模式必填");
  }
  if (mode === "webhook") {
    add(env.LARK_WEBHOOK_PORT ? "ok" : "fail", "LARK_WEBHOOK_PORT", env.LARK_WEBHOOK_PORT ? "已配置" : "webhook 模式必填");
  }

  if (process.platform === "win32") {
    if (env.LARK_CLI_BIN) {
      add("ok", "LARK_CLI_BIN", env.LARK_CLI_BIN);
    } else {
      add("warn", "LARK_CLI_BIN", "未设置；默认使用 lark-cli.cmd，遇到 ENOENT 时可指向 lark-cli.exe");
    }
  }

  if (authOk && env.LARK_APP_TOKEN) {
    try {
      const tables = runLarkCliJson(["base", "+table-list", "--base-token", env.LARK_APP_TOKEN, "--limit", "100"], { timeout: 30_000 });
      const ids = new Set(extractRows(tables, ["items", "tables"]).map(tableId).filter(Boolean));
      add(ids.has(env.LARK_LEDGER_TABLE) ? "ok" : "fail", "ledger table access", env.LARK_LEDGER_TABLE);
      add(ids.has(env.LARK_ACCOUNT_TABLE) ? "ok" : "fail", "account table access", env.LARK_ACCOUNT_TABLE);
    } catch (e) {
      add("fail", "base access", e.message);
    }
  }

  console.log("");
  const failed = checks.filter(x => x.status === "fail").length;
  const warned = checks.filter(x => x.status === "warn").length;
  if (failed) {
    console.log(`Result: ${failed} failed, ${warned} warning(s).`);
    process.exit(1);
  }
  console.log(`Result: OK${warned ? ` with ${warned} warning(s)` : ""}.`);
}

main().catch((e) => {
  console.error(`[FAIL] doctor crashed - ${e.message}`);
  process.exit(1);
});
