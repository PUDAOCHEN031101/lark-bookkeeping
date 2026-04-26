#!/usr/bin/env node

import { join } from "path";
import { loadEnvFile } from "../lib/local-env.mjs";
import { runLarkCliJson } from "../lib/lark-cli-local.mjs";

const LINK_FIELDS = new Set(["账户", "转入账户", "转出账户"]);

function usage() {
  return `Usage:
  node scripts/admin/replace-linked-account.mjs --ids rec1,rec2 --field 账户 --to-name 零钱通 [--dry-run]
  node scripts/admin/replace-linked-account.mjs --from-name 旧账户 --to-name 新账户 --field 账户 [--dry-run]

Options:
  --ids        Comma-separated ledger record IDs to update directly.
  --field      Link field to update: 账户, 转入账户, 转出账户. Default: 账户.
  --from       Source account record_id for scan mode.
  --from-name  Source account name for scan mode.
  --to         Target account record_id.
  --to-name    Target account name.
  --limit      Max ledger rows to scan. Default: 500.
  --dry-run    Print changes without writing.
`;
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const item = argv[i];
    if (!item.startsWith("--")) throw new Error(`unexpected argument: ${item}`);
    const key = item.slice(2);
    if (key === "dry-run" || key === "help" || key === "h") {
      args[key] = true;
      continue;
    }
    const value = argv[i + 1];
    if (!value || value.startsWith("--")) throw new Error(`missing value for --${key}`);
    args[key] = value;
    i++;
  }
  return args;
}

function pickEnv(...keys) {
  for (const key of keys) {
    const value = process.env[key];
    if (value) return value;
  }
  return "";
}

function requireConfig() {
  const appToken = pickEnv("LARK_APP_TOKEN", "LARK_BOOKKEEPING_APP_TOKEN");
  const ledgerTable = pickEnv("LARK_LEDGER_TABLE", "LARK_BOOKKEEPING_LEDGER_TABLE");
  const accountTable = pickEnv("LARK_ACCOUNT_TABLE", "LARK_BOOKKEEPING_ACCOUNT_TABLE");
  const missing = [];
  if (!appToken) missing.push("LARK_APP_TOKEN");
  if (!ledgerTable) missing.push("LARK_LEDGER_TABLE");
  if (!accountTable) missing.push("LARK_ACCOUNT_TABLE");
  if (missing.length) throw new Error(`missing env: ${missing.join(", ")}`);
  return { appToken, ledgerTable, accountTable };
}

function isRecordId(value) {
  return /^rec[a-zA-Z0-9]+$/.test(String(value || "").trim());
}

function recordList({ appToken, tableId, limit }) {
  const result = runLarkCliJson([
    "base", "+record-list",
    "--base-token", appToken,
    "--table-id", tableId,
    "--limit", String(limit),
  ]);
  if (result?.ok === false) throw new Error(result?.msg || "record-list failed");
  return {
    fields: result?.data?.fields || [],
    rows: result?.data?.data || [],
    recordIds: result?.data?.record_id_list || [],
  };
}

function updateRecord({ appToken, tableId, recordId, fields }) {
  const result = runLarkCliJson([
    "base", "+record-update",
    "--base-token", appToken,
    "--table-id", tableId,
    "--record-id", recordId,
    "--fields", JSON.stringify(fields),
  ]);
  if (result?.ok === false) throw new Error(result?.msg || `record-update failed: ${recordId}`);
  return result;
}

function buildAccountNameMap(config) {
  if (config.accountNameMap) return config.accountNameMap;
  const { fields, rows, recordIds } = recordList({
    appToken: config.appToken,
    tableId: config.accountTable,
    limit: 500,
  });
  const nameIndex = fields.indexOf("账户名称");
  if (nameIndex < 0) throw new Error("account table field not found: 账户名称");

  const map = new Map();
  for (let i = 0; i < rows.length; i++) {
    const name = String(rows[i]?.[nameIndex] || "").trim();
    const recordId = recordIds[i];
    if (!name || !recordId) continue;
    if (!map.has(name)) map.set(name, []);
    map.get(name).push(recordId);
  }
  config.accountNameMap = map;
  return map;
}

function resolveAccountRef(config, { id, name, flag }) {
  if (id) {
    const trimmed = String(id).trim();
    if (!isRecordId(trimmed)) throw new Error(`${flag} must look like a Lark record_id: ${trimmed}`);
    return { recordId: trimmed, label: trimmed };
  }
  const accountName = String(name || "").trim();
  if (!accountName) throw new Error(`missing ${flag} or ${flag}-name`);

  const matches = buildAccountNameMap(config).get(accountName) || [];
  if (matches.length === 0) throw new Error(`account not found by 账户名称: ${accountName}`);
  if (matches.length > 1) {
    throw new Error(`account name is ambiguous: ${accountName} -> ${matches.join(", ")}`);
  }
  return { recordId: matches[0], label: `${accountName} (${matches[0]})` };
}

