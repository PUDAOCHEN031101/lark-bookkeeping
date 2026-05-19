/**
 * 「备注，金额，账户」单行快捷解析（中英文逗号、顿号），供 daemon 与 lark-record 共用，
 * 避免只走 LLM 时把「返利」记成支出。
 */

/** 去掉飞书/输入法里常见的首尾装饰点、省略号、竖线引用、空白 */
export function normalizeBookkeepingLine(s) {
  let t = String(s || "").trim();
  const edge =
    /^[\s\u00A0\u3000\u00B7\u2022\u2026\u22EF\uFE19⋯…·.|｜\\/]+|[\s\u00A0\u3000\u00B7\u2022\u2026\u22EF\uFE19⋯…·.|｜\\/]+$/gu;
  let prev;
  do {
    prev = t;
    t = t.replace(edge, "").trim();
  } while (t !== prev);
  return t;
}

/** 根据备注粗分支出分类（与飞书枚举一致）；仅用于快捷格式 */
function inferExpenseCategoryFromNote(note) {
  const n = String(note || "");
  if (/公交|地铁|出租|滴滴|快跑|打车|大巴|巴士|客车|高铁|火车|机票|船|骑行|加油|停车|高速|ETC|运费|快递|物流/i.test(n)) return "行";
  if (
    /餐|饭|面|米|面包|奶茶|咖啡|饮|零食|吃|美团|饿了么|外卖|果|蔬|肉|鱼|鸡|鸭|牛|美式|拿铁|拉面|饼|煎饼|卷饼|肉夹馍|西红柿|番茄|菠萝|苹果|香蕉|橙|橘|葡萄|草莓|蓝莓|猕猴桃|芒果|西瓜|黄瓜|生菜|白菜|土豆|瑞幸|星巴克|库迪|manner|茶百道|喜茶|奈雪|霸王茶姬|沪上阿姨|早饭|午饭|晚饭|早餐|午餐|晚餐|亚惠|湘菜|川菜|粤菜|豫菜|烧烤|火锅|麻辣烫|冒菜/i.test(
      n
    )
  )
    return "食";
  if (/房租|水电|物业|卫生|纸巾|洗衣液|牙膏|洗浴|家具|家电/i.test(n)) return "住";
  // 学 优先于 娱（书城/图书/阅读类会员是教育，不是娱乐）
  if (/课程|培训|学费|学习费|考试费|教程|补课|报名费|文具|笔|本子|纸张|打印|书城|图书|阅读|题库|单词|编程学习|扇贝|百词斩/i.test(n)) return "学";
  // 娱：明确写出具体平台或场景，不用裸「会员」（易误伤教育类订阅）
  if (/电影|游戏|KTV|演唱会|剧场|音乐节|桌游|密室|游乐/i.test(n)) return "娱";
  if (/视频会员|音乐会员|游戏会员|爱奇艺|优酷|腾讯视频|B站|哔哩哔哩|Netflix|Spotify|Steam/i.test(n)) return "娱";
  return "其他支出";
}

function inferIncomeCategoryFromCommaTripleNote(note) {
  const n = String(note || "");
  if (/工资|薪水|薪资|月薪|底薪|发薪|兼职|稿费|劳务|外包/i.test(n)) return "劳务兼职";
  if (/年终奖|绩效奖|季度奖|项目奖|奖金|津贴/i.test(n)) return "奖金补贴";
  if (/报销/i.test(n)) return "报销返还";
  if (/利息|分红|理财/i.test(n)) return "投资利息";
  if (
    /返利|返现|返点|退款|退费|退回|返还(?!码)|小蚕|一淘|蜜源|好省|京粉|淘宝联盟/i.test(n)
  )
    return "退款返现";
  if (/转给我|他人转|朋友还|还我钱|借还|收款|红包|转账|妈妈|爸爸|爸妈|家人/i.test(n)) return "他人转账";
  return "其他收入";
}

function isCommaTripleNoteLikelyIncome(note) {
  const n = String(note || "");
  if (!n) return false;
  return (
    /返利|返现|返点|退款|退费|退回|返还(?!码)|报销|工资|薪水|薪资|月薪|底薪|发薪|年终奖|绩效奖|季度奖|项目奖|奖金|津贴|兼职|稿费|劳务|外包|利息|分红|理财|小蚕|一淘|蜜源|好省|京粉|淘宝联盟|转给我|他人转|朋友还|还我钱|借还|收款/i.test(
      n
    )
  );
}

