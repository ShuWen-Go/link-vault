// app/ask.mjs —— 生成层：检索 → 带出处 prompt → DeepSeek 作答 → 三重防幻觉
// 双重身份：
//   ① CLI：node ask.mjs "问题"   端到端自测（含降级路径）
//   ② 模块：import { ask } —— server.mjs 的 /api/ask 调用
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { retrieve } from './retrieve.mjs';

const API_URL = 'https://api.deepseek.com/chat/completions';
const MODEL = 'deepseek-v4-flash';
const TOP_N = 5;

// 🚨 降级阈值（09-29 在 4 篇语料上**实测标定**，不是拍脑袋）：
//   语料外问题（红烧肉/天气/股票）向量最高分 **0.28–0.38**；语料内问题向量分 ≥ 0.44。
// ⇒ 判定规则：**向量分 ≥ 0.42 或 关键词分 ≥ 0.60** 才算"有依据"（任一路够强即可）。
//   · 为什么关键词阈值要 0.60 这么高：实测踩坑 —— 「红烧肉」在《一文讲透Skill》里被当**比喻**
//     用过，关键词路巧合命中 0.375；而真正相关的问句（如「怎么防止 AI 乱调工具」）也只有 0.357。
//     ⇒ **关键词"部分命中"不能当依据**，只有高覆盖率（≥0.6）才算强证据。
//   · 为什么保留关键词兜底：精确串问题（「1206.6万人次」向量仅 0.44）靠关键词 1.00 救回。
// ⚠️ 换语料 / 换模型必须重新标定；阈值不是真理，是**当前语料下的经验值**。
export const MIN_VECTOR = 0.42;
export const MIN_KEYWORD = 0.6;

// 防线①：检索锁定 —— 把"只能用资料"写成硬性规则（约束是下限保险，不是行为开关）
// ⚠️ 模板正文必须顶格（行首空白会原样进 prompt），且不得含反引号
const SYSTEM_PROMPT = `【角色】
你是资料问答助手。只依据【资料】回答问题。

【硬性规则】
1. 只能用【资料】里的内容作答，不得使用外部知识或常识补充。
2. 每句结论后必须标注来源编号，格式如 [1] 或 [1][3]，编号对应【资料】里的方括号编号。
3. 【资料】中没有足够信息时，直接回答：资料中没有找到相关内容。不要猜测、不要编造。
4. 不要输出 markdown 大标题、不要用代码块、不要写开场白。

【输出格式】
直接给答案正文，句末带来源编号。`;

// 读仓库根 .env 里的 DeepSeek Key（与 embed.mjs 同款小函数；key 名不同、用途不同）
async function readDeepSeekKey() {
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

/**
 * 提问 → 双路检索 → 带出处作答
 * @returns {Promise<{answer, sources, degraded, reason, vTop, kTop, check}>}
 */
export async function ask(question, { apiKey, topN = TOP_N } = {}) {
  const { fused, vHits, kHits } = await retrieve(question, { topN });

  // 两路的最高分（用于降级判定 + 观测）
  const vTop = vHits.length ? Math.max(...vHits.map((h) => h.vscore)) : 0;
  const kTop = kHits.length ? Math.max(...kHits.map((h) => h.kscore)) : 0;

  // —— 防线③：无匹配降级（先判，能省一次模型调用）——
  if (!fused.length || (vTop < MIN_VECTOR && kTop < MIN_KEYWORD)) {
    return {
      answer: '资料中没有找到相关内容。',
      sources: [],
      degraded: true,
      reason: `向量最高分 ${vTop.toFixed(3)} < ${MIN_VECTOR}，关键词最高分 ${kTop.toFixed(3)} < ${MIN_KEYWORD}`,
      vTop,
      kTop,
      check: { cited: [], invalid: [], noCitation: false },
    };
  }

  // 给召回块编号（[1][2]…），既喂给模型，也用于溯源校验
  const sources = fused.map((h, i) => ({
    n: i + 1,
    title: h.title,
    account: h.account,
    publish: h.publish,
    url: h.url,
    doc_hash: h.doc_hash,
    chunk_index: h.chunk_index,
    is_summary: h.is_summary,
    vscore: h.vscore,
    kscore: h.kscore,
    rrf: h.rrf,
  }));

  const material = sources
    .map((s) => `[${s.n}] 《${s.title}》（${s.account} · ${s.publish}）\n${fused[s.n - 1].content}`)
    .join('\n\n');
  const userPrompt = `【资料】\n${material}\n\n【问题】\n${question}`;

  const key = apiKey || (await readDeepSeekKey());
  if (!key) throw new Error('未找到 DEEPSEEK_API_KEY（.env 或环境变量）');

  const res = await fetch(API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model: MODEL,
      temperature: 0, // 事实问答要稳，不要发挥
      max_tokens: 4000, // reasoning 从总额度扣，留足
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userPrompt },
      ],
    }),
  });
  const rawText = await res.text();
  if (!res.ok) throw new Error(`DeepSeek 调用失败 HTTP ${res.status}：${rawText.slice(0, 200)}`);

  const data = JSON.parse(rawText);
  const choice = data?.choices?.[0];
  const content = choice?.message?.content;
  // 🚨 截断层（W2 结论）：max_tokens 吃光则正文 0 字 —— 静默失败必须显式检查
  if (choice?.finish_reason === 'length') {
    throw new Error('模型输出被 max_tokens 截断（finish_reason=length），请重试');
  }
  if (typeof content !== 'string' || !content.trim()) {
    throw new Error('模型返回内容为空');
  }

  const answer = content.trim();

  // —— 防线②：溯源校验（代码层，不信模型自觉）——
  // 解析答案里出现的 [n]，与真实资料编号比对：越界 = 编造来源
  const cited = [...answer.matchAll(/\[(\d+)\]/g)].map((m) => Number(m[1]));
  const uniq = [...new Set(cited)];
  const invalid = uniq.filter((n) => n < 1 || n > sources.length);
  const usedSources = uniq.filter((n) => n >= 1 && n <= sources.length);

  return {
    answer,
    sources,
    degraded: false,
    reason: '',
    vTop,
    kTop,
    check: {
      cited: usedSources,
      invalid,                                  // 非空 = 模型编了不存在的来源
      noCitation: uniq.length === 0,            // true = 答案没标任何来源
      usage: data?.usage ?? null,
    },
  };
}

// —— CLI：端到端自测 ——
const isCli = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isCli) {
  const q = process.argv.slice(2).filter((a) => !a.startsWith('--')).join(' ').trim();
  if (!q) {
    console.error('用法：node ask.mjs "问题"');
    process.exit(1);
  }
  const t0 = Date.now();
  const r = await ask(q);
  console.log(`\nQ「${q}」`);
  console.log(`（向量最高 ${r.vTop.toFixed(3)} / 关键词最高 ${r.kTop.toFixed(3)} / ${Date.now() - t0}ms）\n`);
  if (r.degraded) {
    console.log(`⛔ 已降级：${r.answer}`);
    console.log(`   判据：${r.reason}`);
  } else {
    console.log(`A：${r.answer}\n`);
    console.log('来源：');
    for (const s of r.sources) {
      console.log(`  [${s.n}] ${s.title} — ${s.account} · ${s.publish}（v=${s.vscore?.toFixed(3) ?? '-'} k=${s.kscore?.toFixed(3) ?? '-'}）`);
    }
    console.log(`\n溯源校验：引用 [${r.check.cited.join(',') || '无'}]｜越界 [${r.check.invalid.join(',') || '无'}]${r.check.noCitation ? '｜⚠️ 答案未标来源' : ''}`);
  }
}
