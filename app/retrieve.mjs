// app/retrieve.mjs —— 检索层：向量路 + 关键词路 → RRF 融合
// 双重身份：
//   ① CLI：node retrieve.mjs ["问题"]   打印三路对比（向量 / 关键词 / 融合）
//   ② 模块：import { retrieve } —— D4 的 /api/ask 调用
import { pathToFileURL } from 'node:url';
import { embedTexts } from './embed.mjs';
import { openDb, allChunks } from './rag-db.mjs';

// 每路先各召回 TOP_K，融合后取 TOP_N
export const TOP_K = 5;
export const TOP_N = 5;
const RRF_K = 60; // RRF 平滑常数（论文默认值；越大越抹平头部优势）

// —— 余弦相似度（与 build-index.mjs 同款实现；函数极小，不值得为它再抽一层模块）——
function cosine(a, b) {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

// —— 字符 bigram：中文没有空格，用「相邻两字」当词，零依赖 ——
// 为什么不用分词库：违背零依赖红线；bigram 对中文召回够用，且对"广州地铁""MCP"这类专名敏感
function bigrams(s) {
  const t = String(s).replace(/[\s\p{P}\p{S}]/gu, '');
  const set = new Set();
  for (let i = 0; i < t.length - 1; i++) set.add(t.slice(i, i + 2));
  return set;
}

/**
 * 关键词路：bigram 覆盖率，**按 IDF 加权**
 * 为什么必须加权（实测踩坑）：朴素覆盖率下「深圳明天的天气怎么样」拿到 0.778 ——
 * 因为「明天 / 天气 / 怎么」这类**通用词**在语料里到处都是，覆盖率被灌水。
 * 加权后：通用词 idf 低、专有词（「1206.6」「MCP」）idf 高 ⇒ 只有**真实命中专有信息**才得高分。
 * 注意：分母只统计"查询里出现过的 bigram"的 df，比全量统计省事，效果一致。
 */
export function keywordSearch(question, rows, k = TOP_K) {
  const qg = [...bigrams(question)];
  if (!qg.length) return [];

  const idf = new Map();
  for (const g of qg) {
    let df = 0;
    for (const r of rows) if (r.grams.has(g)) df++;
    idf.set(g, Math.log((rows.length + 1) / (df + 1)));
  }
  const qTotal = qg.reduce((s, g) => s + idf.get(g), 0) || 1;

  return rows
    .map((r) => {
      let hit = 0;
      for (const g of qg) if (r.grams.has(g)) hit += idf.get(g);
      return { ...r, kscore: hit / qTotal };
    })
    .filter((r) => r.kscore > 0)
    .sort((a, b) => b.kscore - a.kscore)
    .slice(0, k);
}

/** 向量路：问题向量化 → 余弦 → top-K（擅长"意思近"） */
export async function vectorSearch(question, rows, k = TOP_K) {
  const [qv] = await embedTexts([question]);
  return rows
    .map((r) => ({ ...r, vscore: cosine(qv, r.vector) }))
    .sort((a, b) => b.vscore - a.vscore)
    .slice(0, k);
}

const keyOf = (r) => r.doc_hash + '#' + r.chunk_index;

/**
 * RRF（倒数排名融合）：score = Σ 1/(K + rank)
 * 为什么用 RRF 而不是加权平均：两路的分数**量纲不同**（余弦 0–1 vs 覆盖率 0–1，但分布完全不同），
 * 加权平均要先调权重、且权重说不清；RRF 只用"排名"，免调参、天然鲁棒。
 */
export function fuse(vHits, kHits, n = TOP_N) {
  const map = new Map();
  const add = (hit, rank, side) => {
    const key = keyOf(hit);
    const cur = map.get(key) || { ...hit, rrf: 0, vrank: null, krank: null, vscore: null, kscore: null };
    cur.rrf += 1 / (RRF_K + rank + 1);
    if (side === 'v') {
      cur.vrank = rank + 1;
      cur.vscore = hit.vscore;
    } else {
      cur.krank = rank + 1;
      cur.kscore = hit.kscore;
    }
    map.set(key, cur);
  };
  vHits.forEach((h, i) => add(h, i, 'v'));
  kHits.forEach((h, i) => add(h, i, 'k'));
  return [...map.values()].sort((a, b) => b.rrf - a.rrf).slice(0, n);
}

/**
 * 一站式检索：问题 → 双路召回 → RRF 融合
 * @returns {Promise<{fused: Array, vHits: Array, kHits: Array}>}
 */
export async function retrieve(question, { topK = TOP_K, topN = TOP_N } = {}) {
  const db = openDb();
  // 预计算每块的 bigram 集合（一次），避免关键词路反复切
  const rows = allChunks(db).map((r) => ({ ...r, grams: bigrams(r.content) }));
  db.close();

  const vHits = await vectorSearch(question, rows, topK);
  const kHits = keywordSearch(question, rows, topK);
  return { fused: fuse(vHits, kHits, topN), vHits, kHits };
}

// —— CLI：三路对比（判据：双路是否真的比单路好，不假设）——
const isCli = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isCli) {
  const asked = process.argv.slice(2).filter((a) => !a.startsWith('--')).join(' ').trim();
  const questions = asked
    ? [asked]
    : [
        'Embedding 和关键词搜索有什么区别？',
        '广州地铁昨天的客流有多少？',
        '怎么防止 AI 乱调用工具、造成风险？',
        'MCP 和 Skill 是什么关系？',
      ];

  const line = (tag, h) => {
    const kind = h.is_summary ? '[概要] ' : '';
    return `  ${tag}  ${kind}${h.title.slice(0, 24)} #${h.chunk_index}`;
  };

  for (const q of questions) {
    const { fused, vHits, kHits } = await retrieve(q);
    console.log(`\n===== Q「${q}」=====`);
    console.log('── 向量单路 top3 ──');
    for (const h of vHits.slice(0, 3)) console.log(line(h.vscore.toFixed(4), h));
    console.log('── 关键词单路 top3 ──');
    if (kHits.length) for (const h of kHits.slice(0, 3)) console.log(line(h.kscore.toFixed(4), h));
    else console.log('  （无命中：查询里的字组在语料中找不到）');
    console.log('── 双路 RRF top3 ──');
    for (const h of fused.slice(0, 3)) {
      const vs = h.vscore === null ? '-' : h.vscore.toFixed(4);
      const ks = h.kscore === null ? '-' : h.kscore.toFixed(4);
      console.log(`  rrf=${h.rrf.toFixed(4)} [v${h.vrank ?? '-'}/k${h.krank ?? '-'}] v=${vs} k=${ks}  ${h.is_summary ? '[概要] ' : ''}${h.title.slice(0, 24)} #${h.chunk_index}`);
    }
  }
}
