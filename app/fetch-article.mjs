// app/fetch-article.mjs —— D2 抓取 v0：给 URL，出正文
// 用法：node fetch-article.mjs "<文章URL>"
import fs from 'node:fs';
import crypto from 'node:crypto';

const url = process.argv[2];
if (!url) {
  console.error('用法：node fetch-article.mjs "<文章URL>"');
  process.exit(1);
}

// ① 伪装成浏览器：身份由我们控制（这就是「自己派人去拿」）
const headers = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  Referer: 'https://mp.weixin.qq.com/',
};

// ② 服务端请求
const res = await fetch(url, { headers }); 
const html = await res.text();
console.log(`HTTP ${res.status} ｜ 原始 HTML ${html.length} 字符`);

// ③ 定位正文：#js_content（零依赖手写 div 配对，不用 cheerio）
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
const contentHtml = extractById(html, 'js_content');
if (!contentHtml) {
  console.error('没找到 #js_content —— 可能不是公众号文章页，或被风控页拦截');
  // 取证：拦截页也落盘，留证分析（D3 起为固定行为）
  fs.mkdirSync('data/raw', { recursive: true });
  const evidence = `data/raw/blocked-${Date.now()}.html`;
  fs.writeFileSync(evidence, html);
  console.error(`拦截页已存 → ${evidence}`);
  process.exit(1);
}

// ④ 剥 HTML → 纯文本（表格 v0 先不管，D3 处理）
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
const text = htmlToText(contentHtml);

// ⑤ 标题（v0 简版：只取 og:title；多重正则兜底 D3 再做）
const titleMatch = html.match(/<meta property="og:title" content="([^"]*)"/);
const title = titleMatch ? titleMatch[1] : '(未取到标题)';

// ⑥ 落盘：URL 哈希当文件名 —— D3 幂等缓存的伏笔
const hash = crypto.createHash('sha256').update(url).digest('hex').slice(0, 12);
fs.mkdirSync('data/raw', { recursive: true });
fs.writeFileSync(`data/raw/${hash}.html`, html);
fs.writeFileSync(`data/raw/${hash}.txt`, `标题：${title}\nURL：${url}\n\n${text}`);

console.log(`标题：${title}`);
console.log(`正文 ${text.length} 字 → data/raw/${hash}.txt`);
console.log('--- 正文前 300 字预览 ---');
console.log(text.slice(0, 300));