// app/fetch-article.mjs —— D2 抓取 v0：给 URL，出正文
// 用法：node fetch-article.mjs "<文章URL>"
import fs from 'node:fs';
import crypto from 'node:crypto';

// 坑#7：URL 清洗（防御性：trim + 去零宽字符 + 只留合法 URL 字符）
function cleanUrl(raw) {
  return raw
    .trim()
    .replace(/[\u200B-\u200D\uFEFF\u2060]/g, '')
    .replace(/[^A-Za-z0-9\-._~:\/?#\[\]@!$&'()*+,;=%]/g, '');
}
const url = cleanUrl(process.argv[2]);
if (!url) {
  console.error('用法：node fetch-article.mjs "<文章URL>"');
  process.exit(1);
}

// 坑#4：幂等缓存 —— URL 哈希当文件名，本地已有就直接读档，不发请求
const hash = crypto.createHash('sha256').update(url).digest('hex').slice(0, 12);
const txtPath = `data/raw/${hash}.txt`;
if (fs.existsSync(txtPath)) {
  console.log(`⚡ 缓存命中 data/raw/${hash}.txt —— 本次零网络请求（幂等缓存生效）`);
  console.log(fs.readFileSync(txtPath, 'utf8').slice(0, 300));
  process.exit(0);
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

// ④ 剥 HTML → 纯文本（D2 原版，误删后补回）
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
let work = tablesToMarkdown(contentHtml);
// 坑#1：微信懒加载，真实地址在 data-src（先处理，避免 src 正则吃掉回写结果）
work = work.replace(/<img[^>]*?data-src="([^"]+)"[^>]*>/gi, '\n![图]($1)\n');
work = work.replace(/<img[^>]*?\ssrc="([^"]+)"[^>]*>/gi, '\n![图]($1)\n');
const text = htmlToText(work);


// ⑤ 元数据（D3：多重正则兜底；取不到标「未取到」，不许编）
function pick(h, patterns) {
  for (const re of patterns) {
    const m = h.match(re);
    if (m && m[1] && m[1].trim()) return m[1].trim().replace(/\s+/g, ' ');
  }
  return '(未取到)';
}
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

// ⑥ 落盘（hash 已在开头算好）：缓存里存的就是最终产物
fs.mkdirSync('data/raw', { recursive: true });
fs.writeFileSync(`data/raw/${hash}.html`, html);
fs.writeFileSync(txtPath,
  `标题：${title}\n公众号：${account}\n作者：${author}\n发布时间：${publishTime}\nURL：${url}\n\n${text}`);

console.log(`标题：${title}\n公众号：${account}\n作者：${author}\n发布时间：${publishTime}`);
console.log(`正文 ${text.length} 字 → ${txtPath}`);
console.log('--- 正文前 300 字预览 ---');
console.log(text.slice(0, 300));
