// 使用 Node 内置 http 模块自己起 HTTP 服务，不引入 Express 等第三方框架
import http from 'node:http';
// 使用 Node 内置 fs：同步读静态文件、异步读 .env
import fs from 'node:fs';
import { readFile } from 'node:fs/promises';
// 把 file:// URL 转成本机路径，方便拼静态文件路径（仍是 Node 内置，不是 npm 包）
import { fileURLToPath } from 'node:url';
// D4：复用 D2/D3 的抓取模块（含幂等缓存 + URL 清洗 + 元数据兜底）
import { fetchArticle } from './fetch-article.mjs';

// 相对「本脚本文件」定位上一级目录的 .env，而不是相对终端当前工作目录
// 这样无论你从哪一层文件夹执行 node server.mjs，都能找到仓库根目录的密钥文件
const envUrl = new URL('../.env', import.meta.url);
// 以 UTF-8 读出整个 .env 文本
const envText = await readFile(envUrl, 'utf8');

// 用来存放从 .env 解析出的键值对
const env = {};
// 按行拆分（兼容 Windows 的 \r\n 和 Unix 的 \n）
for (const rawLine of envText.split(/\r?\n/)) {
  // 去掉行首尾空白
  const line = rawLine.trim();
  // 跳过空行和 # 注释行
  if (!line || line.startsWith('#')) continue;
  // 找到第一个等号，左边是键、右边是值
  const eq = line.indexOf('=');
  // 没有等号的行不是合法配置，跳过
  if (eq === -1) continue;
  // 键名去掉空格
  const key = line.slice(0, eq).trim();
  // 值去掉空格，并去掉成对的单引号/双引号
  const value = line.slice(eq + 1).trim().replace(/^(['"])(.*)\1$/, '$2');
  // 写入解析结果
  env[key] = value;
}

// 取出 DeepSeek 密钥
const apiKey = env.DEEPSEEK_API_KEY;
// 启动时没有密钥就直接退出，避免后面每次请求都失败
if (!apiKey) {
  throw new Error('未在上一级目录的 .env 中找到 DEEPSEEK_API_KEY');
}

// 本脚本所在目录 = 静态文件根目录（打开 / 就会找到这里的 index.html）
const staticRoot = fileURLToPath(new URL('./', import.meta.url));

// 常见静态文件后缀对应的 Content-Type，浏览器靠它决定怎么渲染
const mimeTypes = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon',
};

// 根据文件名取出后缀，查 MIME；未知类型就当二进制下载
function getMime(filePath) {
  // 找到最后一个点，点后面就是扩展名
  const dot = filePath.lastIndexOf('.');
  // 没有扩展名时给一个通用二进制类型
  if (dot === -1) return 'application/octet-stream';
  // 转小写后查表，查不到同样回退到通用类型
  return mimeTypes[filePath.slice(dot).toLowerCase()] ?? 'application/octet-stream';
}

// 把 JSON 写回浏览器，并统一打一行访问日志
function sendJson(req, res, statusCode, body) {
  // 把对象序列化成 JSON 字符串
  const text = JSON.stringify(body);
  // 告诉浏览器：这是 JSON，编码是 UTF-8
  res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
  // 结束响应、发送正文
  res.end(text);
  // 每收到一次请求就打印：方法 + 路径 + 状态码，用来确认浏览器打到了这个后端
  console.log(`${req.method} ${req.url} ${statusCode}`);
}

// 把静态文件（或错误页）写回浏览器，同样打访问日志
function sendRaw(req, res, statusCode, contentType, body) {
  // 写出状态码和 Content-Type
  res.writeHead(statusCode, { 'Content-Type': contentType });
  // 结束响应
  res.end(body);
  // 终端日志：方法 + 路径 + 状态码
  console.log(`${req.method} ${req.url} ${statusCode}`);
}

// 从请求里把完整 body 读成字符串（http 模块不会自动拼好，要自己收 data 事件）
function readBody(req) {
  // 返回 Promise，方便后面用 await
  return new Promise((resolve, reject) => {
    // 用来拼接每一块数据
    const chunks = [];
    // 每来一块数据就推进数组
    req.on('data', (chunk) => {
      chunks.push(chunk);
    });
    // 收完后拼成一个完整 Buffer，再转成 UTF-8 文本
    req.on('end', () => {
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
    // 读流出错时把错误交给调用方
    req.on('error', reject);
  });
}

// 托管当前目录的静态文件；访问 / 时默认给 index.html
function serveStatic(req, res) {
  // 只取路径部分，丢掉 ?query
  // 🚨 畸形百分号编码（例如直接访问 /%）会让 decodeURIComponent 抛 URIError。
  // 而它是「同步」执行的 → 异常会冒泡出 createServer 的回调 → 整个 Node 进程直接退出。
  // 也就是说：一个乱敲的地址就能让后端崩掉。必须兜住，返回 400 而不是让进程死。
  let urlPath;
  try {
    urlPath = decodeURIComponent((req.url ?? '/').split('?')[0]);
  } catch {
    console.error('畸形 URL 编码，已拒绝：', req.url);
    sendRaw(req, res, 400, 'text/plain; charset=utf-8', 'Bad Request');
    return;
  }
  // 访问根路径时改成 index.html，这样打开 http://localhost:3000 就能看到页面
  const relative = urlPath === '/' ? '/index.html' : urlPath;
  // 用 URL 拼出目标文件，避免自己手写斜杠差异（Windows / Unix）
  const fileUrl = new URL('.' + relative, import.meta.url);
  // 转成本机绝对路径
  const filePath = fileURLToPath(fileUrl);
  // 防止用 ../ 跳出静态根目录去读别的文件（例如仓库根的 .env）
  if (!filePath.startsWith(staticRoot)) {
    sendRaw(req, res, 403, 'text/plain; charset=utf-8', 'Forbidden');
    return;
  }
  // 读文件；不存在就 404，其它错误当 500（细节只打在服务端）
  fs.readFile(filePath, (err, data) => {
    if (err) {
      // 文件不存在：给前端一句短提示即可
      if (err.code === 'ENOENT') {
        sendRaw(req, res, 404, 'text/plain; charset=utf-8', 'Not Found');
        return;
      }
      // 其它磁盘错误：完整原因只打在终端，不回给浏览器
      console.error(err);
      sendRaw(req, res, 500, 'text/plain; charset=utf-8', '服务器内部错误');
      return;
    }
    // 成功：按后缀设置 MIME，把文件内容原样返回
    sendRaw(req, res, 200, getMime(filePath), data);
  });
}

// ========== D4：结构化引擎 ==========
// system 模板来自 W2-D4 定论：「强约束 + temperature 0」= 把任务从自由生成改成按字段填表。
// ⚠️ 模板正文必须顶格写（行首空白会原样进 prompt），且不得含反引号 / ${
const SYSTEM_PROMPT = `【角色】
你是信息提取器。从用户给出的文章素材里提取信息，只输出一个 JSON 对象。

【只输出 JSON】
- 不要任何开场白、说明文字或结尾总结
- 不要用小标题、加粗、列表符号等 markdown 排版
- 不要用代码块标记把 JSON 包起来
- 输出的第一个字符必须是 {，最后一个字符必须是 }

【字段规范】必须包含且只包含这 4 个字段：
- summary：字符串。用一句话概括全文主旨，不超过 60 字。
- points：字符串数组。3 到 6 条核心观点或关键信息，每条不超过 30 字。
- quotes：字符串数组。从素材中【逐字摘录】最有代表性的话，不要改写、不要换词、不要增删标点；找不到合适的就给空数组。
- takeaways：字符串数组。读者可以直接照做的可执行要点；原文没有就给空数组。

【占位规则】
- 原文没写的信息就给空数组，不要根据常识或外部知识补充。
- 只依据素材本身提取，素材里没有的就是没有。

【书写要求】
- 键名和字符串值都用半角双引号
- 字符串内部不要换行；要分条就拆成数组元素`;

// 结构层判据（W2-D4 三层判据之①）：剥代码围栏 + JSON.parse
function checkJson(raw) {
  let t = String(raw).trim();
  const fenced = /^```/.test(t);
  t = t.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  try {
    return { ok: true, value: JSON.parse(t), fenced };
  } catch (err) {
    return { ok: false, message: err.message, fenced };
  }
}

// 轻量内容校验：四字段类型对不对（这是「按字段填表」，不是自由生成）
function checkCard(card) {
  if (!card || typeof card !== 'object') return '不是 JSON 对象';
  if (typeof card.summary !== 'string') return 'summary 缺失或不是字符串';
  for (const key of ['points', 'quotes', 'takeaways']) {
    if (!Array.isArray(card[key])) return key + ' 缺失或不是数组';
  }
  return null;
}

// 处理 POST /api/structure：URL → 抓取 → 强约束模板 → DeepSeek → 判据 → JSON 卡片
async function handleStructure(req, res) {
  let payload;
  try {
    const raw = await readBody(req);
    payload = JSON.parse(raw || '{}');
  } catch (err) {
    console.error(err);
    sendJson(req, res, 400, { error: '请求体不是合法 JSON' });
    return;
  }

  const url = typeof payload.url === 'string' ? payload.url : '';
  if (!url.trim()) {
    sendJson(req, res, 400, { error: 'url 不能为空' });
    return;
  }

  // ① 抓取（D2/D3 模块：幂等缓存命中则零网络请求）
  let article;
  try {
    article = await fetchArticle(url);
  } catch (err) {
    console.error('抓取失败：', err.message);
    sendJson(req, res, 502, { error: err.message });
    return;
  }

  // ② 拼 prompt：元数据 + 素材全文
  const userPrompt = `文章元数据：\n标题：${article.title}\n公众号：${article.account}\n发布时间：${article.publishTime}\n\n现在处理这篇文章的素材全文：\n${article.text}`;

  const startedAt = Date.now();
  try {
    const response = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: 'deepseek-v4-flash',
        temperature: 0, // 结构化字段名不能飘（W2-D4 定论）
        max_tokens: 4000, // reasoning 从总额度里扣（实测 0–563 重尾），太小会吃光正文
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: userPrompt },
        ],
      }),
    });

    const rawText = await response.text();
    const elapsed = Math.round(Date.now() - startedAt);

    if (!response.ok) {
      console.error('DeepSeek 请求失败', response.status, rawText);
      sendJson(req, res, 500, { error: '模型调用失败，请稍后重试' });
      return;
    }

    const data = JSON.parse(rawText);
    const choice = data?.choices?.[0];
    const content = choice?.message?.content;
    const finishReason = choice?.finish_reason;
    const usage = data?.usage ?? {};

    // 🚨 截断层（W2 结论）：max_tokens 吃光则正文 0 字——静默失败，必须显式检查
    if (finishReason === 'length') {
      console.error('输出被截断 finish_reason=length, usage=', usage);
      sendJson(req, res, 502, { error: '模型输出被 max_tokens 截断（finish_reason=length），请重试' });
      return;
    }
    if (typeof content !== 'string' || !content) {
      console.error('DeepSeek 响应缺少 content', data);
      sendJson(req, res, 500, { error: '模型返回字段不完整' });
      return;
    }

    // ③ 结构层判据：剥围栏 + parse
    const checked = checkJson(content);
    if (!checked.ok) {
      console.error('模型输出不是合法 JSON：', checked.message, '｜ 前 300 字：', content.slice(0, 300));
      sendJson(req, res, 502, { error: '模型输出不是合法 JSON', rawPreview: content.slice(0, 200) });
      return;
    }

    // ④ 字段类型校验
    const cardError = checkCard(checked.value);
    if (cardError) {
      console.error('卡片字段不完整：', cardError, '｜ 前 300 字：', content.slice(0, 300));
      sendJson(req, res, 502, { error: '卡片字段不完整：' + cardError, rawPreview: content.slice(0, 200) });
      return;
    }

    // ⑤ 成功：卡片 + 可观测 meta（缓存命中 / finish_reason / 围栏 / token 拆账 / 耗时）
    sendJson(req, res, 200, {
      card: checked.value,
      meta: {
        url: article.url,
        hash: article.hash,
        title: article.title,
        account: article.account,
        author: article.author,
        publishTime: article.publishTime,
        textLength: article.text.length,
        fromCache: article.fromCache,
        finishReason: finishReason ?? null,
        jsonFenced: checked.fenced,
        usage: {
          promptTokens: usage.prompt_tokens ?? null,
          completionTokens: usage.completion_tokens ?? null,
          reasoningTokens: usage.reasoning_tokens ?? null,
          totalTokens: usage.total_tokens ?? null,
        },
        elapsed,
      },
    });
  } catch (err) {
    console.error(err);
    sendJson(req, res, 500, { error: '转发请求失败，请稍后重试' });
  }
}

// 处理 POST /api/chat：校验 messages 后原样转发给 DeepSeek
async function handleChat(req, res) {
  // 用来装解析后的 JSON；声明在 try 外面方便校验
  let payload;
  try {
    // 先把原始 body 读出来
    const raw = await readBody(req);
    // 解析 JSON；格式不对会进 catch
    payload = JSON.parse(raw || '{}');
  } catch (err) {
    // 解析失败的细节只打服务端日志，前端只看短中文
    console.error(err);
    sendJson(req, res, 400, { error: '请求体不是合法 JSON' });
    return;
  }

  // 取出前端传来的 messages 数组
  const messages = payload.messages;
  // 必须是非空数组，否则 400；文案按作业要求固定
  if (!Array.isArray(messages) || messages.length === 0) {
    sendJson(req, res, 400, { error: 'messages 不能为空' });
    return;
  }

  // 记录转发开始时间，用来算 elapsed（毫秒整数）
  const startedAt = Date.now();
  try {
    // 用 Node 自带的 fetch 调用 DeepSeek Chat Completions
    const response = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // 密钥只出现在服务端发出的请求头里，永远不要写进前端 JS
        // 为什么必须放服务端：浏览器里的代码任何人都能「查看源代码」或打开开发者工具看到；
        // 密钥一旦进前端，就等于公开，别人能拿去刷你的额度。服务端转发时密钥只存在本机 .env，
        // 响应里也不回传密钥，前端只负责发 messages、展示 content。
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: 'deepseek-v4-flash', // 模型名固定，不让前端改
        temperature: 0, // 固定为 0，输出更稳定、便于对比 prompt
        max_tokens: 4000, // 固定上限，避免一次生成过长
        // 校验通过后把数组原样透传，不改写 role / content
        messages,
      }),
    });

    // 先把 DeepSeek 响应读成文本，避免对方返回非 JSON 时二次崩溃
    const rawText = await response.text();
    // 转发耗时：当前时间减开始时间，取整毫秒
    const elapsed = Math.round(Date.now() - startedAt);

    // HTTP 不是 2xx：完整原文只打 console.error，前端只给一句中文
    if (!response.ok) {
      console.error('DeepSeek 请求失败', response.status, rawText);
      sendJson(req, res, 500, { error: '模型调用失败，请稍后重试' });
      return;
    }

    // 解析 DeepSeek 的 JSON
    let data;
    try {
      data = JSON.parse(rawText);
    } catch (err) {
      console.error('DeepSeek 返回了无法解析的正文', err, rawText);
      sendJson(req, res, 500, { error: '模型返回格式异常' });
      return;
    }

    // 取出模型回复正文
    const content = data?.choices?.[0]?.message?.content;
    // 取出本次总 token
    const totalTokens = data?.usage?.total_tokens;
    // 缺关键字段时同样不把原始响应丢给前端
    if (typeof content !== 'string' || typeof totalTokens !== 'number') {
      console.error('DeepSeek 响应缺少 content 或 total_tokens', data);
      sendJson(req, res, 500, { error: '模型返回字段不完整' });
      return;
    }

    // 成功：只返回作业要求的三个字段
    sendJson(req, res, 200, { content, elapsed, totalTokens });
  } catch (err) {
    // 网络超时、DNS 失败等：堆栈只打服务端，前端一句中文
    console.error(err);
    sendJson(req, res, 500, { error: '转发请求失败，请稍后重试' });
  }
}

// 创建 HTTP 服务器：按方法和路径分流
const server = http.createServer((req, res) => {
  // 只取路径，去掉 query，方便和 /api/chat 精确比较
  const pathname = (req.url ?? '/').split('?')[0];

  // 结构化接口：只接受 POST（D4）
  if (pathname === '/api/structure') {
    if (req.method !== 'POST') {
      sendJson(req, res, 400, { error: '请使用 POST 调用 /api/structure' });
      return;
    }
    handleStructure(req, res);
    return;
  }

  // 聊天接口：只接受 POST
  if (pathname === '/api/chat') {
    if (req.method !== 'POST') {
      sendJson(req, res, 400, { error: '请使用 POST 调用 /api/chat' });
      return;
    }
    // 异步处理；内部的错误已经自己 catch 并回包
    handleChat(req, res);
    return;
  }

  // 其它路径：只提供静态文件（GET/HEAD）；HEAD 按 GET 读文件但浏览器本来就可能不带 body
  if (req.method === 'GET' || req.method === 'HEAD') {
    serveStatic(req, res);
    return;
  }

  // 既不是聊天接口也不是静态 GET
  sendJson(req, res, 400, { error: '不支持的请求' });
});

// 监听端口抽成常量：日志文案跟着它走。
// 否则将来改了端口、日志还在报旧端口 —— 又一处「看起来对了 ≠ 实际对了」。
const PORT = 3000;

// 第二个参数 127.0.0.1 表示只本机可访问，密钥不会暴露到局域网
server.listen(PORT, '127.0.0.1', () => {
  console.log(`本地后端已启动：http://localhost:${PORT}`);
  console.log('打开上述地址即可看到当前目录的 index.html；POST /api/chat 会转发到 DeepSeek');
});
