// app/export-obsidian.mjs —— D1：把结构化卡片档案导出成 Obsidian 笔记
// 笔记 = frontmatter（type/tags/status/related + 双链）+ 卡片正文 + 标签
// 双重身份（沿 fetch-article.mjs 的做法）：
//   ① CLI：node export-obsidian.mjs <hash>       单篇
//          node export-obsidian.mjs --all         全部 + 生成索引
//          追加 --dry 只打印不写盘（样稿预览用）
//   ② 可复用模块：import { exportOne, exportAll } from './export-obsidian.mjs'
import fs from 'node:fs';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

// 路径锚在「本脚本所在目录」，从哪启动都不会写错地方（D4/D6 同款教训）
const DATA_DIR = fileURLToPath(new URL('./data/articles/', import.meta.url));

// vault 导出目标目录：默认写死，可用仓库根 .env 的 OBSIDIAN_DIR 覆盖
// 09-29：迁到树纹新建的独立知识库仓库；笔记按「收录月份」分子目录（长期不会堆成一层）
const DEFAULT_VAULT_DIR = 'D:/Knowledge_base/AI知识库/10-推文卡片';

// 索引笔记名（双链锚点：[[推文卡片索引]]）
const INDEX_NAME = '推文卡片索引';

// 索引落点：仓库根下的 MOC 目录（索引与数据分离 —— MOC 集中放各类索引，卡片区只放笔记）
const MOC_DIR_NAME = '50-MOC';

// 抓取缓存目录：原文全文从这里读（articles/ 只存卡片，不存全文）
const RAW_DIR = fileURLToPath(new URL('./data/raw/', import.meta.url));

