/**
 * 多笔记账：把模型返回的 JSON 规范成「若干条可写入表」的记录。
 * 支持：单对象、{ "多笔": [...] }、{ "entries": [...] }、顶层 JSON 数组。
 */

/** 拼在 system prompt 末尾，说明多笔输出格式 */
export const BOOKKEEPING_MULTI_INSTRUCTIONS = `

## 多笔交易（一条消息可含多笔）
用户可能用**多行**或**一段话**描述多笔，例如：
- 多行："午饭25微信\\n奶茶18微信"
- 一句："午饭25和奶茶18都是微信付的"

若有 **2 笔及以上** 独立交易，输出：
{ "多笔": [ { 单笔字段 }, { 单笔字段 } ] }

每笔对象的字段与单笔相同（交易类型、金额、账户、转出账户、转入账户、支出分类、收入分类、借贷方向、借款人、备注、日期等）。
只有 **1 笔** 时，直接输出单笔 JSON 对象，不要包 "多笔"。
顶层 JSON 数组 [{...},{...}] 也可表示多笔。

查余额等仍为 {"command":"balance"}；完全不是记账为 {"not_bookkeeping":true}。
`;

function validEntry(e) {
  return (
    e &&
    typeof e === "object" &&
    !Array.isArray(e) &&
    e["交易类型"] &&
    e["金额"] != null &&
    !Number.isNaN(Number(e["金额"]))
  );
}

/**
 * @param {unknown} parsed - parseAiJsonFromContent 的返回值
 * @returns {object[]} 每条为单笔记账字段对象
 */
export function entriesFromAiJson(parsed) {
  if (parsed == null) return [];

  if (Array.isArray(parsed)) {
    return parsed.filter(validEntry);
  }

  if (typeof parsed !== "object") return [];

  const batch = parsed["多笔"] ?? parsed["entries"] ?? parsed["records"];
  if (Array.isArray(batch) && batch.length > 0) {
    const ok = batch.filter(validEntry);
    if (ok.length) return ok;
  }

  if (parsed.not_bookkeeping || parsed.command) return [];

  if (validEntry(parsed)) return [parsed];
  return [];
}

/**
 * 从模型原文中提取 JSON（支持代码块、顶层数组、嵌套对象）。
 */
export function parseAiJsonFromContent(content) {
  if (!content || typeof content !== "string") throw new Error("AI empty");

  let s = content.trim();
  s = s.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();

  try {
    return JSON.parse(s);
  } catch {
    /* fall through */
  }

  const lead = s.search(/[\[{]/);
  if (lead === -1) throw new Error(`AI no JSON: ${s.slice(0, 200)}`);

  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = lead; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') {
      inStr = true;
      continue;
    }
    if (c === "{" || c === "[") depth++;
    else if (c === "}" || c === "]") {
      depth--;
      if (depth === 0) {
        const slice = s.slice(lead, i + 1);
        try {
          return JSON.parse(slice);
        } catch (e) {
          throw new Error(`AI bad JSON: ${e.message} — ${slice.slice(0, 240)}`);
        }
      }
    }
  }

  throw new Error(`AI no JSON: ${s.slice(0, 200)}`);
}