const TRIPLE_SEP = "[,，、]"; // 中英逗号 + 常见误用顿号
const EXPENSE_CATEGORIES = new Set(["衣", "食", "住", "行", "娱", "学", "持续黑洞", "其他支出"]);

function isLikelyAccountToken(token) {
  const t = normalizeBookkeepingLine(String(token || "").trim());
  if (!t) return false;
  return /微信|零钱通|零钱|微信零钱|微信零钱通|余额宝|招行|招商|金葵花|建行|农行|农业银行|中原银行|中行|中国银行|社保卡|月付|币安|支付宝|小荷包|人民币|现金|港币|饭卡/i.test(
    t
  );
}

function isLikelyDebtAccountToken(token) {
  const t = normalizeBookkeepingLine(String(token || "").trim());
  if (!t) return false;
  return /月付|花呗|白条|信用卡|借呗/i.test(t);
}

function parseAccountHeader(raw) {
  const m = normalizeBookkeepingLine(raw).match(/^(.+?)[:：]$/u);
  if (!m) return "";
  const account = normalizeBookkeepingLine(m[1]);
  return account && isLikelyAccountToken(account) ? account : "";
}

function parseExpenseCategoryDirective(raw) {
  const s = normalizeBookkeepingLine(raw).replace(/\s+/g, "");
  const m = s.match(/^分类(.+)$/u);
  const cat = m ? m[1] : s;
  return EXPENSE_CATEGORIES.has(cat) ? cat : "";
}

function splitLeadingDateFromNote(rawNote) {
  const note = normalizeBookkeepingLine(rawNote);
  const m = note.match(/^(\d{1,2}[.．/月]\d{1,2}(?:日|号)?)(.*)$/u);
  if (!m) return { note, date: "" };
  const date = parseFlexibleDateToken(m[1]);
  if (!date) return { note, date: "" };
  const rest = normalizeBookkeepingLine(m[2]);
  return { note: rest || note, date };
}

function buildTripleResult(note, amount, accountRaw) {
  if (!note || !accountRaw || !Number.isFinite(amount) || amount < 0) return null;
  const datedNote = splitLeadingDateFromNote(note);
  const cleanNote = datedNote.note;
  const noteProbe = typeof cleanNote.normalize === "function" ? cleanNote.normalize("NFKC") : cleanNote;
  if (isLikelyDebtAccountToken(accountRaw) && /利息|手续费|服务费|分期费|逾期费/i.test(noteProbe)) {
    return {
      交易类型: "负债",
      金额: amount,
      账户: accountRaw,
      转出账户: "",
      转入账户: "",
      支出分类: "",
      收入分类: "",
      借贷方向: "借入",
      借款人: "",
      备注: cleanNote,
      日期: datedNote.date,
    };
  }
  if (isCommaTripleNoteLikelyIncome(noteProbe)) {
    return {
      交易类型: "收入",
      金额: amount,
      账户: accountRaw,
      转出账户: "",
      转入账户: "",
      支出分类: "",
      收入分类: inferIncomeCategoryFromCommaTripleNote(noteProbe),
      借贷方向: "",
      借款人: "",
      备注: cleanNote,
      日期: datedNote.date,
    };
  }
  return {
    交易类型: "支出",
    金额: amount,
    账户: accountRaw,
    转出账户: "",
    转入账户: "",
    支出分类: inferExpenseCategoryFromNote(noteProbe),
    收入分类: "",
    借贷方向: "",
    借款人: "",
    备注: cleanNote,
    日期: datedNote.date,
  };
}

/**
 * 转账快捷解析，覆盖常见口语格式：
 *   余额宝转招行500           → 转出=余额宝  转入=招行  金额=500
 *   余额宝→招行，500          → 同上
 *   转账，余额宝到招行，500    → 同上
 *   微信转余额宝1000          → 转出=零钱通  转入=余额宝 金额=1000
 *   招行转微信500             → 转出=招行    转入=零钱通 金额=500
 */
/**
 * 从字符串末尾提取金额，返回 [accountPart, amount] 或 null。
 * 账户名与金额之间可以有分隔符，也可以直接相邻（中文字符后跟数字视为分界）。
 */
