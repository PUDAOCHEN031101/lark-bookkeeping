#!/usr/bin/env node
/**
 * 本地假数据：生成一张带文字的 PNG → base64 → 调用硅基 deepseek-ai/DeepSeek-OCR。
 * 不依赖飞书；用于验证 API Key 与请求体是否与守护进程一致。
 *
 * Usage:
 *   SILICONFLOW_API_KEY=... node scripts/test-deepseek-ocr-fake-image.mjs
 */
import { spawnSync } from "child_process";
import { readFileSync, mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const API = "https://api.siliconflow.cn/v1/chat/completions";
const MODEL = process.env.LARK_OCR_MODEL || "deepseek-ai/DeepSeek-OCR";
const KEY = process.env.SILICONFLOW_API_KEY || "";

function genPngPath() {
  const dir = mkdtempSync(join(tmpdir(), "sf-ocr-test-"));
  const png = join(dir, "fake.png");
  const py = `
from PIL import Image, ImageDraw, ImageFont
import sys
out = sys.argv[1]
font = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", 40)
im = Image.new("RGB", (560, 130), (255, 255, 255))
dr = ImageDraw.Draw(im)
dr.text((28, 42), "OCR_TEST Dinner 68.50 WeChat", fill=(0, 0, 0), font=font)
im.save(out)
`;
  const r = spawnSync("python3", ["-c", py, png], { encoding: "utf8", timeout: 15_000 });
  if (r.status !== 0) throw new Error((r.stderr || r.stdout || "python failed").slice(0, 400));
  return { dir, png };
}

async function main() {
  if (!KEY) {
    console.error("缺少环境变量 SILICONFLOW_API_KEY");
    process.exit(1);
  }
  const { dir, png } = genPngPath();
  try {
    const buf = readFileSync(png);
    const dataUrl = `data:image/png;base64,${buf.toString("base64")}`;
    const body = {
      model: MODEL,
      messages: [
        {
          role: "user",
          content: [
            { type: "image_url", image_url: { url: dataUrl } },
            { type: "text", text: "请识别图中全部可见文字。只输出纯文本。" },
          ],
        },
      ],
      temperature: 0,
      max_tokens: 256,
    };
    const resp = await fetch(API, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${KEY}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(120_000),
    });
    const raw = await resp.text();
    if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${raw.slice(0, 600)}`);
    const j = JSON.parse(raw);
    const text = (j?.choices?.[0]?.message?.content || "").trim();
    console.log("model:", MODEL);
    console.log("ocr:", text);
    const ok = /68\.50|Dinner|WeChat|OCR_TEST/i.test(text);
    if (!ok) {
      console.error("断言未通过：期望输出中含 Dinner / 68.50 / WeChat / OCR_TEST 之一");
      process.exit(2);
    }
    console.log("断言通过（命中关键词）。");
  } finally {
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
  }
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
