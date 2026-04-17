/**
 * 记账 LLM 调用：OpenAI 兼容任意端点 + 可选 Function Calling 结构化输出。
 *
 * 环境变量（择一即可）：
 * - BOOKKEEPING_LLM_CHAT_URL：完整 URL，如 https://api.siliconflow.cn/v1/chat/completions
 * - OPENAI_BASE_URL：如 https://api.openai.com/v1，会自动拼 /chat/completions
 * 密钥：SILICONFLOW_API_KEY | OPENAI_API_KEY | LLM_API_KEY
 *
 * BOOKKEEPING_PARSE_STRUCTURED=0 关闭工具调用，仅用正文 JSON（兼容旧模型）。
 */

import { parseAiJsonFromContent } from "./bookkeeping-multi.mjs";

/** @returns {string} */
export function getLlmChatUrl() {
  const full =
    process.env.BOOKKEEPING_LLM_CHAT_URL ||
    process.env.OPENAI_COMPAT_CHAT_COMPLETIONS_URL ||
    "";
  if (full) return full.replace(/\s+/g, "");
  const base = process.env.OPENAI_BASE_URL || "";
  if (base) {
    const b = String(base).trim().replace(/\/+$/, "");
    return `${b}/chat/completions`;
  }
  return "https://api.siliconflow.cn/v1/chat/completions";
}

/** @returns {string} */
export function getLlmApiKey() {
  return (
    process.env.SILICONFLOW_API_KEY ||
    process.env.OPENAI_API_KEY ||
    process.env.LLM_API_KEY ||
    ""
  );
}

const SUBMIT_TOOL = {
  type: "function",
  function: {
    name: "submit_bookkeeping_result",
    description:
      "提交记账解析结果。查余额用 command；闲聊非记账用 not_bookkeeping；否则用 entries（一笔或多笔）。",
    parameters: {
      type: "object",
      properties: {
        command: {
          type: "string",
          enum: ["balance", "monthly"],
          description: "仅查余额或月报时填写；普通记账不要带此项",
        },
        not_bookkeeping: {
          type: "boolean",
          description: "用户只是在聊天、无关内容时为 true",
        },
        entries: {
          type: "array",
          description: "一条或多条交易；多笔时数组长度>=2",
          items: {
            type: "object",
            properties: {
              交易类型: { type: "string" },
              金额: { type: "number" },
              账户: { type: "string" },
              转出账户: { type: "string" },
              转入账户: { type: "string" },
              支出分类: { type: "string" },
              收入分类: { type: "string" },
              借贷方向: { type: "string" },
              借款人: { type: "string" },
              备注: { type: "string" },
              日期: { type: "string" },
            },
            required: ["交易类型", "金额"],
          },
        },
      },
    },
  },
};

/**
 * 将 tool arguments 转为与 parseAiJsonFromContent / entriesFromAiJson 兼容的顶层对象
 */
export function normalizeStructuredToolArgs(raw) {
  if (!raw || typeof raw !== "object") return null;
  const cmd = raw.command;
  if (cmd === "balance" || cmd === "monthly") return { command: cmd };
  if (raw.not_bookkeeping === true) return { not_bookkeeping: true };

  const entries = raw.entries;
  if (Array.isArray(entries) && entries.length >= 2) {
    return { 多笔: entries };
  }
  if (Array.isArray(entries) && entries.length === 1) {
    return entries[0];
  }
  return null;
}

async function fetchLegacyJson({
  chatUrl,
  apiKey,
  model,
  systemPrompt,
  userText,
  signal,
  maxTokens = 2_000,
}) {
  const resp = await fetch(chatUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userText },
      ],
      temperature: 0.1,
      max_tokens: maxTokens,
    }),
    signal,
  });
  if (!resp.ok) {
    const t = await resp.text().catch(() => "");
    throw new Error(`AI HTTP ${resp.status} ${t.slice(0, 200)}`);
  }
  const data = await resp.json();
  const content = data?.choices?.[0]?.message?.content || "";
  return parseAiJsonFromContent(content);
}

async function fetchStructuredTool({
  chatUrl,
  apiKey,
  model,
  systemPrompt,
  userText,
  signal,
  maxTokens = 2_000,
}) {
  const sys =
    systemPrompt +
    "\n\n你必须且只能通过调用函数 submit_bookkeeping_result 返回结果，不要在正文中输出 JSON。";
  const resp = await fetch(chatUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: sys },
        { role: "user", content: userText },
      ],
      tools: [SUBMIT_TOOL],
      tool_choice: {
        type: "function",
        function: { name: "submit_bookkeeping_result" },
      },
      temperature: 0.1,
      max_tokens: maxTokens,
    }),
    signal,
  });
  if (!resp.ok) {
    const t = await resp.text().catch(() => "");
    throw new Error(`AI HTTP ${resp.status} ${t.slice(0, 200)}`);
  }
  const data = await resp.json();
  const msg = data?.choices?.[0]?.message;
  const tc = msg?.tool_calls?.[0];
  if (tc?.function?.name === "submit_bookkeeping_result") {
    let args = {};
    try {
      args = JSON.parse(tc.function.arguments || "{}");
    } catch {
      throw new Error("tool arguments JSON parse failed");
    }
    const norm = normalizeStructuredToolArgs(args);
    if (norm != null) return norm;
  }
  if (msg?.content) {
    return parseAiJsonFromContent(msg.content);
  }
  throw new Error("structured: no tool_calls and no content");
}

/**
 * @param {object} opts
 * @param {string} opts.chatUrl
 * @param {string} opts.apiKey
 * @param {string} opts.model
 * @param {string} opts.systemPrompt
 * @param {string} opts.userText
 * @param {AbortSignal} [opts.signal]
 * @param {boolean} [opts.structured] 默认读 env BOOKKEEPING_PARSE_STRUCTURED !== "0"
 * @param {(s:string)=>void} [opts.onLog]
 * @returns {Promise<object>}
 */
export async function parseBookkeepingWithLLM(opts) {
  const {
    chatUrl,
    apiKey,
    model,
    systemPrompt,
    userText,
    signal,
    structured = process.env.BOOKKEEPING_PARSE_STRUCTURED !== "0",
    onLog = () => {},
    maxTokens = 2_000,
  } = opts;

  if (!apiKey) throw new Error("missing API key (SILICONFLOW_API_KEY / OPENAI_API_KEY / LLM_API_KEY)");

  if (structured) {
    try {
      return await fetchStructuredTool({
        chatUrl,
        apiKey,
        model,
        systemPrompt,
        userText,
        signal,
        maxTokens,
      });
    } catch (e) {
      onLog(`[bookkeeping] structured parse failed, fallback legacy: ${e.message}`);
    }
  }

  return fetchLegacyJson({
    chatUrl,
    apiKey,
    model,
    systemPrompt,
    userText,
    signal,
    maxTokens,
  });
}
