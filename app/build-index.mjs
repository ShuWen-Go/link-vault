// app/build-index.mjs —— 建索引 CLI：corpus（切块）→ embed（向量）→ rag-db（落库）
// 用法：
//   node build-index.mjs            建索引（幂等：先清表再写）
//   node build-index.mjs --dry      只切块+向量化，不落库（省一次写盘）
//   node build-index.mjs --check    建完后跑相似度抽查（会多花几条 embedding 额度）
import { loadCorpus } from './corpus.mjs';
import { embedTexts, EMBED_MODEL, EMBED_DIM } from './embed.mjs';
import { openDb, initSchema, clearAll, insertChunk, countChunks, countDocs, allChunks, DB_PATH } from './rag-db.mjs';

const args = process.argv.slice(2);
const dry = args.includes('--dry');
const check = args.includes('--check');

// 余弦相似度（零依赖：语料小，直接全量算）
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

// ===== ① 语料 → 块（cardMode=block：第 0 块是概要块，其余是全文块）=====
const docs = loadCorpus();
const blocks = [];
for (const d of docs) {
  d.chunks.forEach((content, i) => {
    blocks.push({
      doc_hash: d.hash,
      title: d.title,
      account: d.account,
      publish: d.publish,
      url: d.url,
      chunk_index: i,
      is_summary: i === 0 ? 1 : 0,
      content,
    });
  });
}
console.log(`语料 ${docs.length} 篇 → ${blocks.length} 块（含 ${docs.length} 个概要块）`);

// ===== ② 向量化 =====
console.log(`向量化中（模型 ${EMBED_MODEL} / ${EMBED_DIM} 维）……`);
const t0 = Date.now();
const vectors = await embedTexts(blocks.map((b) => b.content));
console.log(`向量化完成：${vectors.length} 条，耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);

if (dry) {
  console.log('（--dry：未写库）');
  process.exit(0);
}

// ===== ③ 落库（幂等：先清表再写）=====
const db = openDb();
initSchema(db);
clearAll(db);
blocks.forEach((b, i) => insertChunk(db, { ...b, dim: EMBED_DIM, vector: vectors[i] }));
console.log(`写入 SQLite：${DB_PATH}`);
console.log(`库内：${countDocs(db)} 篇 / ${countChunks(db)} 块`);
db.close();

// ===== ④ 判据：相似度抽查（人工看是否命中正确篇目）=====
if (check) {
  const db2 = openDb();
  const rows = allChunks(db2);
  db2.close();

  const questions = [
    'Embedding 和关键词搜索有什么区别？',
    '广州地铁昨天的客流有多少？',
    '怎么防止 AI 乱调用工具、造成风险？',
  ];
  const qv = await embedTexts(questions);

  for (let qi = 0; qi < questions.length; qi++) {
    const scored = rows
      .map((r) => ({ ...r, score: cosine(qv[qi], r.vector) }))
      .sort((a, b) => b.score - a.score);
    console.log(`\nQ${qi + 1}「${questions[qi]}」`);
    for (const s of scored.slice(0, 3)) {
      console.log(`  ${s.score.toFixed(4)}  ${s.is_summary ? '[概要块] ' : ''}${s.title.slice(0, 24)} #${s.chunk_index}`);
    }
  }
}
