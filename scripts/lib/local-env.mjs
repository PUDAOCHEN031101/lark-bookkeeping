import { existsSync, readFileSync, writeFileSync } from "fs";

export function parseEnvText(text) {
  const env = {};
  const clean = String(text || "").replace(/^\uFEFF/, "");
  for (const rawLine of clean.split(/\r?\n/)) {
    const line = rawLine.replace(/\r$/, "");
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m) env[m[1]] = m[2].trim();
  }
  return env;
}

export function readEnvFile(envPath) {
  if (!existsSync(envPath)) return {};
  return parseEnvText(readFileSync(envPath, "utf8"));
}

export function formatEnvFile(values, { header = "" } = {}) {
  const lines = [];
  if (header) {
    lines.push(...String(header).trimEnd().split(/\r?\n/), "");
  }
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined || value === null || value === "") continue;
    lines.push(`${key}=${String(value)}`);
  }
  return `${lines.join("\n")}\n`;
}

export function writeEnvFile(envPath, values, options = {}) {
  writeFileSync(envPath, formatEnvFile(values, options), "utf8");
}

export function loadEnvFile(envPath) {
  if (!existsSync(envPath)) return;
  for (const [key, value] of Object.entries(readEnvFile(envPath))) {
    if (!process.env[key]) process.env[key] = value;
  }
}