function splitAccountAndAmount(s) {
  // 末尾金额：纯数字或小数，可选前置分隔符
  const m = s.match(/^(.*?)(?:[,，、\s]+)?([0-9]+(?:\.[0-9]{1,2})?)$/u);
  if (!m) return null;
  const acct = m[1].trim();
  const amt  = Number(m[2]);
  if (!acct || !Number.isFinite(amt) || amt <= 0) return null;
  // 账户名末尾不能是裸数字（除非整体就是账户名，如「月付-N8」由上一级判断）
  // 允许：中文末尾、字母末尾、括号末尾
  // 不允许：纯数字末尾且账户>2字符（说明数字被账户名吞掉了）
  if (/\d$/.test(acct)) {
    // 尝试把尾部连续数字（+小数）重新归入金额
    const refix = acct.match(/^(.*?)(\d+(?:\.[0-9]{1,2})?)$/u);
    if (refix && /[一-鿿A-Za-z)\]）]$/.test(refix[1])) {
      const acct2 = refix[1].trim();
      const amt2  = Number(refix[2] + (m[2] ? "." + m[2] : ""));
      // 只在明确是"账户名+连续数字"时才拆分
      const trueAmt = Number(refix[2]);
      if (acct2 && Number.isFinite(trueAmt) && trueAmt > 0) {
        return [acct2, trueAmt];
      }
    }
  }
  return [acct, amt];
}

export function parseTransferBookkeeping(text) {
  const raw = normalizeBookkeepingLine(String(text || "").trim());
  const s0 = (typeof raw.normalize === "function" ? raw.normalize("NFKC") : raw);
  if (!s0 || /[\n\r]/.test(s0)) return null;

  const ACCT = "[\\u4e00-\\u9fffA-Za-z0-9_()（）+\\-]{1,20}?"; // 非贪婪
  const AMT  = "([0-9]+(?:\\.[0-9]{1,2})?)";
  // 分隔符：逗号/空格/无（无时要求账户末尾是中文/字母）
  const SEP  = "(?:[,，、\\s]+|(?<=[\\u4e00-\\u9fffA-Za-z)）]))";

  let fromRaw = "", toRaw = "", amtRaw = "";

  // 模式3（最明确）: "转账，A到B，金额" / "转账 A到B 金额"
  let m = s0.match(/^转账[,，、\s]+([一-鿿A-Za-z0-9_()（）+\-]+?)(?:到|→|➜)([一-鿿A-Za-z0-9_()（）+\-]+?)[,，、\s]+([0-9]+(?:\.[0-9]{1,2})?)$/u);
  if (m) [, fromRaw, toRaw, amtRaw] = m;

  // 模式3b: "转账，金额，A到B"
  if (!fromRaw) {
    m = s0.match(/^转账[,，、\s]+([0-9]+(?:\.[0-9]{1,2})?)[,，、\s]+([一-鿿A-Za-z0-9_()（）+\-]+?)(?:到|→|➜)([一-鿿A-Za-z0-9_()（）+\-]+?)$/u);
    if (m) {
      amtRaw = m[1];
      fromRaw = m[2];
      toRaw = m[3];
    }
  }

  // 模式2: "A→B，金额" / "A→B金额（中文后接数字）"
  if (!fromRaw) {
    m = s0.match(/^([一-鿿A-Za-z0-9_()（）+\-]+?)[→➜]([一-鿿A-Za-z0-9_()（）+\-]+?)[,，、\s]*([0-9]+(?:\.[0-9]{1,2})?)$/u);
    if (m) [, fromRaw, toRaw, amtRaw] = m;
  }

  // 模式1: "A转B，金额" 或 "A转B金额"（账户末尾须为中文或字母）
  if (!fromRaw) {
    m = s0.match(/^([一-鿿A-Za-z0-9_()（）+\-]+?)转([一-鿿A-Za-z0-9_()（）+\-]+?)[,，、\s]*([0-9]+(?:\.[0-9]{1,2})?)$/u);
    if (m) {
      // 验证转入账户末尾不是数字（防止"招行500"被整体当账户）
      const toCandidate = m[2];
      if (/[一-鿿A-Za-z)）]$/.test(toCandidate)) {
        [, fromRaw, toRaw, amtRaw] = m;
      } else {
        // 末尾是数字，尝试把尾部数字重新归为金额
        const split = splitAccountAndAmount(toCandidate + (m[3] ? "" : ""));
        if (split) {
          fromRaw = m[1];
          toRaw   = split[0];
          amtRaw  = String(split[1]);
        }
      }
    }
  }

  // 模式4: "转账金额A到B"  e.g. "转账500余额宝到招行"
  if (!fromRaw) {
    m = s0.match(/^转账([0-9]+(?:\.[0-9]{1,2})?)([一-鿿A-Za-z0-9_()（）+\-]+?)(?:到|→)([一-鿿A-Za-z0-9_()（）+\-]+?)$/u);
    if (m) { amtRaw = m[1]; fromRaw = m[2]; toRaw = m[3]; }
  }

  if (!fromRaw || !toRaw || !amtRaw) return null;
  const amount = Number(amtRaw);
  if (!Number.isFinite(amount) || amount <= 0) return null;

  return {
    交易类型: "转账",
    金额: amount,
    账户: "",
    转出账户: fromRaw.trim(),
    转入账户: toRaw.trim(),
    支出分类: "",
    收入分类: "",
    借贷方向: "",
    借款人: "",
    备注: "转账",
    日期: "",
  };
}

