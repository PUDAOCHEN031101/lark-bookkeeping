/**
 * Local fast parser for common bookkeeping text.
 *
 * These formats avoid an LLM call:
 *   备注，金额，账户
 *   日期，备注，金额，账户
 *   备注，分类食，金额，账户
 *   余额宝转招行500 / 余额宝->招行，500 / 转账，余额宝到招行，500
 */

/** Strip common punctuation/noise around a chat line. */
export function normalizeBookkeepingLine(input) {
  let text = String(input || "").trim();
  const edge =
    /^[\s\u00A0\u3000\u00B7\u2022\u2026\u22EF\uFE19⋯…·.|｜\\/]+|[\s\u00A0\u3000\u00B7\u2022\u2026\u22EF\uFE19⋯…·.|｜\\/]+$/gu;
  let previous;
  do {
    previous = text;
    text = text.replace(edge, "").trim();
  } while (text !== previous);
  return text;
}

function normalizeWidth(input) {
  const text = String(input || "");
  return typeof text.normalize === "function" ? text.normalize("NFKC") : text;
}

function inferExpenseCategoryFromNote(note) {
  const text = String(note || "");
  if (/公交|地铁|出租|滴滴|打车|高铁|火车|机票|骑行|加油|停车|高速|ETC/i.test(text)) return "行";
  if (
    /餐|饭|面|米|面包|奶茶|咖啡|饮|零食|吃|美团|饿了么|外卖|果|蔬|肉|鱼|鸡|鸭|牛|美式|拿铁|拉面|饼|煎饼|肉夹馍|苹果|香蕉|橙|葡萄|草莓|芒果|西瓜|黄瓜|生菜|白菜|土豆|瑞幸|星巴克|库迪|早饭|午饭|晚饭|早餐|午餐|晚餐/i.test(
      text
    )
  ) {
    return "食";
  }
  if (/衣|鞋|服|裤|裙|袜|帽|包|美发|美容/i.test(text)) return "衣";
  if (/房租|水电|物业|卫生|纸巾|洗衣液|牙膏|洗浴|家具|家电/i.test(text)) return "住";
  if (/电影|游戏|视频|会员|KTV|演唱会|旅游|门票/i.test(text)) return "娱";
  if (/课程|培训|学费|考试费|教程|补课|报名费|文具|笔|本子|纸张|打印/i.test(text)) return "学";
  return "其他支出";
}

function inferIncomeCategoryFromNote(note) {
  const text = String(note || "");
  if (/工资|薪水|薪资|月薪|底薪|发薪/i.test(text)) return "工资";
  if (/年终奖|绩效奖|季度奖|项目奖|奖金|津贴|补贴/i.test(text)) return "奖金补贴";
  if (/报销/i.test(text)) return "报销返还";
  if (/兼职|稿费|劳务|外包/i.test(text)) return "兼职劳务";
  if (/利息|分红|理财/i.test(text)) return "投资利息";
  if (/返利|返现|返点|退款|退费|退回|返还(?!码)|淘宝联盟|京粉/i.test(text)) return "退款返现";
  if (/转给我|他人转|朋友还|还我钱|借还|收款/i.test(text)) return "他人转账";
  return "其他收入";
}

function noteLooksLikeIncome(note) {
  return /返利|返现|返点|退款|退费|退回|返还(?!码)|报销|工资|薪水|薪资|月薪|底薪|发薪|年终奖|绩效奖|季度奖|项目奖|奖金|津贴|补贴|兼职|稿费|劳务|外包|利息|分红|理财|淘宝联盟|京粉|转给我|他人转|朋友还|还我钱|借还|收款/i.test(
    String(note || "")
  );
}

function blankEntry() {
  return {
    交易类型: "",
    金额: 0,
    账户: "",
    转出账户: "",
    转入账户: "",
    支出分类: "",
    收入分类: "",
    借贷方向: "",
    借款人: "",
    备注: "",
    日期: "",
  };
}

function parseDateToken(raw) {
  const text = String(raw || "").trim();
  if (!text) return "";
  let m = text.match(/^(\d{2})(\d{2})(\d{2})$/);
  if (m) return `20${m[1]}-${m[2]}-${m[3]} 00:00:00`;
  m = text.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (m) return `${m[1]}-${m[2]}-${m[3]} 00:00:00`;
  m = text.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/);
  if (m) {
    return `${m[1]}-${String(m[2]).padStart(2, "0")}-${String(m[3]).padStart(2, "0")} 00:00:00`;
  }
  return "";
}

