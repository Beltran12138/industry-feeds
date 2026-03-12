'use strict';
/**
 * ai.js — DeepSeek AI 处理模块（增强版）
 *
 * 改进点：
 *   1. 增加 batchClassify() — 周报生成前批量补充未分类条目
 *   2. generateWeeklySummary() 重写：先精选 top-30，再按竞品维度组织
 *   3. 所有配置从 config.js 读取
 */

const axios = require('axios');
const { BUSINESS_CATEGORIES, COMPETITOR_CATEGORIES, REPORT } = require('./config');
require('dotenv').config();

const API_KEY = process.env.DEEPSEEK_API_KEY;
const API_URL = 'https://api.deepseek.com/chat/completions';

const CAT_OPTIONS      = BUSINESS_CATEGORIES.join(', ');
const COMP_OPTIONS     = COMPETITOR_CATEGORIES.join(', ');

// ── 底层调用（含重试）─────────────────────────────────────────────────────────
async function callDeepSeek(messages, { temperature = 0.1, max_tokens = 2000, json = false } = {}) {
  if (!API_KEY) { console.warn('[AI] No DEEPSEEK_API_KEY, skipping.'); return null; }

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const payload = {
        model:       'deepseek-chat',
        messages,
        temperature,
        max_tokens,
      };
      if (json) payload.response_format = { type: 'json_object' };

      const res = await axios.post(API_URL, payload, {
        headers: { Authorization: `Bearer ${API_KEY}`, 'Content-Type': 'application/json' },
        timeout: 45000,
      });
      return res.data?.choices?.[0]?.message?.content?.trim() || null;
    } catch (err) {
      if (err.response?.status === 429 && attempt < 3) {
        const wait = attempt * 8000;
        console.warn(`[AI] Rate limit, retry in ${wait / 1000}s…`);
        await new Promise(r => setTimeout(r, wait));
      } else {
        console.error('[AI]', err.response?.data?.error?.message || err.message);
        return null;
      }
    }
  }
  return null;
}

// ── 单条新闻分类 ──────────────────────────────────────────────────────────────
async function processWithAI(title, content = '') {
  const prompt = `你是一个加密货币行业顶级战略分析师，专注于香港 Web3 监管与合规市场。
请对以下快讯进行深度分析。

快讯内容：
标题: ${title}
内容: ${content || '(无)'}

请输出 JSON 对象（不含 Markdown），包含：
1. business_category: 从 [${CAT_OPTIONS}] 中选一个
2. competitor_category: 从 [${COMP_OPTIONS}] 中选一个
3. detail: 一句话精炼总结（≤80字）
4. alpha_score: 0-100 的情报价值评分：
   - 90-100: 极高。涉及 SFC 政策突发变更、重要牌照获批/撤回、核心高管变动、主流交易所重大合规处罚。
   - 70-89: 高。香港市场重要业务进展、RWA/稳定币新规落地、头部所战略调整。
   - 40-69: 中。普通业务上线、常规行业新闻。
   - <40: 低。常规市场波动、KOL 言论、重复性快讯。
5. impact: "利好", "利空", 或 "中性"（站在香港合规所 BitV 的立场）
6. bitv_action: 针对此情报，BitV 应该采取的 1 条具体动作建议（如：对标分析、更新合规手册、调整公关话术等）

示例：{"business_category":"合规","competitor_category":"香港合规所","detail":"HashKey 获准向零售用户提供服务。","alpha_score":95,"impact":"利空","bitv_action":"立即调研其零售开户流程，评估对我司获客策略的冲击。"}`;

  const text = await callDeepSeek([{ role: 'user', content: prompt }], { json: true });
  if (!text) return null;
  try {
    const parsed = JSON.parse(text);
    // 向后兼容 is_important 字段，分值 >= 85 视为 1
    parsed.is_important = parsed.alpha_score >= 85 ? 1 : 0;
    return parsed;
  } catch (_) { return null; }
}

