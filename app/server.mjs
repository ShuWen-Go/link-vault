// 使用 Node 内置 http 模块自己起 HTTP 服务，不引入 Express 等第三方框架
import http from 'node:http';
// 使用 Node 内置 fs：同步读静态文件、异步读 .env
import fs from 'node:fs';
import { readFile } from 'node:fs/promises';
// 把 file:// URL 转成本机路径，方便拼静态文件路径（仍是 Node 内置，不是 npm 包）
import { fileURLToPath } from 'node:url';

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