// 读上一级 .env，解析成键值对；读不到就返回空对象（不是错误）
async function loadEnv() {
  let text = '';
  try {
    text = await readFile(new URL('../.env', import.meta.url), 'utf8');
  } catch {
    return {};
  }
  const env = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    env[line.slice(0, eq).trim()] = line.slice(eq + 1).trim().replace(/^(['"])(.*)\1$/, '$2');
  }
  return env;
}

// 解析出实际要写入的 vault 目录
async function resolveVaultDir() {
  const env = await loadEnv();
  return env.OBSIDIAN_DIR || DEFAULT_VAULT_DIR;
}

// 标题 → 合法文件名：Windows 非法字符统一换成短横 —— 直接删会把 "LangGraph/CrewAI"
// 粘成 "LangGraphCrewAI"（读不出来）；Obsidian 双链特殊字符删掉；折叠空白
// ⚠️ 文件名同时是双链锚点，索引里必须用同一个函数产出，两边才不会对不上
function safeName(title) {
  return (
    String(title || 'untitled')
      .replace(/[\\/:*?"<>|]/g, '-')
      .replace(/[#^[\]]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 80) || 'untitled'
  );
}

// YAML 字符串值统一加双引号：URL / 时间含冒号，不加会被 YAML 误读成嵌套结构
function yamlStr(v) {
  return '"' + String(v ?? '').replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

// 本地日期 YYYY-MM-DD（不用 toISOString：那是 UTC，会差一天）
function localDate() {
  return new Date().toLocaleDateString('sv-SE');
}

// 从已存在的 md 里读回 hash，用来判断「同名文件是不是同一篇文章」
function readHashFromFile(filePath) {
  try {
    const m = fs.readFileSync(filePath, 'utf8').match(/^hash:\s*"?([0-9a-f]{12})"?/m);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

// 数组 → markdown 列表；空数组给一句固定说明（占位规则：没有就说没有）
function bullet(arr, emptyText) {
  return Array.isArray(arr) && arr.length
    ? arr.map((x) => '- ' + x).join('\n')
    : emptyText;
}

// 生成一篇笔记的全文（纯函数，便于 --dry 预览与单测）
function buildNote(record, fullText = '') {
  const card = record.card || {};
  const created = String(record.savedAt || '').slice(0, 10);
  const qc = Array.isArray(record.quotesCheck) ? record.quotesCheck : [];

  // 金句区：带核验标记（✅ 逐字命中原文 / ❌ 模型改写）
  const quotesBody = qc.length
    ? qc.map((q) => '- ' + (q.verified ? '✅' : '❌（疑模型改写）') + ' 「' + q.quote + '」').join('\n')
    : '（原文没有合适的金句）';

  // 原文全文（树纹 09-29 要求保留）：折叠 callout；每行必须带 "> " 前缀才会在 callout 内渲染
  const fullBody = fullText
    ? ['> [!note]- 原文全文（点击展开）', ...fullText.split(/\r?\n/).map((l) => (l ? '> ' + l : '>'))].join('\n')
    : '> （本地缺 data/raw/ 抓取全文缓存，未附全文）';

  return [
    '---',
    'type: reference',
    'tags: [reference, wechat, 推文卡片]',
    'status: done',
    'created: ' + created,
    'source: ' + yamlStr(record.url),
    'account: ' + yamlStr(record.account),
    'author: ' + yamlStr(record.author),
    'publish: ' + yamlStr(record.publishTime),
    'hash: ' + record.hash,
    'related:',
    '  - "[[' + INDEX_NAME + ']]"',
    '  - "[[00-说明]]"',
    '---',
    '',
    '# ' + (record.title || '(无标题)'),
    '',
    '> 来源：' + (record.account || '') + ' ｜ 作者：' + (record.author || '') + ' ｜ 发布：' + (record.publishTime || ''),
    '> 原文：' + record.url,
    '> 收录：' + created + '（链藏 link-vault）',
    '',
    '## 摘要',
    '',
    card.summary || '（未提取）',
    '',
    '## 核心观点',
    '',
    bullet(card.points, '（原文没有）'),
    '',
    '## 金句（逐字核验）',
    '',
    quotesBody,
    '',
    '## 可执行要点',
    '',
    bullet(card.takeaways, '（原文没有）'),
    '',
    '## 原文全文',
    '',
    fullBody,
    '',
    '## 关联',
    '',
    '- [[' + INDEX_NAME + ']]',
    '- [[00-说明]]',
    '',
  ].join('\n');
}

// 生成索引笔记（MOC）：列出全部档案，条目双链名与文件名同源（safeName）
function buildIndex(records) {
  const sorted = [...records].sort((a, b) => String(b.savedAt || '').localeCompare(String(a.savedAt || '')));
  const items = sorted.length
    ? sorted
        .map((x) => '- [[' + safeName(x.title) + ']] —— ' + (x.account || '') + ' · ' + (x.publishTime || ''))
        .join('\n')
    : '（还没有导出任何文章）';
  return [
    '---',
    'type: moc',
    'tags: [moc, reference, 推文卡片]',
    'status: done',
    'created: ' + localDate(),
    'related:',
    '  - "[[00-说明]]"',
    '---',
    '',
    '# 推文卡片索引',
    '',
    '> 由链藏（link-vault）自动导出的微信公众号文章笔记索引。',
    '> 每一条对应 `15-参考项目/推文卡片/` 下的一篇笔记（frontmatter 含来源、发布时间与原文链接）。',
    '',
    '## 文章',
    '',
    items,
    '',
    '## 关联',
    '',
    '- [[00-说明]]',
    '',
  ].join('\n');
}

// 读一篇档案（articles/<hash>.json）——没有就抛错，让调用方给明确提示
function loadRecord(hash) {
  const file = path.join(DATA_DIR, hash + '.json');
  if (!fs.existsSync(file)) throw new Error('档案不存在：' + file);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

// 读抓取缓存里的原文全文（raw/<hash>.json）；缺失不算错，返回空串由调用方降级
function loadFullText(hash) {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(RAW_DIR, hash + '.json'), 'utf8'));
    return typeof raw.text === 'string' ? raw.text : '';
  } catch {
    return '';
  }
}

/**
 * 导出单篇：articles/<hash>.json → vault/<标题>.md
 * @param {string} hash 12 位档案 hash
 * @param {{dry?: boolean}} [opts] dry=true 只返回内容、不落盘
 * @returns {Promise<{hash, title, filePath, content, written}>}
 */
export async function exportOne(hash, opts = {}) {
  const record = loadRecord(hash);
  const vaultDir = await resolveVaultDir();
  // 按月分子目录（收录时间）：长期积累时不会把几十上百篇堆在同一层
  const monthDir = path.join(vaultDir, String(record.savedAt || '').slice(0, 7) || 'unknown');

  // 文件名 = 清洗后的标题；同名但属于另一篇文章时，加 hash 短后缀避免互相覆盖
  let base = safeName(record.title);
  let filePath = path.join(monthDir, base + '.md');
  const existingHash = fs.existsSync(filePath) ? readHashFromFile(filePath) : null;
  if (existingHash && existingHash !== record.hash) {
    base = base + '-' + record.hash.slice(0, 6);
    filePath = path.join(monthDir, base + '.md');
  }

  const content = buildNote(record, loadFullText(record.hash));
  if (!opts.dry) {
    fs.mkdirSync(monthDir, { recursive: true });
    fs.writeFileSync(filePath, content);
  }
  return { hash: record.hash, title: record.title, filePath, content, written: !opts.dry };
}

/**
 * 导出全部档案 + 重建索引笔记
 * @param {{dry?: boolean}} [opts]
 * @returns {Promise<{entries: Array, index: {filePath, content, written}}>}
 */
export async function exportAll(opts = {}) {
  const hashes = fs
    .readdirSync(DATA_DIR)
    .filter((f) => /^[0-9a-f]{12}\.json$/.test(f))
    .map((f) => f.replace(/\.json$/, ''));

  const entries = [];
  for (const h of hashes) entries.push(await exportOne(h, opts));

  const records = hashes.map((h) => loadRecord(h));
  const vaultDir = await resolveVaultDir();
  // 索引进「仓库根/50-MOC/」：索引与数据分离，MOC 目录集中放各类索引
  const mocDir = path.join(path.dirname(vaultDir), MOC_DIR_NAME);
  const index = {
    filePath: path.join(mocDir, INDEX_NAME + '.md'),
    content: buildIndex(records),
    written: !opts.dry,
  };
  if (!opts.dry) {
    fs.mkdirSync(mocDir, { recursive: true });
    fs.writeFileSync(index.filePath, index.content);
  }
  return { entries, index };
}

// —— CLI 入口：只有直接运行本文件时才执行 CLI 分支 ——
const isCli = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isCli) {
  const args = process.argv.slice(2);
  const dry = args.includes('--dry');
  const all = args.includes('--all');
  const hash = args.find((a) => /^[0-9a-f]{12}$/.test(a));

  try {
    if (all) {
      const { entries, index } = await exportAll({ dry });
      for (const e of entries) {
        console.log((e.written ? '✅ 已写入 ' : '📄 [dry] ') + e.filePath);
      }
      console.log((index.written ? '✅ 已写入 ' : '📄 [dry] ') + index.filePath);
      console.log(`共 ${entries.length} 篇` + (dry ? '（dry 模式：未落盘）' : ''));
    } else if (hash) {
      const r = await exportOne(hash, { dry });
      console.log((r.written ? '✅ 已写入 ' : '📄 [dry] ') + r.filePath);
      console.log('----- 笔记全文 -----');
      console.log(r.content);
    } else {
      console.error('用法：node export-obsidian.mjs <hash> [--dry] ｜ node export-obsidian.mjs --all [--dry]');
      process.exit(1);
    }
  } catch (err) {
    console.error('导出失败：' + err.message);
    process.exit(1);
  }
}