// ── 批量分类（周报前补充未分类条目）─────────────────────────────────────────
/**
 * 对多条 items 批量调用 AI 分类，返回 Map<index, aiResult>
 * 每次最多处理 10 条（控制 token 用量）
 */
async function batchClassify(items) {
  const resultMap = new Map();
  if (!items?.length) return resultMap;

  const BATCH = 10;
  for (let i = 0; i < items.length; i += BATCH) {
    const chunk   = items.slice(i, i + BATCH);
    const listStr = chunk.map((it, j) => `${i + j + 1}. 标题：${it.title} | 来源：${it.source}`).join('\n');

    const prompt  = `你是加密货币行业资深分析师。请对以下 ${chunk.length} 条快讯逐条分类。

${listStr}

请输出 JSON 数组（不含 Markdown），每个元素包含：
- idx: 原序号（从 ${i + 1} 开始）
- business_category: 从 [${CAT_OPTIONS}] 中选一个
- competitor_category: 从 [${COMP_OPTIONS}] 中选一个
- detail: ≤80字一句话摘要
- is_important: 0或1

示例：[{"idx":1,"business_category":"合规","competitor_category":"离岸所","detail":"...","is_important":1}]`;

    const text    = await callDeepSeek([{ role: 'user', content: prompt }], { json: true, temperature: 0.1 });
    if (!text) continue;

    try {
      const arr = JSON.parse(text);
      if (Array.isArray(arr)) {
        arr.forEach(r => {
          const origIdx = (r.idx || 0) - 1; // 转 0-indexed
          if (origIdx >= 0 && origIdx < items.length) {
            resultMap.set(origIdx, r);
          }
        });
      }
    } catch (_) { /* ignore parse error */ }

    if (i + BATCH < items.length) await new Promise(r => setTimeout(r, 2000));
  }

  return resultMap;
}

// ── 日报总结 ──────────────────────────────────────────────────────────────────
async function generateDailySummary(newsItems) {
  if (!API_KEY || !newsItems?.length) return null;

  const digest = newsItems.slice(0, REPORT.MAX_ITEMS_FOR_AI).map((item, i) =>
    `${i + 1}. [${item.business_category || item.source}] ${item.title}${item.detail ? ' — ' + item.detail : ''}`
  ).join('\n');

  const sourceStats  = {};
  newsItems.forEach(n => { sourceStats[n.source] = (sourceStats[n.source] || 0) + 1; });
  const topSources   = Object.entries(sourceStats).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([s, c]) => `${s}(${c})`).join('、');

  const today = new Date().toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric' });

  const prompt = `你是香港 Web3 行业专家，负责 BitV（BitValve，正在申请 SFC VATP 牌照）的研究规划。

今日行业动态（共 ${newsItems.length} 条）：
${digest}

请撰写今日行业简报（极度易读）：

📅 **日期**: ${today}

📊 **总结论** (2-3句，概括今日整体态势)

🔍 **分板块动态**
• **合规/监管**: [关键动态]
• **交易所**: [头部交易所动作]
• **香港市场**: [牌照与业务进展]
• **投融资**: [重要融资事件]

💡 **对 BitV 的启示** (1-2条具体可执行建议)

📈 **今日数据**: 抓取 ${newsItems.length} 条 | 来源: ${topSources}

要求：大量加粗高亮核心信息；短段落+bullet；总字数 ≤400 字；不用 # 号标题。`;

  return await callDeepSeek([{ role: 'user', content: prompt }], { temperature: 0.3, max_tokens: 1000 });
}

