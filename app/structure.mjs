// app/structure.mjs —— 结构化层：文章 → 强约束 prompt → DeepSeek → JSON 卡片 + 内容层判据
// 为什么独立成模块：批量入库（ingest.mjs）与 HTTP 接口（/api/structure）必须共用**同一套规则**
// ——两份 prompt 会各自漂移，最后"网页上抽得对、批量入库抽得不对"，这种不一致最难查。
import fs from 'node:fs';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const API_URL = 'https://api.deepseek.com/chat/completions';
const MODEL = 'deepseek-v4-flash';

// system 模板来自 W2-D4 定论：「强约束 + temperature 0」= 把任务从自由生成改成按字段填表。
// ⚠️ 模板正文必须顶格写（行首空白会原样进 prompt），且不得含反引号 / ${
export const SYSTEM_PROMPT = `【角色】
你是信息提取器。从用户给出的文章素材里提取信息，只输出一个 JSON 对象。

【只输出 JSON】
- 不要任何开场白、说明文字或结尾总结
- 不要用小标题、加粗、列表符号等 markdown 排版
- 不要用代码块标记把 JSON 包起来
- 输出的第一个字符必须是 {，最后一个字符必须是 }

【字段规范】必须包含且只包含这 4 个字段：
- summary：字符串。用一句话概括全文主旨，不超过 60 字。
- points：字符串数组。3 到 6 条核心观点或关键信息，每条不超过 30 字。
- quotes：字符串数组。从素材中【逐字摘录】最有代表性的话，不要改写、不要换词、不要增删标点；找不到合适的就给空数组。
- takeaways：字符串数组。读者可以直接照做的可执行要点；原文没有就给空数组。

【占位规则】
- 原文没写的信息就给空数组，不要根据常识或外部知识补充。
- 只依据素材本身提取，素材里没有的就是没有。

【书写要求】
- 键名和字符串值都用半角双引号
- 字符串内部不要换行；要分条就拆成数组元素`;

// 结构层判据（W2-D4 三层判据之①）：剥代码围栏 + JSON.parse
export function checkJson(raw) {
  let t = String(raw).trim();
  const fenced = /^```/.test(t);
  t = t.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  try {
    return { ok: true, value: JSON.parse(t), fenced };
  } catch (err) {
    return { ok: false, message: err.message, fenced };
  }
}

// 轻量内容校验：四字段类型对不对（这是「按字段填表」，不是自由生成）
export function checkCard(card) {
  if (!card || typeof card !== 'object') return '不是 JSON 对象';
  if (typeof card.summary !== 'string') return 'summary 缺失或不是字符串';
  for (const key of ['points', 'quotes', 'takeaways']) {
    if (!Array.isArray(card[key])) return key + ' 缺失或不是数组';
  }
  return null;
}

/**
 * 一篇文章 → 结构化卡片
 * @param {{title,account,publishTime,text}} article
 * @param {{apiKey: string}} opts
 * @returns {Promise<{card, quotesCheck, finishReason, jsonFenced, usage}>}
 */
export async function structureArticle(article, { apiKey }) {
  if (!apiKey) throw new Error('未提供 DeepSeek apiKey');

  const userPrompt = `文章元数据：\n标题：${article.title}\n公众号：${article.account}\n发布时间：${article.publishTime}\n\n现在处理这篇文章的素材全文：\n${article.text}`;

  const response = await fetch(API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: MODEL,
      temperature: 0, // 结构化字段名不能飘（W2-D4 定论）
      max_tokens: 4000, // reasoning 从总额度里扣（实测 0–563 重尾），太小会吃光正文
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userPrompt },
      ],
    }),
  });

  const rawText = await response.text();
  if (!response.ok) {
    throw new Error(`DeepSeek 调用失败 HTTP ${response.status}：${rawText.slice(0, 200)}`);
  }

  const data = JSON.parse(rawText);
  const choice = data?.choices?.[0];
  const content = choice?.message?.content;
  const finishReason = choice?.finish_reason;
  const usage = data?.usage ?? {};

  // 🚨 截断层（W2 结论）：max_tokens 吃光则正文 0 字 —— 静默失败，必须显式检查
  if (finishReason === 'length') {
    throw new Error(`模型输出被 max_tokens 截断（finish_reason=length, usage=${JSON.stringify(usage)}）`);
  }
  if (typeof content !== 'string' || !content) {
    throw new Error('模型返回字段不完整（缺 content）');
  }

  // 结构层判据：剥围栏 + parse
  const checked = checkJson(content);
  if (!checked.ok) {
    throw new Error(`模型输出不是合法 JSON：${checked.message}｜前 300 字：${content.slice(0, 300)}`);
  }

  // 字段类型校验
  const cardError = checkCard(checked.value);
  if (cardError) {
    throw new Error(`卡片字段不完整：${cardError}｜前 300 字：${content.slice(0, 300)}`);
  }

  // 内容层判据（D5）：quotes 逐条与抓取原文做「去空白子串比对」
  // 格式对齐 ≠ 内容对齐：结构 100% 合法，金句仍可能被改写 —— 这层抓的就是改写
  const srcFlat = String(article.text || '').replace(/\s/g, '');
  const quotesCheck = (checked.value.quotes || []).map((q) => ({
    quote: q,
    verified: srcFlat.includes(String(q).replace(/\s/g, '')),
  }));

  return {
    card: checked.value,
    quotesCheck,
    finishReason: finishReason ?? null,
    jsonFenced: checked.fenced,
    usage: {
      promptTokens: usage.prompt_tokens ?? null,
      completionTokens: usage.completion_tokens ?? null,
      reasoningTokens: usage.reasoning_tokens ?? null,
      totalTokens: usage.total_tokens ?? null,
    },
  };
}

// 读仓库根 .env 里的 DeepSeek Key（CLI 用；server 走依赖注入不读盘）
export async function readDeepSeekKey() {
  let text = '';
  try {
    text = await readFile(new URL('../.env', import.meta.url), 'utf8');
  } catch {
    text = '';
  }
  const env = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    env[line.slice(0, eq).trim()] = line.slice(eq + 1).trim().replace(/^(['"])(.*)\1$/, '$2');
  }
  return env.DEEPSEEK_API_KEY || process.env.DEEPSEEK_API_KEY || '';
}

// CLI：对已抓取缓存做一次结构化（调试用）：node structure.mjs <hash>
const isCli = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isCli) {
  const hash = process.argv[2];
  if (!hash) {
    console.error('用法：node structure.mjs <hash>');
    process.exit(1);
  }
  const RAW_DIR = new URL('./data/raw/', import.meta.url);
  const raw = JSON.parse(fs.readFileSync(new URL(`${hash}.json`, RAW_DIR), 'utf8'));
  const key = await readDeepSeekKey();
  const r = await structureArticle(raw, { apiKey: key });
  console.log(`标题：${raw.title}`);
  console.log(`摘要：${r.card.summary}`);
  console.log(`观点 ${r.card.points.length} 条｜金句 ${r.card.quotes.length} 条｜要点 ${r.card.takeaways.length} 条`);
  console.log(`金句核验：${r.quotesCheck.filter((q) => q.verified).length}/${r.quotesCheck.length} 逐字命中`);
  console.log(`finish_reason=${r.finishReason} 围栏=${r.jsonFenced} tokens=${JSON.stringify(r.usage)}`);
}
