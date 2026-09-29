// app/rag-db.mjs —— 存储层：SQLite（Node 内置 node:sqlite，零依赖）存 chunks + 向量
// 为什么用内置 sqlite 而不是向量库：4 篇语料 / 单人使用，内存余弦足够；
// 引向量库是"用复杂度换不需要的性能"（何时才需要 Milvus：并发 / 亿级 / 需 ANN 索引）
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

// 数据文件锚在「本脚本所在目录」，从哪启动都不会写错地方
export const DB_PATH = fileURLToPath(new URL('./data/rag.sqlite', import.meta.url));

// 向量 ↔ BLOB：Float32 存（1024 维 = 4KB/块，比 JSON 小且无精度损失）
export function vecToBlob(vec) {
  return Buffer.from(new Float32Array(vec).buffer);
}

export function blobToVec(blob) {
  const u8 = blob instanceof Uint8Array ? blob : new Uint8Array(blob);
  // 复制到独立 ArrayBuffer：保证 4 字节对齐（直接用可能因 byteOffset 不对齐而抛错）
  const copy = new ArrayBuffer(u8.byteLength);
  new Uint8Array(copy).set(u8);
  return new Float32Array(copy);
}

export function openDb() {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  return new DatabaseSync(DB_PATH);
}

// 建表（幂等）：一个块一行；vector 与 dim 同时存 —— dim 用于自查"表里的向量是不是当前模型的"
export function initSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS chunks (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      doc_hash    TEXT    NOT NULL,
      title       TEXT    NOT NULL,
      account     TEXT,
      publish     TEXT,
      url         TEXT,
      chunk_index INTEGER NOT NULL,
      is_summary  INTEGER NOT NULL DEFAULT 0,
      content     TEXT    NOT NULL,
      dim         INTEGER NOT NULL,
      vector      BLOB    NOT NULL
    );
  `);
  db.exec('CREATE INDEX IF NOT EXISTS idx_chunks_doc ON chunks(doc_hash);');
}

// 幂等：重跑先清空（避免同一语料被索引两遍 —— "能读档就不重算"的反面）
export function clearAll(db) {
  db.exec('DELETE FROM chunks;');
}

export function insertChunk(db, c) {
  const stmt = db.prepare(`
    INSERT INTO chunks (doc_hash, title, account, publish, url, chunk_index, is_summary, content, dim, vector)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  stmt.run(
    c.doc_hash, c.title, c.account, c.publish, c.url,
    c.chunk_index, c.is_summary ? 1 : 0, c.content, c.dim, vecToBlob(c.vector),
  );
}

export function countChunks(db) {
  return db.prepare('SELECT COUNT(*) AS n FROM chunks').get().n;
}

export function countDocs(db) {
  return db.prepare('SELECT COUNT(DISTINCT doc_hash) AS n FROM chunks').get().n;
}

// 取全部块（含解析后的向量）—— D3 检索用；语料很小，全量载入内存即可
export function allChunks(db) {
  return db
    .prepare('SELECT doc_hash, title, account, publish, url, chunk_index, is_summary, content, dim, vector FROM chunks')
    .all()
    .map((r) => ({ ...r, is_summary: !!r.is_summary, vector: blobToVec(r.vector) }));
}
