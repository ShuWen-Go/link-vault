// app/store.mjs —— 数据层：结构化档案的读写（articles/<hash>.json 全量档案 + index.json 目录）
// 为什么独立成模块：HTTP 接口（server.mjs）与批量入库（ingest.mjs）都要写档案，
// 两处各写一份"去重 + 新条目排最前"的逻辑，迟早出现"网页入库的顺序和批量入库不一样"。
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

// 路径锚在「本脚本所在目录」，从哪启动都不会写错地方（D4/D6 同款教训）
export const DATA_DIR = fileURLToPath(new URL('./data/articles', import.meta.url));
export const INDEX_PATH = fileURLToPath(new URL('./data/index.json', import.meta.url));

// 读目录卡片盒；第一次用还没有文件就当空数组
export function loadIndex() {
  try {
    return JSON.parse(fs.readFileSync(INDEX_PATH, 'utf8'));
  } catch {
    return [];
  }
}

// 存档：全量写 articles/<hash>.json，目录写 index.json（同 hash 去重，新的排最前）
export function saveHistory(article, card, quotesCheck) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const record = {
    url: article.url,
    hash: article.hash,
    title: article.title,
    account: article.account,
    author: article.author,
    publishTime: article.publishTime,
    savedAt: new Date().toISOString(),
    card,
    quotesCheck,
  };
  fs.writeFileSync(`${DATA_DIR}/${article.hash}.json`, JSON.stringify(record, null, 2));

  const index = loadIndex().filter((x) => x.hash !== article.hash);
  index.unshift({
    hash: article.hash,
    url: article.url,
    title: article.title,
    account: article.account,
    publishTime: article.publishTime,
    summary: card.summary,
    savedAt: record.savedAt,
  });
  fs.writeFileSync(INDEX_PATH, JSON.stringify(index, null, 2));

  return record;
}

// 读一份档案（不存在抛错，让调用方给明确提示）
export function loadRecord(hash) {
  return JSON.parse(fs.readFileSync(`${DATA_DIR}/${hash}.json`, 'utf8'));
}