function extractLinkedRecordIds(cell) {
  if (cell === null || cell === undefined || cell === "") return [];
  if (typeof cell === "string") return isRecordId(cell) ? [cell] : [];
  if (!Array.isArray(cell)) {
    if (typeof cell === "object") {
      const id = cell.record_id || cell.recordId || cell.id;
      return isRecordId(id) ? [String(id)] : [];
    }
    return [];
  }

  const ids = [];
  for (const item of cell) {
    if (typeof item === "string" && isRecordId(item)) ids.push(item);
    if (item && typeof item === "object") {
      const id = item.record_id || item.recordId || item.id;
      if (isRecordId(id)) ids.push(String(id));
    }
  }
  return ids;
}

function replaceId(ids, fromRecordId, toRecordId) {
  const out = ids.map((id) => (id === fromRecordId ? toRecordId : id));
  return [...new Set(out)];
}

function parseIds(value) {
  return String(value || "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
}

function validateArgs(args) {
  if (args.help || args.h) {
    console.log(usage());
    process.exit(0);
  }

  const field = args.field || "账户";
  if (!LINK_FIELDS.has(field)) {
    throw new Error(`--field must be one of: ${[...LINK_FIELDS].join(", ")}`);
  }
  if (!args.to && !args["to-name"]) throw new Error("missing --to or --to-name");

  const ids = parseIds(args.ids);
  const hasIdsMode = ids.length > 0;
  const hasScanMode = Boolean(args.from || args["from-name"]);
  if (hasIdsMode === hasScanMode) {
    throw new Error("choose exactly one mode: --ids ... or --from/--from-name ...");
  }
  for (const id of ids) {
    if (!isRecordId(id)) throw new Error(`invalid ledger record_id in --ids: ${id}`);
  }
  return { field, ids, limit: Number(args.limit || 500) };
}

function printPlannedChanges(changes, { dryRun }) {
  const verb = dryRun ? "would update" : "updated";
  console.log(`[replace-linked-account] ${verb}: ${changes.length}`);
  for (const change of changes) {
    const before = change.before?.length ? change.before.join(",") : "(unknown)";
    console.log(`- ${change.recordId}: ${change.field} ${before} -> ${change.after.join(",")}`);
  }
}

async function main() {
  loadEnvFile(join(process.cwd(), ".env"));

  const args = parseArgs(process.argv.slice(2));
  const { field, ids, limit } = validateArgs(args);
  if (!Number.isInteger(limit) || limit <= 0) throw new Error("--limit must be a positive integer");

  const config = requireConfig();
  const dryRun = Boolean(args["dry-run"]);
  const to = resolveAccountRef(config, { id: args.to, name: args["to-name"], flag: "--to" });

  console.log(`[replace-linked-account] field=${field}`);
  console.log(`[replace-linked-account] to=${to.label}`);
  if (dryRun) console.log("[replace-linked-account] dry-run: no writes");

  if (ids.length) {
    const changes = ids.map((recordId) => ({
      recordId,
      field,
      before: [],
      after: [to.recordId],
    }));
    if (dryRun) {
      printPlannedChanges(changes, { dryRun });
    } else {
      for (const change of changes) {
        updateRecord({
          appToken: config.appToken,
          tableId: config.ledgerTable,
          recordId: change.recordId,
          fields: { [field]: change.after },
        });
      }
      printPlannedChanges(changes, { dryRun });
    }
    return;
  }

  const from = resolveAccountRef(config, { id: args.from, name: args["from-name"], flag: "--from" });
  console.log(`[replace-linked-account] from=${from.label}`);

  const { fields, rows, recordIds } = recordList({
    appToken: config.appToken,
    tableId: config.ledgerTable,
    limit,
  });
  const fieldIndex = fields.indexOf(field);
  if (fieldIndex < 0) throw new Error(`ledger table field not found: ${field}`);

  const changes = [];
  for (let i = 0; i < rows.length; i++) {
    const before = extractLinkedRecordIds(rows[i]?.[fieldIndex]);
    if (!before.includes(from.recordId)) continue;
    const after = replaceId(before, from.recordId, to.recordId);
    changes.push({ recordId: recordIds[i], field, before, after });
  }

  if (dryRun) {
    printPlannedChanges(changes, { dryRun });
  } else {
    for (const change of changes) {
      updateRecord({
        appToken: config.appToken,
        tableId: config.ledgerTable,
        recordId: change.recordId,
        fields: { [field]: change.after },
      });
    }
    printPlannedChanges(changes, { dryRun });
  }
}

main().catch((error) => {
  console.error(`[replace-linked-account] ${error.message}`);
  process.exit(1);
});
