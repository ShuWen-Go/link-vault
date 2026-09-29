# 链藏（link-vault）技术说明

> **用途**：一页看懂链藏的技术实现 —— 数据怎么流、存在哪、怎么实现、为什么这么选。
> **最后更新**：2026-09-29（S3 收口）
> **维护约定**：凡涉及**数据落点 / 模块组成 / 数据链路 / 存储结构 / 关键参数**的改动，**必须同步更新本文件**（对照文末「更新触发清单」）。
> ⚠️ **本文件有两份，改动需同步**：① 项目仓库 `link-vault/docs/TECH.md`（本文件，GitHub 可见）② 训练工作区 `docs/06-链藏技术说明.md`
> 配套图：`docs/app-arch.svg`（分层架构）｜进度与决策：训练工作区 `05-W5-S3智能增强-逐日清单.md`

---

## 0. 一句话数据流

```
贴链接 → index.html → server.mjs → fetch-article → DeepSeek → data/
       → export-obsidian → vault 笔记 → corpus → embed → rag-db → 可检索的索引
```

**读取侧**：`提问 → retrieve（双路召回 + RRF 融合）→ ask（带出处作答 + 三防线）→ 答案 + [1][2] 出处`

---

## 1. 系统分层与模块清单

| 层 | 文件 | 职责 |
|---|---|---|
| 前端层 | `index.html` | 用户界面：收录 / 历史 / 导出 / **问一问** |
| 服务层 | `server.mjs` | 路由 / 全局限流 / 静态托管 / 转发 LLM；把能力模块串成接口 |
| 能力层 | `fetch-article.mjs` | 抓正文 + 元数据 + 幂等缓存 |
| | `structure.mjs` | 强约束 prompt + 三层判据 + 模型调用（**规则只此一份**） |
| | `store.mjs` | 档案读写（`articles/` + `index.json`） |
| | `export-obsidian.mjs` | 卡片 + 全文 → Obsidian 笔记（含索引） |
| | `corpus.mjs` | 解析 vault 笔记 → 噪音清洗 → 结构感知切块 |
| | `embed.mjs` | 文本 → 向量（硅基流动 `Qwen3-Embedding-0.6B`，1024 维） |
| | `rag-db.mjs` | SQLite 存取（建表 / 读写 / 向量 BLOB 转换） |
| | `retrieve.mjs` | 双路检索 + RRF 融合 |
| | `ask.mjs` | 带出处作答 + 三重防幻觉 |
| 脚本 | `build-index.mjs` | 建索引（幂等） |
| | `ingest.mjs` | 批量入库（URL 列表 → 抓取 → 结构化 → 存档 → 导出） |
| | `eval.mjs` | 评测（10 题 × 三组对照） |

**共同约定**：每个能力模块都是「`node xxx.mjs` 命令行 + `import` 库」双身份；**零依赖**（`node:http` / `node:sqlite` / 内置 `fetch`）。

---

## 2. 完整数据链路

### 2.1 写入链路（一条链接 → 知识库 + 索引）

| 步 | 谁在干 | 数据变成什么 |
|---|---|---|
| ① 采集 | `fetch-article.mjs` | 微信 HTML → 定位 `#js_content` → 剥标签 / 表格转 md / 懒加载图回写 → 抽元数据 → **`data/raw/{hash}.json`**（原文全文，幂等缓存） |
| ② 结构化 | `structure.mjs` | 强约束 prompt（按字段填表）+ `temperature 0` → DeepSeek → 剥围栏解析 → 字段校验 → **金句逐字核验**（去空白子串比对）→ `data/articles/{hash}.json` + `index.json`（经 `store.mjs`） |
| ③ 交付 | `export-obsidian.mjs` | 卡片 + 原文全文 → **`AI知识库/10-推文卡片/{年月}/{标题}.md`**（frontmatter + 双链 + 折叠全文）＋ 索引写 `50-MOC/` |
| ④ 建索引 | `corpus.mjs` → `embed.mjs` → `rag-db.mjs` | 笔记 → 解析 → 清洗（5 条规则）→ 结构感知切块（每篇第 0 块 = 概要块）→ 向量化 → **`data/rag.sqlite`** |

> 整条写入链路可由 `ingest.mjs` 一次跑完（幂等可重跑）。

### 2.2 读取链路（一句提问 → 带出处的答案）

