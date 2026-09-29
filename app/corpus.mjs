// app/corpus.mjs —— 语料层：vault 推文卡片（md）→ 解析 → 噪音清洗 → 结构感知切块
// 双重身份：
//   ① CLI：node corpus.mjs [--full]   打印解析/清洗/切块明细（供人工审阅，零成本）
//   ② 模块：import { loadCorpus, chunkText } —— build-index（D2）与检索层（D3/D4）调用
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// vault 推文卡片目录（D1 导出产物；与 export-obsidian.mjs 保持同一默认值）
const DEFAULT_VAULT_DIR = 'D:/Knowledge_base/AI Go/AI Go/15-参考项目/推文卡片';

// 切块参数（09-29 树纹确认：目标 500 字 / 块间回退 1 段做重叠）
export const CHUNK_TARGET = 500;
export const CHUNK_OVERLAP = 1;

// ========== ① 噪音清洗规则（保守优先：宁可少删，不可误删）==========
// 每条规则带名字，命中记明细 → 人工可审阅、可回滚（清洗最怕的是"悄悄删了正文"）

// 营销语用「组合短语」而非单词：单词匹配会被子串误伤。
// 实测案例：正文「我**现在看** WorkBuddy…」被单词规则里的「在看」命中 → 结论段被误删
const MARKETING_RES = [
  /欢迎(留言|评论|转发|点赞|在看)/,
  /(点个|点击|点亮|给个)(在看|赞)/,
  /扫码(领取|关注|参与|进群)/,
  /(领取|送|得).{0,8}(代金券|优惠券|福利|礼品|红包|名额)/,
  /(限席|限量|限时)名额/,
  /(抽奖|开奖|中奖)/,
  /关注.{0,8}(公众号|开发者号|我们)/,
  /(点赞|在看|转发).{0,4}(支持|鼓励|一下)/,
];

const NOISE_RULES = [
  { name: '图片行', test: (s) => /^!\[[^\]]*\]\(.*\)$/.test(s) },
  { name: '纯符号行', test: (s) => /^[\p{P}\p{S}\s]+$/u.test(s) },
  { name: '纯数字短行', test: (s) => /^\d{1,4}$/.test(s) },
  {
    name: '推广强特征',
    test: (s) => /(扫码关注|长按识别|点击上方|点击下方|星标公众号|置顶公众号|添加小助手|商务合作|投稿邮箱)/.test(s),
  },
  {
    // 只对「文档后 25%」生效：用位置换误删率（正文中段提到"扫码"多半是在讲内容）
    name: '文末营销语',
    tailOnly: true,
    test: (s) => MARKETING_RES.some((re) => re.test(s)),
  },
];

/**
 * 逐行清洗。返回保留行 + 命中明细（明细用于人工审阅规则是否过宽/过窄）
 * @param {string[]} lines
 */
export function cleanNoise(lines) {
  const kept = [];
  const dropped = [];
  lines.forEach((line, i) => {
    const pos = lines.length > 1 ? i / (lines.length - 1) : 1; // 0=开头，1=结尾
    const hit = NOISE_RULES.find((r) => (!r.tailOnly || pos > 0.75) && r.test(line));
    if (hit) dropped.push({ rule: hit.name, text: line });
    else kept.push(line);
  });
  return { kept, dropped };
}

// 卡片区的 markdown 标记清掉，让每条成为独立、可检索的语句
function stripCardMarkup(line) {
  let l = line.trim();
  if (!l) return '';
  l = l.replace(/^[-*]\s+/, '');                    // 列表符号
  l = l.replace(/^✅\s*/, '').replace(/^❌（疑模型改写）\s*/, ''); // 金句核验标记
  l = l.replace(/^「|」$/g, '');                     // 外层书名号
  return l.trim();
}

