import test from "node:test";
import assert from "node:assert/strict";

import {
  parseContextualBookkeepingLines,
  parseCommaTripleBookkeeping,
  parseFastBookkeepingLines,
  parseTransferBookkeeping,
  resolveBookkeepingDateTime,
} from "../lib/bookkeeping-comma-triple.mjs";

test("relative date text resolves from full sentence context", () => {
  assert.equal(
    resolveBookkeepingDateTime("昨天，金葵花，工资收入，4370", "fallback", new Date("2026-05-07T09:00:00+08:00")),
    "2026-05-06 00:00:00"
  );
});

test("transfer triple supports type, amount, from-to", () => {
  const expected = {
    交易类型: "转账",
    金额: 961.04,
    账户: "",
    转出账户: "金葵花",
    转入账户: "月付",
    支出分类: "",
    收入分类: "",
    借贷方向: "",
    借款人: "",
    备注: "转账",
    日期: "",
  };
  assert.deepEqual(parseTransferBookkeeping("转账, 961.04, 金葵花到月付"), expected);
  assert.deepEqual(parseFastBookkeepingLines("转账, 961.04, 金葵花到月付"), [expected]);
});

test("debt account interest is classified as debt, not income", () => {
  assert.deepEqual(parseCommaTripleBookkeeping("6.88, 利息, 月付"), {
    交易类型: "负债",
    金额: 6.88,
    账户: "月付",
    转出账户: "",
    转入账户: "",
    支出分类: "",
    收入分类: "",
    借贷方向: "借入",
    借款人: "",
    备注: "利息",
    日期: "",
  });
});

test("expense note can carry a compact month-day prefix", () => {
  const parsed = parseCommaTripleBookkeeping("12.47，5.10打车，小荷包");
  assert.equal(parsed["交易类型"], "支出");
  assert.equal(parsed["金额"], 12.47);
  assert.equal(parsed["账户"], "小荷包");
  assert.equal(parsed["支出分类"], "行");
  assert.equal(parsed["备注"], "打车");
  assert.match(parsed["日期"], /^\d{4}-05-10 00:00:00$/);
  assert.equal(parseCommaTripleBookkeeping("9.03，5.10运费，小荷包")["支出分类"], "行");
  assert.equal(parseCommaTripleBookkeeping("28，5.10扇贝会员续费，小荷包")["支出分类"], "学");
});

test("income amount prefixes parse without AI", () => {
  assert.deepEqual(parseCommaTripleBookkeeping("入账60，妈妈转账，零钱"), {
    交易类型: "收入",
    金额: 60,
    账户: "零钱",
    转出账户: "",
    转入账户: "",
    支出分类: "",
    收入分类: "他人转账",
    借贷方向: "",
    借款人: "",
    备注: "妈妈转账",
    日期: "",
  });
  assert.deepEqual(parseCommaTripleBookkeeping("零钱收入0.55，红包"), {
    交易类型: "收入",
    金额: 0.55,
    账户: "零钱",
    转出账户: "",
    转入账户: "",
    支出分类: "",
    收入分类: "他人转账",
    借贷方向: "",
    借款人: "",
    备注: "红包",
    日期: "",
  });
});

test("date header applies to following comma triples", () => {
  const result = parseContextualBookkeepingLines(`250515
40，大巴，金葵花
17.9，食物套餐，金葵花`);
  assert.equal(result.entryLineCount, 2);
  assert.equal(result.rows.length, 2);
  assert.deepEqual(
    result.rows.map((row) => ({
      amount: row.parsed["金额"],
      account: row.parsed["账户"],
      note: row.parsed["备注"],
      date: row.parsed["日期"],
      category: row.parsed["支出分类"],
    })),
    [
      { amount: 40, account: "金葵花", note: "大巴", date: "2025-05-15 00:00:00", category: "行" },
      { amount: 17.9, account: "金葵花", note: "食物套餐", date: "2025-05-15 00:00:00", category: "食" },
    ]
  );
});

test("date and account headers apply to amount-note rows", () => {
  const result = parseContextualBookkeepingLines(`260516
中国银行：
12，高铁
10，地铁
50，电影票
260517：
中国银行：
149，安踏省钱卡，分类住
37，高铁`);
  assert.equal(result.entryLineCount, 5);
  assert.deepEqual(
    result.rows.map((row) => ({
      amount: row.parsed["金额"],
      account: row.parsed["账户"],
      note: row.parsed["备注"],
      date: row.parsed["日期"],
      category: row.parsed["支出分类"],
    })),
    [
      { amount: 12, account: "中国银行", note: "高铁", date: "2026-05-16 00:00:00", category: "行" },
      { amount: 10, account: "中国银行", note: "地铁", date: "2026-05-16 00:00:00", category: "行" },
      { amount: 50, account: "中国银行", note: "电影票", date: "2026-05-16 00:00:00", category: "娱" },
      { amount: 149, account: "中国银行", note: "安踏省钱卡", date: "2026-05-17 00:00:00", category: "住" },
      { amount: 37, account: "中国银行", note: "高铁", date: "2026-05-17 00:00:00", category: "行" },
    ]
  );
});