// ── 周报总结（重写：精选 + 竞品维度）────────────────────────────────────────
async function generateWeeklySummary(newsItems, stats = {}) {
  if (!API_KEY || !newsItems?.length) return null;

  // Step 1: 用 AI 精选本周最有战略价值的 TOP N 条
  const selectN   = REPORT.WEEKLY_SELECT_TOP;
  const selectList = newsItems.slice(0, 120).map((it, i) =>
    `${i + 1}. [${it.business_category || '?'}][${it.source}] ${it.title}${it.detail ? ' — ' + it.detail : ''}`
  ).join('\n');

  const selectPrompt = `你是 BitV 战略分析师。从以下本周行业动态中，精选出对 BitV（香港 SFC VATP 申请者）最具战略价值的 ${selectN} 条，用 JSON 数组返回序号列表。
只返回 JSON，格式：{"selected":[1,5,12,...]}

动态列表：
${selectList}`;

  let selectedIdxs  = [];
  const selectText = await callDeepSeek([{ role: 'user', content: selectPrompt }], { json: true, temperature: 0.2 });
  if (selectText) {
    try {
      const parsed = JSON.parse(selectText);
      selectedIdxs = (parsed.selected || []).map(n => n - 1).filter(n => n >= 0 && n < newsItems.length);
    } catch (_) { /* fallback: use top-N by is_important */ }
  }

  // 精选失败则退回：按 is_important 降序取前 N
  if (selectedIdxs.length < 5) {
    selectedIdxs = newsItems
      .map((it, i) => ({ i, score: (it.is_important || 0) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, selectN)
      .map(x => x.i);
  }

  const selectedItems = selectedIdxs.map(i => newsItems[i]).filter(Boolean);

  // Step 2: 按竞品维度组织摘要
  const hkItems    = selectedItems.filter(it => it.competitor_category === '香港合规所');
  const offshoreItems = selectedItems.filter(it => it.competitor_category === '离岸所');
  const policyItems   = selectedItems.filter(it => ['政策', '合规', '监管'].includes(it.business_category));
  const otherItems    = selectedItems.filter(it =>
    !hkItems.includes(it) && !offshoreItems.includes(it) && !policyItems.includes(it)
  );

  const fmt = (items) => items.map(it => `  - ${it.source}: ${it.detail || it.title}`).join('\n') || '  （本周暂无）';

  // 分类统计图（文本版）
  const catStat = {};
  newsItems.forEach(n => { const c = n.business_category || '其他'; catStat[c] = (catStat[c] || 0) + 1; });
  const catBar = Object.entries(catStat).sort((a, b) => b[1] - a[1]).slice(0, 10)
    .map(([c, n]) => `${c}: ${'█'.repeat(Math.min(n, 20))} ${n}`).join('\n');

  const importantCount = newsItems.filter(n => n.is_important === 1).length;
  const sourceCount    = new Set(newsItems.map(n => n.source)).size;
  const now            = new Date();
  const wStart         = new Date(now); wStart.setDate(now.getDate() - now.getDay() + 1);
  const wEnd           = new Date(now); wEnd.setDate(now.getDate() + (7 - now.getDay()));
  const dateRange      = `${wStart.toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' })}-${wEnd.toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' })}`;

  const prompt = `你是 BitV 战略分析师。请根据以下精选动态撰写本周调研简报。

【香港合规所动态】
${fmt(hkItems)}

【头部离岸所动态】
${fmt(offshoreItems)}

【政策/监管动态】
${fmt(policyItems)}

【其他重要信号】
${fmt(otherItems)}

请输出简报（极度易读）：

📅 **调研周期**: ${dateRange}

📊 **本周总结论** (3-4句，概括整体趋势)

🏆 **竞品格局**
• **香港合规所**（HashKey/OSL）: [本周动作]
• **头部离岸所**（OKX/Bybit/Gate/MEXC等）: [本周动作]
• **政策环境**: [监管趋势]

💡 **对 BitV 的战略建议** (3-5条，每条单独成段，具体可执行)

📊 **本周分类分布**
${catBar}

📈 **数据概览**: 共 ${newsItems.length} 条 | 重要信号 ${importantCount} 条 | ${sourceCount} 个来源

要求：大量加粗核心信息；短段落+bullet；总字数 ≤800 字；不用 # 号标题。`;

  return await callDeepSeek([{ role: 'user', content: prompt }], { temperature: 0.4, max_tokens: 2000 });
}

module.exports = { processWithAI, batchClassify, generateDailySummary, generateWeeklySummary };
