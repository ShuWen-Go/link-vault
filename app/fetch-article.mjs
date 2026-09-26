// app/fetch-article.mjs —— 抓取模块（D3 加固版，D4 重构为「可复用模块 + CLI 壳」）
// 双重身份：
//   ① 命令行工具：node fetch-article.mjs "<文章URL>"
//   ② 可复用模块：server.mjs 里 import { fetchArticle } 调用（D4 起）
import fs from 'node:fs';
import crypto from 'node:crypto';
import { pathToFileURL, fileURLToPath } from 'node:url';

// 数据目录相对「本脚本文件」定位，不依赖终端当前工作目录
// （否则从仓库根跑 node app/server.mjs 时，data/ 会建错位置）
const RAW_DIR = fileURLToPath(new URL('./data/raw/', import.meta.url));

// 坑#7：URL 清洗（防御性：trim + 去零宽字符 + 只留合法 URL 字符）
export function cleanUrl(raw) {
  return raw
    .trim()
    .replace(/[\u200B-\u200D\uFEFF\u2060]/g, '')
    .replace(/[^A-Za-z0-9\-._~:\/?#\[\]@!$&'()*+,;=%]/g, '');
}

// 伪装成浏览器：身份由我们控制（这就是「自己派人去拿」）
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  Referer: 'https://mp.weixin.qq.com/',
};

// 坑#6：元数据多重正则兜底；取不到标「未取到」，不许编
function pick(h, patterns) {
  for (const re of patterns) {
    const m = h.match(re);
    if (m && m[1] && m[1].trim()) return m[1].trim().replace(/\s+/g, ' ');
  }
  return '(未取到)';
}

// 定位正文：#js_content（零依赖手写 div 配对，不用 cheerio）
function extractById(h, idValue) {
  const idPos = h.indexOf(`id="${idValue}"`);
  if (idPos === -1) return null;
  const openStart = h.lastIndexOf('<div', idPos);
  const start = h.indexOf('>', openStart) + 1;
  const re = /<div\b|<\/div>/g;
  re.lastIndex = start;
  let depth = 1, m;
  while ((m = re.exec(h)) !== null) {
    depth += m[0] === '</div>' ? -1 : 1;
    if (depth === 0) return h.slice(start, m.index);
  }
  return null;
}

// 坑#6：表格 → Markdown（零依赖手写，放最前：先消费掉 <table> 再剥其余标签）
function tablesToMarkdown(h) {
  return h.replace(/<table[\s\S]*?<\/table>/gi, (table) => {
    const rows = [...table.matchAll(/<tr[\s\S]*?<\/tr>/gi)].map((tr) => {
      const cells = [...tr[0].matchAll(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/gi)]
        .map((c) => c[1]
          .replace(/<[^>]+>/g, '')
          .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
          .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
          .replace(/\s+/g, ' ').trim() || ' ');
      return '| ' + cells.join(' | ') + ' |';
    });
    if (rows.length === 0) return '';
    const cols = Math.max(rows[0].split('|').length - 2, 1);
    rows.splice(1, 0, '|' + ' --- |'.repeat(cols));
    return '\n' + rows.join('\n') + '\n';
  });
}

// 剥 HTML → 纯文本
function htmlToText(h) {
  return h
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|h\d|li|section|tr)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n\s*/g, '\n\n')
    .trim();
}

/**
 * 抓取一篇文章（含坑#4 幂等缓存）
 * 缓存粒度 = 最终产物：data/raw/<hash>.json 存结构化元数据 + 正文
 * @param {string} rawUrl 用户粘贴的原始 URL（内部会先清洗）
 * @returns {Promise<{url,hash,title,account,author,publishTime,text,fromCache}>}
 */