/**
 * 解析一篇 D1 生成的笔记
 * 笔记结构：frontmatter + `# 标题` + 卡片四段（摘要/核心观点/金句/可执行要点）+ `## 原文全文`(callout) + `## 关联`
 * @returns {{fm: object, title: string, cardParas: string[], fullParas: string[]}}
 */
export function parseNote(md) {
  // frontmatter：只取简单 `key: value`（related 这类嵌套字段本轮用不到）
  const fmMatch = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(md);
  const fm = {};
  if (fmMatch) {
    for (const line of fmMatch[1].split(/\r?\n/)) {
      const m = /^([A-Za-z_]+):\s*"?([^"]*?)"?\s*$/.exec(line);
      if (m) fm[m[1]] = m[2];
    }
  }
  const body = fmMatch ? md.slice(fmMatch[0].length) : md;

  const title = ((/^#\s+(.+)$/m.exec(body) || [null, ''])[1] || '').trim();

  // 按 `## ` 小节切分
  const sections = {};
  for (const part of body.split(/\r?\n##\s+/).slice(1)) {
    const nl = part.indexOf('\n');
    if (nl === -1) continue;
    sections[part.slice(0, nl).trim()] = part.slice(nl + 1);
  }

  // 卡片四段 → 句级段落
  const cardParas = [];
  for (const key of ['摘要', '核心观点', '金句（逐字核验）', '可执行要点']) {
    for (const raw of (sections[key] || '').split(/\r?\n/)) {
      const l = stripCardMarkup(raw);
      if (l) cardParas.push(l);
    }
  }

  // 原文全文 → 剥 callout 前缀（`> ` / `>`）
  const fullParas = [];
  for (const raw of (sections['原文全文'] || '').split(/\r?\n/)) {
    let l = raw.trim();
    if (!l || /^>\s*\[!note\]/.test(l)) continue; // 空行 / callout 标题行
    l = l.replace(/^>\s?/, '').trim();
    if (l) fullParas.push(l);
  }

  return { fm, title, cardParas, fullParas };
}

// 超长单段兜底：按句末标点切成不超过 target 的片段（罕见，但万字长文可能出现整段无换行）
function splitLongSegment(seg, target) {
  if (seg.length <= target) return [seg];
  const out = [];
  let buf = '';
  for (const part of seg.split(/(?<=[。！？；])/)) {
    if (buf.length + part.length > target && buf) {
      out.push(buf);
      buf = '';
    }
    buf += part;
  }
  if (buf) out.push(buf);
  return out;
}

/**
 * 结构感知切块：按段落聚合到目标长度，**绝不切断段落**；块间回退若干段做重叠
 * @param {string[]} lines 已清洗的段落数组
 */
export function chunkText(lines, { target = CHUNK_TARGET, overlap = CHUNK_OVERLAP } = {}) {
  const chunks = [];
  let buf = [];
  let len = 0;
  for (const p of lines) {
    if (len + p.length > target && buf.length) {
      chunks.push(buf.join('\n'));
      buf = buf.slice(-overlap); // 重叠：保留末尾段作为下一块开头
      len = buf.reduce((s, x) => s + x.length, 0);
    }
    buf.push(p);
    len += p.length;
  }
  if (buf.length) chunks.push(buf.join('\n'));
  return chunks;
}

/**
 * 读 vault 推文卡片 → 解析 → 清洗 → 切块
 * @param {string} [vaultDir]
 * @param {{cardMode?: 'block'|'merge'}} [opts]
 *   cardMode='block'（默认）：卡片段合并成「1 个概要块」放最前，全文单独切块
 *   cardMode='merge'：卡片段与全文段混在一起切（对照方案）
 * @returns {Array<{file,title,account,publish,hash,url,chunks:string[],dropped:Array}>}
 */
export function loadCorpus(vaultDir = DEFAULT_VAULT_DIR, { cardMode = 'block' } = {}) {
  const files = fs.readdirSync(vaultDir).filter((f) => f.endsWith('.md'));
  const docs = [];
  for (const f of files) {
    const note = parseNote(fs.readFileSync(path.join(vaultDir, f), 'utf8'));
    if (note.fm.type === 'moc') continue; // 索引笔记不进语料

    let chunks;
    let dropped;
    if (cardMode === 'block') {
      // 卡片是全文的浓缩：若拆散参与检索，会与全文块内容重复、抢占 top-N
      // （参考项目复盘的坑：给每块附加摘要 → 摘要块语义相似度天然最强 → 霸榜）
      const cardBlock = note.cardParas.join('\n');
      const r = cleanNoise(note.fullParas.flatMap((s) => splitLongSegment(s, CHUNK_TARGET)));
      dropped = r.dropped;
      chunks = [cardBlock, ...chunkText(r.kept)];
    } else {
      const r = cleanNoise([...note.cardParas, ...note.fullParas].flatMap((s) => splitLongSegment(s, CHUNK_TARGET)));
      dropped = r.dropped;
      chunks = chunkText(r.kept);
    }

    docs.push({
      file: f,
      title: note.title,
      account: note.fm.account || '',
      publish: note.fm.publish || '',
      hash: note.fm.hash || '',
      url: note.fm.source || '',
      chunks,
      dropped,
    });
  }
  return docs;
}

// —— CLI：预览解析/清洗/切块结果（供人工审阅，不写任何文件）——
const isCli = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isCli) {
  const full = process.argv.includes('--full');

  // 两种「卡片/全文关系」方案的块数对比（供选型）
  const sum = (x) => x.reduce((s, d) => s + d.chunks.length, 0);
  const a = loadCorpus(DEFAULT_VAULT_DIR, { cardMode: 'merge' });
  const b = loadCorpus(DEFAULT_VAULT_DIR, { cardMode: 'block' });
  console.log('=== 方案对比：卡片与全文的关系 ===');
  console.log(`  merge（卡片+全文混切）             : ${sum(a)} 块`);
  console.log(`  block（卡片独立 1 概要块 + 全文切块）: ${sum(b)} 块 = 概要块 ${b.length} + 全文块 ${sum(b) - b.length}\n`);

  const docs = b;
  console.log(`语料：${docs.length} 篇（来自 vault 推文卡片）\n`);
  let totalChunks = 0;
  let totalDropped = 0;
  for (const d of docs) {
    totalChunks += d.chunks.length;
    totalDropped += d.dropped.length;
    const lens = d.chunks.map((c) => c.length);
    const avg = Math.round(lens.reduce((a, b) => a + b, 0) / lens.length);
    console.log(`【${d.title}】`);
    console.log(`  ${d.account} · ${d.publish} · hash=${d.hash}`);
    console.log(`  块数 ${d.chunks.length}｜块长 min/avg/max = ${Math.min(...lens)}/${avg}/${Math.max(...lens)}｜清洗命中 ${d.dropped.length} 行`);
    for (const x of d.dropped.slice(0, 6)) console.log(`    ✂ [${x.rule}] ${x.text.slice(0, 46)}`);
    if (d.dropped.length > 6) console.log(`    ……（其余 ${d.dropped.length - 6} 条）`);
    console.log('');
  }
  console.log(`合计 ${totalChunks} 块｜清洗掉 ${totalDropped} 行\n`);

  // 抽样：块数最多那篇的第 1 / 中间 / 末块（看清洗后的边界质量）
  const longest = [...docs].sort((a, b) => b.chunks.length - a.chunks.length)[0];
  const cs = longest.chunks;
  console.log(`=== 块抽样【${longest.title}】共 ${cs.length} 块 ===`);
  const picks = full ? cs.map((_, i) => i) : [0, Math.floor(cs.length / 2), cs.length - 1];
  for (const i of picks) {
    console.log(`\n--- 第 ${i + 1} 块（${cs[i].length} 字）---`);
    console.log(full ? cs[i] : cs[i].slice(0, 400));
  }
}