function parseFlexibleDateToken(raw) {
  const s = String(raw || "").trim();
  if (!s) return "";
  let m = s.match(/^(\d{2})(\d{2})(\d{2})$/); // yymmdd -> 20yy-mm-dd
  if (m) return `20${m[1]}-${m[2]}-${m[3]} 00:00:00`;
  m = s.match(/^(\d{4})(\d{2})(\d{2})$/); // yyyymmdd
  if (m) return `${m[1]}-${m[2]}-${m[3]} 00:00:00`;
  m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/); // yyyy-mm-dd / yyyy/m/d
  if (m) return `${m[1]}-${String(m[2]).padStart(2, "0")}-${String(m[3]).padStart(2, "0")} 00:00:00`;
  m = s.match(/^(\d{1,2})[.．/月](\d{1,2})(?:日|号)?$/u); // m.d / m/d / m月d日
  if (m) {
    const year = new Date().getFullYear();
    const month = Number(m[1]);
    const day = Number(m[2]);
    const d = new Date(year, month - 1, day);
    if (d.getFullYear() === year && d.getMonth() === month - 1 && d.getDate() === day) {
      return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")} 00:00:00`;
    }
  }
  return "";
}

export function parseBookkeepingDateHeader(raw) {
  const s = normalizeBookkeepingLine(String(raw || "").trim()).replace(/[:：]$/u, "");
  if (!s || /[,，、\s]/u.test(s)) return "";
  return parseFlexibleDateToken(s);
}

function parseContextualAmountNoteLine(row, currentAccount) {
  if (!currentAccount) return null;
  const parts = normalizeBookkeepingLine(row)
    .split(/[,，、]/u)
    .map((part) => normalizeBookkeepingLine(part))
    .filter(Boolean);
  if (parts.length !== 2 && parts.length !== 3) return null;
  if (!/^[0-9]+(?:\.[0-9]+)?$/u.test(parts[0])) return null;
  const amount = Number(parts[0]);
  if (!Number.isFinite(amount) || amount < 0) return null;
  const noteInfo = splitLeadingDateFromNote(parts[1]);
  const explicitCategory = parts.length === 3 ? parseExpenseCategoryDirective(parts[2]) : "";
  if (parts.length === 3 && !explicitCategory) return null;
  return {
    交易类型: "支出",
    金额: amount,
    账户: currentAccount,
    转出账户: "",
    转入账户: "",
    支出分类: explicitCategory || inferExpenseCategoryFromNote(noteInfo.note),
    收入分类: "",
    借贷方向: "",
    借款人: "",
    备注: noteInfo.note,
    日期: noteInfo.date,
  };
}

