// app/ingest.mjs —— 批量入库：URL 列表 → 抓取 → 结构化 → 存档 → 导出 Obsidian
// 为什么需要它：网页一次只能贴一条；积累素材、扩语料时用得上（一次跑几十篇）
// 用法：
//   node ingest.mjs <url> [url2 ...]        命令行直接给 URL
//   node ingest.mjs --file urls.txt         从文件读（每行一条，# 开头为注释）
//   node ingest.mjs --file urls.txt --skip-export   只入档不导出
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { fetchArticle } from './fetch-article.mjs';
import { structureArticle, readDeepSeekKey } from './structure.mjs';
import { saveHistory, DATA_DIR } from './store.mjs';
import { exportOne } from './export-obsidian.mjs';

const args = process.argv.slice(2);
const skipExport = args.includes('--skip-export');
const fileIdx = args.indexOf('--file');

// ⚠️ 只有真的传了 --file 才需要排除它后面那个"文件名"参数；
// 否则 fileIdx = -1 会让 args[0] 被当成文件名排除掉 —— 第一个 URL 被静默吃掉，只剩"用法"提示
const fileArg = fileIdx !== -1 ? args[fileIdx + 1] : null;
let urls = args.filter((a) => !a.startsWith('--') && a !== fileArg);
if (fileIdx !== -1) {
  const txt = fs.readFileSync(args[fileIdx + 1], 'utf8');
  urls = urls.concat(
    txt.split(/\r?\n/).map((s) => s.trim()).filter((s) => s && !s.startsWith('#')),
  );
}
// 去重（同一批里重复贴同一条没有意义）
urls = [...new Set(urls)];

if (!urls.length) {
  console.error('用法：node ingest.mjs <url...> ｜ node ingest.mjs --file urls.txt [--skip-export]');
  process.exit(1);
}

const key = await readDeepSeekKey();
if (!key) {
  console.error('未找到 DEEPSEEK_API_KEY（仓库根 .env 或环境变量）');
  process.exit(1);
}

console.log(`批量入库：${urls.length} 篇\n`);

let added = 0;
let skipped = 0;
let failed = 0;

for (const [i, url] of urls.entries()) {
  const tag = `[${String(i + 1).padStart(2)}/${urls.length}]`;
  try {
    // ① 抓取（幂等缓存：抓过的零网络请求）
    const article = await fetchArticle(url);

    // ② 已有档案就跳过结构化（"能读档就不重算"——省 LLM 成本，也防 LLM 不稳定）
    const archived = `${DATA_DIR}/${article.hash}.json`;
    if (fs.existsSync(archived)) {
      console.log(`${tag} ⏭ 已有档案，跳过结构化（${article.hash}）`);
      skipped++;
    } else {
      const r = await structureArticle(article, { apiKey: key });
      saveHistory(article, r.card, r.quotesCheck);
      const okQ = r.quotesCheck.filter((q) => q.verified).length;
      console.log(`${tag} ✅ ${String(article.title).slice(0, 32)}`);
      console.log(`      金句核验 ${okQ}/${r.quotesCheck.length}｜finish=${r.finishReason}`);
      added++;
    }

    // ③ 导出 Obsidian（即使刚才是"跳过结构化"，也补导一次 —— 可能之前只入档没导出）
    if (!skipExport) {
      const e = await exportOne(article.hash);
      console.log(`      📄 ${e.filePath}`);
    }
  } catch (err) {
    console.error(`${tag} ❌ ${url}`);
    console.error(`      ${err.message}`);
    failed++;
  }
}

console.log(`\n完成：新增 ${added}｜跳过 ${skipped}｜失败 ${failed}`);
if (failed) console.log('（失败项可重跑本命令：抓取与档案都是幂等的）');