function entryForIncome({ amount, account, note, date = "" }) {
  return {
    ...blankEntry(),
    交易类型: "收入",
    金额: amount,
    账户: account,
    收入分类: inferIncomeCategoryFromNote(note),
    备注: note,
    日期: date,
  };
}

function entryForExpense({ amount, account, note, category = "", date = "" }) {
  return {
    ...blankEntry(),
    交易类型: "支出",
    金额: amount,
    账户: account,
    支出分类: category || inferExpenseCategoryFromNote(note),
    备注: note,
    日期: date,
  };
}

/**
 * Parse one "备注，金额，账户" style line.
 */
export function parseCommaTripleBookkeeping(input) {
  const raw = normalizeBookkeepingLine(input);
  const text = normalizeWidth(raw);
  if (!text || /[\n\r]/.test(text)) return null;

  const parts = text.split(/[,，、]/u).map((part) => normalizeBookkeepingLine(part)).filter(Boolean);
  if (parts.length !== 3 && parts.length !== 4) return null;

  let date = "";
  let note = "";
  let category = "";
  let amountRaw = "";
  let account = "";

  if (parts.length === 4) {
    const explicitCategory = parts[1].match(/^分类\s*(衣|食|住|行|娱|学|持续黑洞|其他支出|收入)$/u);
    if (explicitCategory) {
      note = parts[0];
      category = explicitCategory[1];
      amountRaw = parts[2];
      account = parts[3];
    } else {
      date = parseDateToken(parts[0]);
      if (!date) return null;
      note = parts[1];
      amountRaw = parts[2];
      account = parts[3];
    }
  } else {
    note = parts[0];
    amountRaw = parts[1];
    account = parts[2];
  }

  if (!note || !account || note.length > 120 || account.length > 48) return null;
  const amount = Number(amountRaw);
  if (!Number.isFinite(amount) || amount < 0) return null;

  const noteProbe = normalizeWidth(note);
  if (noteLooksLikeIncome(noteProbe) || category === "收入") {
    return entryForIncome({ amount, account, note, date });
  }
  return entryForExpense({ amount, account, note, category, date });
}

/**
 * Parse common transfer text:
 *   A转B500
 *   A转B，500
 *   A->B500 / A→B500
 *   转账，A到B，500
 *   转账500A到B
 */
export function parseTransferBookkeeping(input) {
  const raw = normalizeBookkeepingLine(input);
  const text = normalizeWidth(raw);
  if (!text || /[\n\r]/.test(text)) return null;

  const account = "[\\u4e00-\\u9fffA-Za-z0-9_()（）+\\-]{1,48}?";
  const amount = "([0-9]+(?:\\.[0-9]{1,2})?)";
  const patterns = [
    new RegExp(`^转账[,，、\\s]+(${account})(?:到|->|→|➜)(${account})[,，、\\s]+${amount}$`, "u"),
    new RegExp(`^(${account})(?:->|→|➜)(${account})[,，、\\s]*${amount}$`, "u"),
    new RegExp(`^(${account})转(?:到)?(${account})[,，、\\s]*${amount}$`, "u"),
    new RegExp(`^转账${amount}(${account})(?:到|->|→|➜)(${account})$`, "u"),
  ];

  let from = "";
  let to = "";
  let amountRaw = "";
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (!match) continue;
    if (pattern === patterns[3]) {
      amountRaw = match[1];
      from = match[2];
      to = match[3];
    } else {
      from = match[1];
      to = match[2];
      amountRaw = match[3];
    }
    break;
  }

  if (!from || !to || !amountRaw) return null;
  const parsedAmount = Number(amountRaw);
  if (!Number.isFinite(parsedAmount) || parsedAmount <= 0) return null;

  return {
    ...blankEntry(),
    交易类型: "转账",
    金额: parsedAmount,
    转出账户: normalizeBookkeepingLine(from),
    转入账户: normalizeBookkeepingLine(to),
    备注: "转账",
  };
}

export function parseFastBookkeepingLines(input) {
  const lines = String(input || "")
    .split(/\r?\n/u)
    .map((line) => normalizeBookkeepingLine(line))
    .filter(Boolean);
  if (!lines.length) return [];

  const entries = [];
  for (const line of lines) {
    const parsed = parseTransferBookkeeping(line) || parseCommaTripleBookkeeping(line);
    if (!parsed) return [];
    entries.push(parsed);
  }
  return entries;
}