export function parseContextualBookkeepingLines(rawTextOrLines) {
  const rows = (Array.isArray(rawTextOrLines) ? rawTextOrLines : String(rawTextOrLines || "").split(/\n+/u))
    .map((line) => normalizeBookkeepingLine(line))
    .filter(Boolean);
  let currentDate = "";
  let currentAccount = "";
  let entryLineCount = 0;
  let headerLineCount = 0;
  const parsedRows = [];

  for (const row of rows) {
    const dateHeader = parseBookkeepingDateHeader(row);
    if (dateHeader) {
      currentDate = dateHeader;
      currentAccount = "";
      headerLineCount += 1;
      continue;
    }

    const accountHeader = parseAccountHeader(row);
    if (accountHeader) {
      currentAccount = accountHeader;
      headerLineCount += 1;
      continue;
    }

    entryLineCount += 1;
    const contextualParsed = parseContextualAmountNoteLine(row, currentAccount);
    const parsed = contextualParsed || parseTransferBookkeeping(row) || parseCommaTripleBookkeeping(row);
    if (!parsed) continue;
    if (!parsed["日期"] && currentDate) parsed["日期"] = currentDate;
    parsedRows.push({ parsed, rawLine: row });
  }

  return {
    rows: parsedRows,
    entryLineCount,
    headerLineCount,
    totalLineCount: rows.length,
  };
}

function dateTimeAtMidnight(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")} 00:00:00`;
}

export function resolveRelativeBookkeepingDateToken(raw, now = new Date()) {
  const s = normalizeBookkeepingLine(String(raw || "").trim());
  if (!s) return "";
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const shifted = (days) => {
    const d = new Date(today);
    d.setDate(d.getDate() + days);
    return dateTimeAtMidnight(d);
  };
  if (/大前天/u.test(s)) return shifted(-3);
  if (/前天/u.test(s)) return shifted(-2);
  if (/(昨天|昨日)/u.test(s)) return shifted(-1);
  if (/(今天|今早|今天早上|今晚|今晨|刚才)/u.test(s)) return shifted(0);
  return "";
}

export function resolveBookkeepingDateTime(raw, fallback = "", now = new Date()) {
  const relative = resolveRelativeBookkeepingDateToken(raw, now);
  if (relative) return relative;
  const normalized = normalizeBookkeepingDateTime(raw, "");
  if (normalized) return normalized;
  const s = String(raw || "").trim();
  if (!s) return fallback;
  const inlineToken =
    s.match(/\b\d{4}[-/.]\d{1,2}[-/.]\d{1,2}\b/u)?.[0] ??
    s.match(/\b\d{8}\b/u)?.[0] ??
    s.match(/\b\d{6}\b/u)?.[0] ??
    "";
  return inlineToken ? normalizeBookkeepingDateTime(inlineToken, fallback) : fallback;
}

export function normalizeBookkeepingDateTime(raw, fallback = "") {
  const s = String(raw || "").trim();
  if (!s) return fallback;

  const flex = parseFlexibleDateToken(s);
  if (flex) return flex;

  const dt = s.match(
    /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/
  );
  if (!dt) return fallback;

  const year = Number(dt[1]);
  const month = Number(dt[2]);
  const day = Number(dt[3]);
  const hour = Number(dt[4] || 0);
  const minute = Number(dt[5] || 0);
  const second = Number(dt[6] || 0);

  const date = new Date(year, month - 1, day, hour, minute, second);
  if (
    Number.isNaN(date.getTime()) ||
    date.getFullYear() !== year ||
    date.getMonth() !== month - 1 ||
    date.getDate() !== day ||
    date.getHours() !== hour ||
    date.getMinutes() !== minute ||
    date.getSeconds() !== second
  ) {
    return fallback;
  }

  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")} ${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:${String(second).padStart(2, "0")}`;
}

export function userTextHasExplicitDate(text) {
  const s = String(text || "").trim();
  if (!s) return false;
  return /今天|昨日|昨天|前天|大前天|刚才|今早|今天早上|今晚|今晨|上周|这周|本周|周[一二三四五六日天末]|星期[一二三四五六日天]|\d{6}|\d{8}|\d{4}[-/.]\d{1,2}[-/.]\d{1,2}/.test(
    s
  );
}

/**
 * 单行「备注，金额，账户」，无换行则匹配；账户后可有短吐槽（在「现在|但是…」前截断）
 */
