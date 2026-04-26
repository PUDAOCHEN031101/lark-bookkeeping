import { spawn, spawnSync } from "child_process";
import { existsSync, rmSync, writeFileSync } from "fs";
import { join } from "path";

const JSON_FILE_FLAGS = new Set(["--json", "--fields", "--params", "--data"]);

export function getLarkCliBin() {
  if (process.env.LARK_CLI_BIN) return process.env.LARK_CLI_BIN;
  return process.platform === "win32" ? "lark-cli.cmd" : "lark-cli";
}

export function isWindowsCmdShim(bin = getLarkCliBin()) {
  return process.platform === "win32" && /\.(cmd|bat)$/i.test(bin);
}

export function larkCliWindowsHint() {
  if (!isWindowsCmdShim()) return "";
  return " Using a .cmd/.bat lark-cli shim; if Windows shell issues persist, point LARK_CLI_BIN to lark-cli.exe.";
}

function withLarkCliSpawnDefaults(options = {}) {
  const { env, ...rest } = options;
  return {
    windowsHide: true,
    shell: isWindowsCmdShim(),
    ...rest,
    env: { ...process.env, ...(env || {}) },
  };
}

function materializeJsonArgs(args, cwd = process.cwd()) {
  const cleanup = [];
  const out = [...args];
  for (let i = 0; i < out.length - 1; i++) {
    if (!JSON_FILE_FLAGS.has(out[i])) continue;
    const value = out[i + 1];
    if (typeof value !== "string") continue;
    const text = value.trim();
    if (!text || text.startsWith("@")) continue;
    if (!text.startsWith("{") && !text.startsWith("[")) continue;
    const name = `.lark-bookkeeping-json-${process.pid}-${Date.now()}-${i}.json`;
    const abs = join(cwd, name);
    writeFileSync(abs, value, { encoding: "utf8" });
    cleanup.push(abs);
    out[i + 1] = `@./${name}`;
  }
  return { args: out, cleanup };
}

function cleanupJsonArgs(paths) {
  for (const p of paths) {
    try {
      if (existsSync(p)) rmSync(p, { force: true });
    } catch {}
  }
}

export function spawnLarkCliSync(args, options = {}) {
  const cwd = options.cwd || process.cwd();
  const prepared = materializeJsonArgs(args, cwd);
  try {
    return spawnSync(getLarkCliBin(), prepared.args, withLarkCliSpawnDefaults({ ...options, cwd }));
  } finally {
    cleanupJsonArgs(prepared.cleanup);
  }
}

export function spawnLarkCli(args, options = {}) {
  return spawn(getLarkCliBin(), args, withLarkCliSpawnDefaults(options));
}

export function parseLarkCliJsonResult(result) {
  if (result.error) {
    throw new Error(`lark spawn (${getLarkCliBin()}): ${result.error.message}.${larkCliWindowsHint()}`);
  }
  const out = (result.stdout || "").trim();
  const i = out.indexOf("{");
  if (i < 0) {
    const err = (result.stderr || "").trim();
    const msg = (err || out || `exit ${result.status ?? "unknown"}`).slice(0, 500);
    throw new Error(`no JSON from lark-cli: ${msg}${larkCliWindowsHint()}`);
  }
  return JSON.parse(out.slice(i));
}

export function runLarkCliJson(args, options = {}) {
  const result = spawnLarkCliSync(args, {
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
    timeout: 30_000,
    ...options,
  });
  return parseLarkCliJsonResult(result);
}
