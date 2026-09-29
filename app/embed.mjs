// app/embed.mjs —— 向量化层：文本 → 向量（硅基流动 Qwen3-Embedding-0.6B / 1024 维）
// 双重身份：
//   ① CLI：node embed.mjs "一段文本"   打印维度/耗时（连通性自检，省额度）
//   ② 模块：import { embedTexts } —— build-index（D2）与检索层（D4）共用
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

// 模型与维度（09-29 实测锁定：0.6B = 1024 维 / 单条 239ms）
// 🚨 维度就是数据库的列宽：建表后再换模型 = 全表作废重建（参考项目复盘的血泪坑）
export const EMBED_MODEL = 'Qwen/Qwen3-Embedding-0.6B';
export const EMBED_DIM = 1024;

const API_URL = 'https://api.siliconflow.cn/v1/embeddings';
const BATCH = 16; // 单次请求条数上限（留余量，避免超平台限制）

// 读仓库根 .env（沿用 server.mjs 同款解析：.env 优先，环境变量回退）
async function loadKey() {
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
  return env.SILICONFLOW_API_KEY || process.env.SILICONFLOW_API_KEY || '';
}

/**
 * 批量向量化
 * @param {string[]} texts
 * @returns {Promise<number[][]>} 与输入等长、同序的向量数组
 */
export async function embedTexts(texts) {
  if (!Array.isArray(texts) || texts.length === 0) return [];
  const key = await loadKey();
  if (!key) throw new Error('未找到 SILICONFLOW_API_KEY：既不在仓库根 .env，也不在环境变量中');

  const out = [];
  for (let i = 0; i < texts.length; i += BATCH) {
    const slice = texts.slice(i, i + BATCH);
    const res = await fetch(API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({ model: EMBED_MODEL, input: slice }),
    });
    const raw = await res.text();
    if (!res.ok) {
      throw new Error(`Embedding 调用失败 HTTP ${res.status}：${raw.slice(0, 200)}`);
    }

    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      throw new Error(`Embedding 返回非 JSON：${raw.slice(0, 200)}`);
    }
    const list = data?.data;
    // 🚨 条数校验：批量接口最容易"静默少给"，不对就早失败（别等写库才发现缺向量）
    if (!Array.isArray(list) || list.length !== slice.length) {
      throw new Error(`返回条数不符：期望 ${slice.length}，实际 ${list?.length ?? 0}`);
    }

    // 按 index 回排（不假设服务端顺序）
    const ordered = new Array(slice.length);
    for (const item of list) ordered[item.index] = item.embedding;

    for (const v of ordered) {
      // 🚨 维度校验：与锁定维度不符说明模型变了 → 立刻报错（否则写入脏数据）
      if (!Array.isArray(v) || v.length !== EMBED_DIM) {
        throw new Error(`向量维度异常：期望 ${EMBED_DIM}，实际 ${v?.length}`);
      }
    }
    out.push(...ordered);
  }
  return out;
}

// —— CLI：连通性自检（只花 1 条额度）——
const isCli = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isCli) {
  const text = process.argv[2] || '向量化连通性自检';
  const t0 = Date.now();
  const [v] = await embedTexts([text]);
  console.log(`模型 ${EMBED_MODEL}`);
  console.log(`维度 ${v.length}｜耗时 ${Date.now() - t0}ms`);
  console.log(`向量前 5 位：${v.slice(0, 5).map((x) => x.toFixed(4)).join(', ')}`);
}
