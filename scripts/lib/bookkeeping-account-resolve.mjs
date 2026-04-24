/**
 * 记账账户名解析：最长键优先模糊匹配，避免短账户名误匹配长名称子串。
 */

/**
 * @param {string} normalizedName
 * @param {Record<string, string>} accounts name → record_id
 * @returns {string | null}
 */
export function fuzzyMatchAccountRecordId(normalizedName, accounts) {
  const n0 = String(normalizedName || "").trim();
  if (!n0 || !accounts || typeof accounts !== "object") return null;
  if (Object.prototype.hasOwnProperty.call(accounts, n0)) return accounts[n0];
  const keys = Object.keys(accounts).sort((a, b) => b.length - a.length);
  for (const k of keys) {
    const v = accounts[k];
    if (n0.includes(k) || k.includes(n0)) return v;
  }
  return null;
}

/**
 * @param {string} n0
 * @param {Record<string, string>} accounts
 * @returns {string}
 */
export function pickCanonicalAccountKey(n0, accounts) {
  const n = String(n0 || "").trim();
  if (!n || !accounts || typeof accounts !== "object") return n;
  if (Object.prototype.hasOwnProperty.call(accounts, n)) return n;
  const keys = Object.keys(accounts).sort((a, b) => b.length - a.length);
  for (const k of keys) {
    if (n.includes(k) || k.includes(n)) return k;
  }
  return n;
}

/**
 * 用户原文已写「零钱通」「社保卡」，但模型误写「账户」时按原文纠正。
 * @param {Record<string, unknown>} parsed
 * @param {string} userText
 */
export function reconcileParsedAccountFromUserText(parsed, userText) {
  if (!parsed || typeof parsed !== "object") return;
  const t = String(userText || "");
  if (/零钱通/.test(t)) {
    const ac = typeof parsed["账户"] === "string" ? parsed["账户"].trim() : "";
    if (!/零钱通/.test(ac)) parsed["账户"] = "零钱通";
  }
  if (/社保卡/.test(t)) {
    const ac = typeof parsed["账户"] === "string" ? parsed["账户"].trim() : "";
    if (!/(社保卡|中国银行社保卡)/.test(ac)) parsed["账户"] = "中国银行社保卡";
  }
  const acFinal = typeof parsed["账户"] === "string" ? parsed["账户"].trim() : "";
  if (acFinal === "微信零钱" || acFinal === "微信零钱通") parsed["账户"] = "零钱通";
}