export function parseCommaTripleBookkeeping(text) {
  const raw = normalizeBookkeepingLine(String(text || "").trim());
  const s0 = typeof raw.normalize === "function" ? raw.normalize("NFKC") : raw;
  if (!s0 || /[\n\r]/.test(s0)) return null;
  const m4 = s0.match(
    new RegExp(
      `^(.+?)${TRIPLE_SEP}\\s*(.+?)\\s*${TRIPLE_SEP}\\s*([0-9]+(?:\\.[0-9]+)?)\\s*${TRIPLE_SEP}\\s*([\\u4e00-\\u9fffA-Za-z0-9+\\-()（）_]{1,48}?)$`,
      "u"
    )
  );
  if (m4) {
    // 「类型，备注，金额，账户」格式：第一段是交易类型
    const typeMatch = m4[1].trim().match(/^(收入|支出|转账|负债|还款)$/);
    if (typeMatch) {
      const type = typeMatch[1];
      const note4t = normalizeBookkeepingLine(m4[2].trim());
      const account4t = normalizeBookkeepingLine(m4[4].trim());
      const amount4t = Number(m4[3]);
      if (note4t && account4t && Number.isFinite(amount4t) && amount4t >= 0) {
        const result = {
          交易类型: type,
          金额: amount4t,
          账户: account4t,
          转出账户: "", 转入账户: "",
          支出分类: "",
          收入分类: "",
          借贷方向: "", 借款人: "",
          备注: note4t,
          日期: "",
        };
        if (type === "收入") {
          result.收入分类 = inferIncomeCategoryFromCommaTripleNote(note4t);
        } else if (type === "支出") {
          const explicitCat = m4[2].trim().match(/^([食行住娱学其他支出])$/u);
          result.支出分类 = explicitCat ? explicitCat[1] : inferExpenseCategoryFromNote(note4t);
        }
        return result;
      }
    }

    // 「备注，分类X，金额，账户」格式：第二段明确指定分类
    const catMatch = m4[2].trim().match(/^分类\s*([食行住娱学其他支出收入]{1,4})$/u);
    if (catMatch) {
      const note4c = normalizeBookkeepingLine(m4[1].trim());
      const account4c = normalizeBookkeepingLine(m4[4].trim());
      const amount4c = Number(m4[3]);
      const explicitCat = catMatch[1];
      if (note4c && account4c && Number.isFinite(amount4c) && amount4c >= 0) {
        const noteProbe4c = typeof note4c.normalize === "function" ? note4c.normalize("NFKC") : note4c;
        const isIncome = isCommaTripleNoteLikelyIncome(noteProbe4c) || explicitCat === "收入";
        if (isIncome) {
          return {
            交易类型: "收入",
            金额: amount4c,
            账户: account4c,
            转出账户: "", 转入账户: "",
            支出分类: "",
            收入分类: inferIncomeCategoryFromCommaTripleNote(noteProbe4c),
            借贷方向: "", 借款人: "",
            备注: note4c,
            日期: "",
          };
        }
        return {
          交易类型: "支出",
          金额: amount4c,
          账户: account4c,
          转出账户: "", 转入账户: "",
          支出分类: explicitCat,
          收入分类: "",
          借贷方向: "", 借款人: "",
          备注: note4c,
          日期: "",
        };
      }
    }

    const dateVal = parseFlexibleDateToken(m4[1]);
    const note4 = normalizeBookkeepingLine(m4[2].trim());
    const account4 = normalizeBookkeepingLine(m4[4].trim());
    const amount4 = Number(m4[3]);
    if (dateVal && note4 && account4 && Number.isFinite(amount4) && amount4 >= 0) {
      const noteProbe4 = typeof note4.normalize === "function" ? note4.normalize("NFKC") : note4;
      if (isCommaTripleNoteLikelyIncome(noteProbe4)) {
        return {
          交易类型: "收入",
          金额: amount4,
          账户: account4,
          转出账户: "",
          转入账户: "",
          支出分类: "",
          收入分类: inferIncomeCategoryFromCommaTripleNote(noteProbe4),
          借贷方向: "",
          借款人: "",
          备注: note4,
          日期: dateVal,
        };
      }
      return {
        交易类型: "支出",
        金额: amount4,
        账户: account4,
        转出账户: "",
        转入账户: "",
        支出分类: inferExpenseCategoryFromNote(noteProbe4),
        收入分类: "",
        借贷方向: "",
        借款人: "",
        备注: note4,
        日期: dateVal,
      };
    }
  }

  const tripleParts = s0.split(/[,，、]/u).map((part) => normalizeBookkeepingLine(part)).filter(Boolean);
  if (tripleParts.length === 4) {
    const [p0, p1, p2, p3] = tripleParts;
    const amount = Number(p3);
    const dateVal = resolveBookkeepingDateTime(p0, "");
    if (dateVal && Number.isFinite(amount) && /^[0-9]+(?:\.[0-9]+)?$/u.test(String(p3))) {
      const middle = [p1, p2];
      const accountIdx = middle.findIndex((part) => isLikelyAccountToken(part));
      if (accountIdx >= 0) {
        const account = middle[accountIdx];
        const note = middle[1 - accountIdx];
        const result = buildTripleResult(note, amount, account);
        if (result) {
          result["日期"] = dateVal;
          return result;
        }
      }
    }
  }
  if (tripleParts.length === 3) {
    // 检查是否有"收入XX"或"支出XX"格式的金额字段
    const amountWithTypeIndexes = tripleParts
      .map((part, idx) => {
        const match = part.match(/^(收入|支出|入账|到账|收款)([0-9]+(?:\.[0-9]+)?)$/u);
        if (match) {
          const rawType = match[1];
          return { idx, part, type: rawType === "支出" ? "支出" : "收入", amount: Number(match[2]), accountHint: "" };
        }
        const accountIncomeMatch = part.match(/^(.+?)(收入|入账|到账|收款)([0-9]+(?:\.[0-9]+)?)$/u);
        if (accountIncomeMatch && isLikelyAccountToken(accountIncomeMatch[1])) {
          return {
            idx,
            part,
            type: "收入",
            amount: Number(accountIncomeMatch[3]),
            accountHint: accountIncomeMatch[1],
          };
        }
        return null;
      })
      .filter(Boolean);

    if (amountWithTypeIndexes.length === 1) {
      // 找到了"收入XX"或"支出XX"格式
      const amountInfo = amountWithTypeIndexes[0];
      const otherIndexes = [0, 1, 2].filter((idx) => idx !== amountInfo.idx);
      const likelyAccountIndexes = amountInfo.accountHint
        ? [amountInfo.idx]
        : otherIndexes.filter((idx) => isLikelyAccountToken(tripleParts[idx]));

      if (likelyAccountIndexes.length === 1) {
        const accountIdx = likelyAccountIndexes[0];
        const noteIdx = amountInfo.accountHint
          ? otherIndexes.find((idx) => !isLikelyAccountToken(tripleParts[idx])) ?? otherIndexes[0]
          : otherIndexes.find((idx) => idx !== accountIdx);
        if (noteIdx !== undefined) {
          const note = tripleParts[noteIdx];
          const account = amountInfo.accountHint || tripleParts[accountIdx];
          const amount = amountInfo.amount;

          if (amountInfo.type === "收入") {
            return {
              交易类型: "收入",
              金额: amount,
              账户: account,
              转出账户: "", 转入账户: "",
              支出分类: "",
              收入分类: inferIncomeCategoryFromCommaTripleNote(note),
              借贷方向: "", 借款人: "",
              备注: note,
              日期: "",
            };
          } else {
            return {
              交易类型: "支出",
              金额: amount,
              账户: account,
              转出账户: "", 转入账户: "",
              支出分类: inferExpenseCategoryFromNote(note),
              收入分类: "",
              借贷方向: "", 借款人: "",
              备注: note,
              日期: "",
            };
          }
        }
      }
    }

    const amountIndexes = tripleParts
      .map((part, idx) => ({ idx, part, amount: Number(part) }))
      .filter(({ part, amount }) => Number.isFinite(amount) && /^[0-9]+(?:\.[0-9]+)?$/u.test(String(part)));
    if (amountIndexes.length === 1) {
      const amountIdx = amountIndexes[0].idx;
      const otherIndexes = [0, 1, 2].filter((idx) => idx !== amountIdx);
      const likelyAccountIndexes = otherIndexes.filter((idx) => isLikelyAccountToken(tripleParts[idx]));
      if (likelyAccountIndexes.length === 1) {
        const accountIdx = likelyAccountIndexes[0];
        const noteIdx = otherIndexes.find((idx) => idx !== accountIdx);
        if (noteIdx !== undefined) {
          const result = buildTripleResult(
            tripleParts[noteIdx],
            Number(tripleParts[amountIdx]),
            tripleParts[accountIdx]
          );
          if (result) return result;
        }
      }
      // 如果没有明确的账户token，但有一个明确的金额，尝试智能匹配
      // 优先假设：金额 + 两个非金额字段 → 其中一个是账户，另一个是备注
      if (likelyAccountIndexes.length === 0 && amountIndexes.length === 1) {
        // 尝试所有可能的组合
        for (const accountIdx of otherIndexes) {
          const noteIdx = otherIndexes.find((idx) => idx !== accountIdx);
          if (noteIdx !== undefined) {
            const result = buildTripleResult(
              tripleParts[noteIdx],
              Number(tripleParts[amountIdx]),
              tripleParts[accountIdx]
            );
            if (result) return result;
          }
        }
      }
    }
  }

  if (tripleParts.length === 2) {
    const amountWithAccount = tripleParts
      .map((part, idx) => {
        const m = part.match(/^(.+?)(收入|入账|到账|收款)([0-9]+(?:\.[0-9]+)?)$/u);
        if (!m || !isLikelyAccountToken(m[1])) return null;
        return { idx, account: m[1], amount: Number(m[3]) };
      })
      .filter(Boolean);
    if (amountWithAccount.length === 1) {
      const info = amountWithAccount[0];
      const noteIdx = [0, 1].find((idx) => idx !== info.idx);
      const note = normalizeBookkeepingLine(tripleParts[noteIdx]);
      if (note && Number.isFinite(info.amount) && info.amount >= 0) {
        return {
          交易类型: "收入",
          金额: info.amount,
          账户: info.account,
          转出账户: "",
          转入账户: "",
          支出分类: "",
          收入分类: inferIncomeCategoryFromCommaTripleNote(note),
          借贷方向: "",
          借款人: "",
          备注: note,
          日期: "",
        };
      }
    }
  }

  const tailBoundary =
    "(?:[·…⋯\\s\\u00A0]*)?(?=现在|但是|所以|既然|不过|而且|并且|为啥|为什么|怎么|居然|竟然|连|根本|真是|？|！|～|…|$)";
  const m = s0.match(
    new RegExp(
      `^(.+?)${TRIPLE_SEP}\\s*([0-9]+(?:\\.[0-9]+)?)\\s*${TRIPLE_SEP}\\s*([\\u4e00-\\u9fffA-Za-z0-9+\\-()（）_]{1,48}?)${tailBoundary}`,
      "u"
    )
  );
  if (!m) return null;
  const note = normalizeBookkeepingLine(m[1].trim());
  const accountRaw = normalizeBookkeepingLine(m[3].trim());
  if (!note || !accountRaw) return null;
  if (note.length > 120 || accountRaw.length > 48) return null;
  const amount = Number(m[2]);
  if (!Number.isFinite(amount) || amount < 0) return null;

  // Guard: if accountRaw is a known income/expense category keyword, the user used
  // "type,amount,category" format instead of "note,amount,account". Fall back to AI.
  const KNOWN_INCOME_CATS = new Set(["劳务兼职","奖金补贴","报销返还","投资利息","退款返现","他人转账","其他收入"]);
  const KNOWN_EXPENSE_CATS = new Set(["食","行","住","娱","学","其他支出"]);
  if (KNOWN_INCOME_CATS.has(accountRaw) || KNOWN_EXPENSE_CATS.has(accountRaw)) {
    return null; // fall back to AI parsing
  }

  // Guard: if note itself is a transaction-type keyword, the user used
  // "type,amount,category" format. Fall back to AI.
  const TRANSACTION_TYPE_KEYWORDS = new Set(["收入","支出","转账","负债","还款"]);
  if (TRANSACTION_TYPE_KEYWORDS.has(note)) {
    return null; // fall back to AI parsing
  }

  return buildTripleResult(note, amount, accountRaw);
}

export function parseFastBookkeepingLines(input) {
  const result = parseContextualBookkeepingLines(input);
  if (!result.entryLineCount || result.rows.length !== result.entryLineCount) return [];
  return result.rows.map((row) => row.parsed);
}
