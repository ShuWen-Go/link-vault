// app/eval.mjs —— D5 评测：10 题 × 三组对照（无检索 / 关键词单路 / 双路 RAG）
// 用法：node eval.mjs
// 判据：语料内题 —— 答案没降级 且 出处落在期望篇目；语料外题 —— 正确降级（不硬答）
import fs from 'node:fs';
import { ask } from './ask.mjs';

// 8 题语料内（expect = 期望命中的篇目标题关键词）+ 2 题语料外（expect = null，期望降级）
const CASES = [
  { id: 1, q: 'Embedding 和关键词搜索有什么区别？', expect: ['Embedding'] },
  { id: 2, q: 'Embedding 检索上线前要问清哪些问题？', expect: ['Embedding'] },
  { id: 3, q: 'Agent 自进化飞轮的四个环节是什么？', expect: ['飞轮'] },
  { id: 4, q: '确定性 Harness 有哪几个设计要点？', expect: ['Harness'] },
  { id: 5, q: 'LangGraph 和 CrewAI 怎么选？', expect: ['多 Agent'] },
  { id: 6, q: '让 AI 调用本地 Skill 有哪些风险？', expect: ['Skill'] },
  { id: 7, q: 'Jev 是什么？为什么要从大模型里拆出来？', expect: ['Jev'] },
  { id: 8, q: '广州地铁 9 月 24 日的客运量是多少？', expect: ['地铁'] },
  { id: 9, q: '深圳明天的天气怎么样', expect: null },
  { id: 10, q: '红烧肉怎么做才好吃', expect: null },
];

const MODES = [
  ['none', 'A 无检索(基线)'],
  ['keyword', 'B 关键词单路'],
  ['hybrid', 'C 双路 RAG'],
];

const rows = [];
for (const c of CASES) {
  for (const [mode, label] of MODES) {
    const t0 = Date.now();
    let r;
    try {
      r = await ask(c.q, { mode });
    } catch (e) {
      r = { answer: 'ERROR: ' + e.message, degraded: false, sources: [], check: {} };
    }
    const ms = Date.now() - t0;

    let verdict;
    if (c.expect) {
      const hit = (r.sources || []).some((s) => c.expect.some((k) => String(s.title).includes(k)));
      verdict = r.degraded ? '误降级' : hit ? '正确' : '出处不符';
    } else {
      verdict = r.degraded ? '正确降级' : '未降级';
    }

    rows.push({
      id: c.id,
      q: c.q,
      expect: c.expect,
      mode,
      label,
      ms,
      verdict,
      answer: r.answer,
      cited: r.check?.cited ?? [],
      noCitation: !!r.check?.noCitation,
      sources: (r.sources || []).map((s) => s.title),
    });
    console.log(`[${String(c.id).padStart(2)}] ${label.padEnd(14)} ${verdict.padEnd(6)} ${String(ms).padStart(5)}ms  ${String(r.answer).slice(0, 46).replace(/\n/g, ' ')}`);
  }
  console.log('');
}

console.log('===== 汇总（✓ = 答案正确 或 正确降级）=====');
for (const [mode, label] of MODES) {
  const rs = rows.filter((r) => r.mode === mode);
  const ok = rs.filter((r) => r.verdict === '正确' || r.verdict === '正确降级').length;
  const ins = rs.filter((r) => r.expect);
  const okIns = ins.filter((r) => r.verdict === '正确').length;
  console.log(`${label.padEnd(14)} 总 ${ok}/${rs.length}｜语料内出处正确 ${okIns}/${ins.length}`);
}

fs.mkdirSync(new URL('./data/', import.meta.url), { recursive: true });
fs.writeFileSync(new URL('./data/eval-result.json', import.meta.url), JSON.stringify(rows, null, 2));
console.log('\n原始结果：app/data/eval-result.json');