| 步 | 谁在干 | 做了什么 |
|---|---|---|
| ① 召回 | `retrieve.mjs` | **向量路**（余弦）+ **关键词路**（字符 bigram + **IDF 加权**）→ **RRF 融合** → top5 |
| ② 判定 | `ask.mjs` | 向量 ≥ 0.42 **或** 关键词 ≥ 0.85 才算"有依据"；否则**直接答"没找到"、不调模型** |
| ③ 作答 | `ask.mjs` | top5 编成 `[1][2]…` + 检索锁定 prompt → DeepSeek（temp 0）→ 答案带角标 |
| ④ 校验 | `ask.mjs` | 解析 `[n]` 与真实来源比对（**越界 = 编造**）+ 未标来源提示 |
| ⑤ 返回 | `server.mjs` | `answer` + `sources`（含两路分数）+ `check` → 前端渲染 |

**三防线**：检索锁定（prompt）· 溯源校验（代码）· 无匹配降级（阈值）。

---

## 3. 数据存储

### 3.1 三个落点

| 位置 | 路径 | 说明 |
|---|---|---|
| **本地（唯一真源）** | `D:\VibeCoding\link-vault\app\data\` | 见下方"目录内容" |
| **知识库** | `D:\Knowledge_base\AI知识库\` | 人读的笔记（`10-推文卡片/` + `50-MOC/`），**不是数据库** |
| **云端** | 沙箱容器内的同一份 `data/` | 随发布包上传，**只读用于问答**；重建索引只能在本地 |

**本地 `app/data/` 内容**：

| 文件 | 是什么 | 形态 |
|---|---|---|
| `raw/{hash}.json`（+ `.html`/`.txt`） | 抓取缓存（原文全文 + 元数据） | JSON 文件 |
| `articles/{hash}.json` | 结构化卡片档案 | JSON 文件 |
| `index.json` | 历史目录（列表页数据） | JSON 文件 |
| **`rag.sqlite`** | **向量索引 —— 唯一的"数据库"** | **SQLite 单文件** |
| `eval-result.json` | 评测原始结果 | JSON 文件 |

> **没有数据库服务器**：没有 MySQL / Milvus / Redis，就一个 `.sqlite` 文件（当前 **2.29 MB**）。

### 3.2 为什么 JSON 与 SQLite 各管一半

| 数据 | 用什么存 | 理由 |
|---|---|---|
| 抓取缓存 / 卡片档案 / 历史目录 | **JSON 文件** | 单条读写、**人可直接打开看**、调试方便、按 hash 命名天然幂等 |
| 向量索引 | **SQLite** | 几百条批量写入 + 二进制向量 + 按篇查询 —— 正好是纯文件存储不擅长的 |

### 3.3 `rag.sqlite` 内部结构

**实现方式**：Node **内置** `node:sqlite`（`DatabaseSync`），封装在 `app/rag-db.mjs`；写入由 `build-index.mjs` 驱动（**先清表再写**，幂等）；读取由 `retrieve.mjs` 全量载入内存算余弦（423 块规模下毫秒级）。

**只有一张表 `chunks`**：

```sql
CREATE TABLE chunks (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,   -- 自增主键
  doc_hash    TEXT NOT NULL,                       -- 属于哪篇文章
  chunk_index INTEGER NOT NULL,                    -- 是这篇文章的第几块
  is_summary  INTEGER NOT NULL DEFAULT 0,          -- 1 = 全篇概要块
  title       TEXT NOT NULL,                       -- ↓ 出处的原料
  account     TEXT, publish TEXT, url TEXT,        -- ↑ 答案标 [1][2] 靠这四个
  content     TEXT NOT NULL,                       -- 块正文（平均 473 字）
  dim         INTEGER NOT NULL,                    -- 恒为 1024（自查：换模型即过期）
  vector      BLOB NOT NULL                        -- Float32，固定 4096 字节 = 1024×4
);
CREATE INDEX idx_chunks_doc ON chunks(doc_hash);   -- 按文章快速捞块
```

**字段设计的三个用意**：① **身份三件套**（hash + index + is_summary）→ 唯一定位、按篇回捞、区分概要块；② **来源四件套** → 出处可溯源；③ **dim 自查字段** → 换 Embedding 模型时一查即知数据过期（避免"维度变了还拿旧向量检索"）。

### 3.4 为什么不用向量数据库（Milvus / Chroma / Pinecone）

| 判断 | 说明 |
|---|---|
| 当前规模 | 423 块 × 1024 维 ≈ 2 MB，内存全量算余弦几毫秒 |
| 向量库的代价 | 独立服务 + 部署运维 + 本地安装 —— 换来的性能用不上 |
| 何时才真需要 | 并发高 / 亿级向量 / 必须 ANN 索引（HNSW）时 |
| 附带好处 | 2.29 MB 文件可**随发布包走**，云端开箱即用 |

> 同一思路的延续：**4 篇不需要 RAG、423 块不需要向量库** —— 每步都用"当前规模"说服自己，而不是"别人都这么干"。

---

## 4. 关键实现方式（7 条）

| 设计 | 做法 | 为什么 |
|---|---|---|
| **零依赖** | `node:http` / `node:sqlite` / 内置 `fetch` | 云端不用 `npm install`，不会被依赖版本搞崩 |
| **能力层模块化** | 一段流水线一个文件，双身份（CLI + import） | 每段能单独跑单独验（`node corpus.mjs` 看切块） |
| **规则只有一份** | `structure.mjs` 抽出后，网页接口与批量入库共用 | 两份 prompt 必然各自漂移 |
| **幂等** | 抓取缓存 / 档案读档 / 建索引先清表 | 重跑安全；"能读档就不重算"省成本 + 防 LLM 不稳定 |
| **动态 import 隔离** | SQLite 链路（`rag-db` / `ask`）不静态引入 | 云端 Node 版本过低时只坏一个接口，**不拖垮服务启动** |
| **Key 只留服务端** | `.env` 仅被服务端读，响应不回传 | 前端永远拿不到 Key |
| **本地建索引、云端消费** | `data/` 随发布包上云（`.gitignore` 只挡 git） | 云端没有 vault；索引随包上传即可直接用 |

---

## 5. 运行与部署

| 项 | 值 |
|---|---|
| 本地跑 | `cd app && node server.mjs` → <http://localhost:3000> |
| 线上 | <https://liancang.app.workbuddy.host/>（WorkBuddy 发布；沙箱 `0a513d976dc74132b09103c28725c221`） |
| 密钥 | 仓库根 `.env`（`DEEPSEEK_API_KEY` / `SILICONFLOW_API_KEY`），**只被服务端读** |
| 云端环境 | Node **v22.13.1** / Linux / `node:sqlite` 可用（`GET /api/env` 可查） |
| 发布 | 每次**单独口令**；发布后必做云端复测（**本地过 ≠ 云端过**） |

**常用命令**（在 `app/` 下执行）：

```powershell
node ingest.mjs --file urls.txt   # 批量入库
node export-obsidian.mjs --all    # 全部导出到 vault
node build-index.mjs --check      # 建索引 + 相似度抽查
node retrieve.mjs "问题"           # 三路检索对比
node ask.mjs "问题"                # 端到端问答
node eval.mjs                     # 10 题三组对照评测
node corpus.mjs                   # 只看切块/清洗（零 API 消耗）
```

---

## 6. 当前实测参数（2026-09-29）

| 参数 | 值 | 备注 |
|---|---|---|
| 语料 | **14 篇 / 423 块**（14 个概要块） | 源：vault `AI知识库/10-推文卡片/` |
| 切块 | target 500 字 / overlap 回退 1 段 / 不切段落 | 实测选型见 README「选型过程」 |
| Embedding | `Qwen3-Embedding-0.6B` / **1024 维** | ⚠️ 8B 默认是 4096 维，换模型必须重建表 |
| 降级阈值 | 向量 ≥ **0.42** 或 关键词 ≥ **0.85** | **随语料变化必须重标** |
| 检索 | 每路 top5 → RRF 融合（K=60）→ top5 | |
| 数据库 | `rag.sqlite` **2.29 MB**，平均向量 4096 字节/块 | |
| 评测 | 无检索 0/8 · 关键词单路 1/8 · **双路 8/8** | 详见 `eval-10q.md` |
| 抓取缓存 | `raw/` 幂等命中 | 重复贴同链接零网络请求 |

---

## 7. 更新触发清单（改这些，就回来改本文件）

- [ ] **数据落点变了**（新增目录 / 改路径 / 换存储形式）→ 更新 §3.1、§3.2
- [ ] **数据库结构变了**（加字段 / 换表 / 换引擎）→ 更新 §3.3，并注明迁移方式
- [ ] **Embedding 模型或维度变了** → 更新 §6（**并提醒：向量表必须重建**）
- [ ] **模块增删或职责变化** → 更新 §1、§2
- [ ] **数据链路增减步骤** → 更新 §2.1 / §2.2
- [ ] **阈值 / 切块 / 检索参数调整** → 更新 §6
- [ ] **部署环境变化**（Node 版本 / 域名 / 沙箱）→ 更新 §5
- [ ] **语料规模变化** → 更新 §6（每行）