export async function fetchArticle(rawUrl) {
  const url = cleanUrl(rawUrl);
  if (!url) throw new Error('URL 为空');

  // 坑#4：URL 哈希当文件名，本地已有就直接读档，不发请求
  const hash = crypto.createHash('sha256').update(url).digest('hex').slice(0, 12);
  const jsonPath = `${RAW_DIR}${hash}.json`;
  if (fs.existsSync(jsonPath)) {
    const cached = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
    console.log(`⚡ 缓存命中 ${jsonPath} —— 本次零网络请求（幂等缓存生效）`);
    return { ...cached, fromCache: true };
  }

  // ① 服务端请求
  const res = await fetch(url, { headers: HEADERS });
  const html = await res.text();
  console.log(`HTTP ${res.status} ｜ 原始 HTML ${html.length} 字符`);

  // ② 定位正文；找不到 = 可能被风控页拦截
  const contentHtml = extractById(html, 'js_content');
  if (!contentHtml) {
    // 取证：拦截页也落盘，留证分析（D3 起为固定行为）
    fs.mkdirSync(RAW_DIR, { recursive: true });
    const evidence = `${RAW_DIR}blocked-${Date.now()}.html`;
    fs.writeFileSync(evidence, html);
    console.error(`没找到 #js_content，拦截页已存 → ${evidence}`);
    throw new Error('没找到正文：可能不是公众号文章页，或被风控页拦截（拦截页已落盘取证）');
  }

  // ③ 表格转 MD → 懒加载图片回写 → 剥 HTML
  let work = tablesToMarkdown(contentHtml);
  // 坑#1：微信懒加载，真实地址在 data-src（先处理，避免 src 正则吃掉回写结果）
  work = work.replace(/<img[^>]*?data-src="([^"]+)"[^>]*>/gi, '\n![图]($1)\n');
  work = work.replace(/<img[^>]*?\ssrc="([^"]+)"[^>]*>/gi, '\n![图]($1)\n');
  const text = htmlToText(work);

  // ④ 元数据
  const title = pick(html, [
    /<meta property="og:title" content="([^"]*)"/,
    /id="activity-name"[^>]*>([\s\S]*?)<\/h1>/,
  ]);
  const account = pick(html, [
    /var nickname = htmlDecode\("([^"]+)"\)/,
    /var nickname = "([^"]+)"/,
    /class="profile_nickname"[^>]*>([^<]+)</,
  ]);
  const author = pick(html, [
    /var author = htmlDecode\("([^"]+)"\)/,
    /var author = "([^"]+)"/,
  ]);
  const publishTime = pick(html, [
    /var createTime = '([^']+)'/,
    /var createTime = "([^"]+)"/,
    /id="publish_time"[^>]*>([^<]+)</,
    /property="article:published_time" content="([^"]*)"/,
  ]);

  const article = { url, hash, title, account, author, publishTime, text };

  // ⑤ 落盘：json 给程序读（幂等缓存），html/txt 给人看
  fs.mkdirSync(RAW_DIR, { recursive: true });
  fs.writeFileSync(`${RAW_DIR}${hash}.html`, html);
  fs.writeFileSync(jsonPath, JSON.stringify(article, null, 2));
  fs.writeFileSync(`${RAW_DIR}${hash}.txt`,
    `标题：${title}\n公众号：${account}\n作者：${author}\n发布时间：${publishTime}\nURL：${url}\n\n${text}`);

  return { ...article, fromCache: false };
}

// —— CLI 入口：只有直接 `node fetch-article.mjs` 运行本文件时才执行 ——
// （被 server.mjs import 时这段跳过，不会误抢命令行参数）
const isCli = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isCli) {
  const rawArg = process.argv[2];
  if (!rawArg) {
    console.error('用法：node fetch-article.mjs "<文章URL>"');
    process.exit(1);
  }
  try {
    const a = await fetchArticle(rawArg);
    console.log(`标题：${a.title}\n公众号：${a.account}\n作者：${a.author}\n发布时间：${a.publishTime}`);
    console.log(`正文 ${a.text.length} 字 ${a.fromCache ? '（来自缓存）' : '（新抓取）'}`);
    console.log('--- 正文前 300 字预览 ---');
    console.log(a.text.slice(0, 300));
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}
