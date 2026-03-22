'use strict';
/**
 * ai-enhanced.js — AI 处理增强版（支持多提供商降级）
 *
 * 基于 ai.js 重构，集成 ai-provider.js 的多提供商支持
 */

const { callAI, ruleEngine, getStatus } = require('./ai-provider');
const { BUSINESS_CATEGORIES, COMPETITOR_CATEGORIES, REPORT } = require('./config');

const CAT_OPTIONS = BUSINESS_CATEGORIES.join(', ');
const COMP_OPTIONS = COMPETITOR_CATEGORIES.join(', ');

// ── 单条新闻分类（带降级）────────────────────────────────────────────────────
async function processWithAI(title, content = '', source = '', recentInsights = []) {
  const memoryStr = recentInsights.length > 0
    ? `【行业记忆 - 已记录趋势】：\n${recentInsights.map(i => `- ${i.trend_key}: ${i.summary}`).join('\n')}\n`
    : '';

  const prompt = `你是一个加密货币行业顶级战略分析师，专注于香港 Web3 监管与合规市场。
${memoryStr}
请对以下快讯进行深度分析。如果该快讯与已记录趋势相关，请在分析中明确指出（引证）。

快讯内容：
标题: ${title}
内容: ${content || '(无)'}
来源: ${source}

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
6. bitv_action: 针对此情报，BitV 应该采取的具体动作建议。如果与趋势相关，请体现。
7. trend_reference: 如果与已知趋势相关，填入对应 trend_key，否则留空。

示例：{"business_category":"合规","competitor_category":"香港合规所","detail":"...","alpha_score":95,"impact":"利空","bitv_action":"...","trend_reference":""}`;

  const text = await callAI([{ role: 'user', content: prompt }], { json: true });

  if (text) {
    try {
      // 增强 JSON 提取逻辑
      let cleanJson = text;
      if (text.includes('```')) {
        const match = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
        if (match) cleanJson = match[1];
      }

      const parsed = JSON.parse(cleanJson);

      // Validate required fields and types
      const validated = {
        business_category: typeof parsed.business_category === 'string' ? parsed.business_category : '其他',
        competitor_category: typeof parsed.competitor_category === 'string' ? parsed.competitor_category : '其他',
        detail: typeof parsed.detail === 'string' ? parsed.detail.slice(0, 200) : '',
        alpha_score: typeof parsed.alpha_score === 'number' ? Math.max(0, Math.min(100, Math.round(parsed.alpha_score))) : 50,
        impact: ['利好', '利空', '中性'].includes(parsed.impact) ? parsed.impact : '中性',
        bitv_action: typeof parsed.bitv_action === 'string' ? parsed.bitv_action.slice(0, 300) : '',
        trend_reference: typeof parsed.trend_reference === 'string' ? parsed.trend_reference : '',
      };
      validated.is_important = validated.alpha_score >= 85 ? 1 : 0;
      validated._ai_source = getStatus().currentProvider;
      return validated;
    } catch (e) {
      console.warn('[AI] Parse error, falling back to rule engine:', e.message);
    }
  }

  // 降级到规则引擎
  console.log('[AI] Using rule engine fallback for:', title.slice(0, 50));
  const ruleResult = ruleEngine.process(title, content, source);
  ruleResult._ai_source = 'rule_engine';
  return ruleResult;
}

// ── 批量分类（带降级）────────────────────────────────────────────────────────
async function batchClassify(items) {
  const resultMap = new Map();
  if (!items?.length) return resultMap;

  // 先检查 AI 服务状态
  const status = getStatus();
  const hasAI = status.providers.some(p => p.enabled && p.isActive);

  if (!hasAI) {
    console.log('[AI] No active AI provider, using rule engine for all items');
    items.forEach((item, idx) => {
      const result = ruleEngine.process(item.title, item.content, item.source);
      result._ai_source = 'rule_engine';
      resultMap.set(idx, result);
    });
    return resultMap;
  }

  const BATCH = 10;
  for (let i = 0; i < items.length; i += BATCH) {
    const chunk = items.slice(i, i + BATCH);
    const listStr = chunk.map((it, j) => `${i + j + 1}. 标题：${it.title} | 来源：${it.source}`).join('\n');

    const prompt = `你是加密货币行业资深分析师。请对以下 ${chunk.length} 条快讯逐条分类。

${listStr}

请输出 JSON 数组（不含 Markdown），每个元素包含：
- idx: 原序号（从 ${i + 1} 开始）
- business_category: 从 [${CAT_OPTIONS}] 中选一个
- competitor_category: 从 [${COMP_OPTIONS}] 中选一个
- detail: ≤80字一句话摘要
- is_important: 0或1

示例：[{"idx":1,"business_category":"合规","competitor_category":"离岸所","detail":"...","is_important":1}]`;

    const text = await callAI([{ role: 'user', content: prompt }], { json: true, temperature: 0.1 });

    if (text) {
      try {
        const arr = JSON.parse(text);
        if (Array.isArray(arr)) {
          arr.forEach(r => {
            const origIdx = (r.idx || 0) - 1;
            if (origIdx >= 0 && origIdx < items.length) {
              r._ai_source = status.currentProvider;
              resultMap.set(origIdx, r);
            }
          });
        }
      } catch (e) {
        console.warn('[AI] Batch parse error, using rule engine for chunk');
      }
    }

    // 未成功解析的使用规则引擎补充
    for (let j = 0; j < chunk.length; j++) {
      const idx = i + j;
      if (!resultMap.has(idx)) {
        const item = items[idx];
        const result = ruleEngine.process(item.title, item.content, item.source);
        result._ai_source = 'rule_engine';
        resultMap.set(idx, result);
      }
    }

    if (i + BATCH < items.length) await new Promise(r => setTimeout(r, 2000));
  }

  return resultMap;
}

// ── 日报总结（带降级）────────────────────────────────────────────────────────
async function generateDailySummary(newsItems) {
  if (!newsItems?.length) return null;

  const status = getStatus();
  const hasAI = status.providers.some(p => p.enabled);

  if (!hasAI) {
    return generateRuleBasedDailySummary(newsItems);
  }

  const digest = newsItems.slice(0, REPORT.MAX_ITEMS_FOR_AI).map((item, i) =>
    `${i + 1}. [${item.business_category || item.source}] ${item.title}${item.detail ? ' — ' + item.detail : ''}`,
  ).join('\n');

  const sourceStats = {};
  newsItems.forEach(n => { sourceStats[n.source] = (sourceStats[n.source] || 0) + 1; });
  const topSources = Object.entries(sourceStats).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([s, c]) => `${s}(${c})`).join('、');

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

  const result = await callAI([{ role: 'user', content: prompt }], { temperature: 0.3, max_tokens: 1000 });

  if (result) {
    return result + '\n\n*由 AI 生成*';
  }

  return generateRuleBasedDailySummary(newsItems);
}

// ── 规则引擎版日报 ──────────────────────────────────────────────────────────
function generateRuleBasedDailySummary(newsItems) {
  const today = new Date().toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric' });

  // 分类统计
  const catStats = {};
  const importantItems = [];

  newsItems.forEach(n => {
    const cat = n.business_category || '其他';
    catStats[cat] = (catStats[cat] || 0) + 1;
    if (n.is_important) importantItems.push(n);
  });

  // 来源统计
  const sourceStats = {};
  newsItems.forEach(n => { sourceStats[n.source] = (sourceStats[n.source] || 0) + 1; });
  const topSources = Object.entries(sourceStats).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([s, c]) => `${s}(${c})`).join('、');

  // 生成简报
  let summary = `📅 **日期**: ${today}\n\n`;
  summary += `📊 **总结论**: 今日共抓取 ${newsItems.length} 条情报，其中重要信号 ${importantItems.length} 条。`;

  if (importantItems.length > 0) {
    summary += `重点关注：${importantItems.slice(0, 3).map(i => i.source + '的' + i.business_category + '动态').join('、')}。`;
  }
  summary += '\n\n';

  summary += '🔍 **分板块动态**\n';
  Object.entries(catStats).sort((a, b) => b[1] - a[1]).slice(0, 5).forEach(([cat, count]) => {
    summary += `• **${cat}**: ${count} 条相关动态\n`;
  });

  if (importantItems.length > 0) {
    summary += '\n⚠️ **重要信号**:\n';
    importantItems.slice(0, 5).forEach(item => {
      summary += `• [${item.source}] ${item.title.slice(0, 50)}...\n`;
    });
  }

  summary += `\n📈 **今日数据**: 抓取 ${newsItems.length} 条 | 重要信号 ${importantItems.length} 条 | 来源: ${topSources}\n`;
  summary += '\n*（AI 服务暂不可用，此报告由规则引擎生成）*';

  return summary;
}

// ── 周报总结（带降级）────────────────────────────────────────────────────────
async function generateWeeklySummary(newsItems, stats = {}) {
  if (!newsItems?.length) return null;

  const status = getStatus();
  const hasAI = status.providers.some(p => p.enabled);

  if (!hasAI) {
    return generateRuleBasedWeeklySummary(newsItems, stats);
  }

  // Step 1: 精选 TOP N
  const selectN = REPORT.WEEKLY_SELECT_TOP;
  const selectList = newsItems.slice(0, 120).map((it, i) =>
    `${i + 1}. [${it.business_category || '?'}][${it.source}] ${it.title}${it.detail ? ' — ' + it.detail : ''}`,
  ).join('\n');

  const selectPrompt = `你是 BitV 战略分析师。从以下本周行业动态中，精选出对 BitV（香港 SFC VATP 申请者）最具战略价值的 ${selectN} 条，用 JSON 数组返回序号列表。
只返回 JSON，格式：{"selected":[1,5,12,...]}

动态列表：
${selectList}`;

  let selectedIdxs = [];
  const selectText = await callAI([{ role: 'user', content: selectPrompt }], { json: true, temperature: 0.2 });

  if (selectText) {
    try {
      const parsed = JSON.parse(selectText);
      selectedIdxs = (parsed.selected || []).map(n => n - 1).filter(n => n >= 0 && n < newsItems.length);
    } catch (e) {
      console.warn('[AI] Weekly select parse error');
    }
  }

  // 精选失败则退回
  if (selectedIdxs.length < 5) {
    selectedIdxs = newsItems
      .map((it, i) => ({ i, score: (it.is_important || 0) * 100 + (it.alpha_score || 0) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, selectN)
      .map(x => x.i);
  }

  const selectedItems = selectedIdxs.map(i => newsItems[i]).filter(Boolean);

  // Step 2: 按维度组织
  const hkItems = selectedItems.filter(it => it.competitor_category === '香港合规所');
  const offshoreItems = selectedItems.filter(it => it.competitor_category === '离岸所');
  const policyItems = selectedItems.filter(it => ['政策', '合规', '监管'].includes(it.business_category));
  const otherItems = selectedItems.filter(it =>
    !hkItems.includes(it) && !offshoreItems.includes(it) && !policyItems.includes(it),
  );

  const fmt = (items) => items.map(it => `  - ${it.source}: ${it.detail || it.title}`).join('\n') || '  （本周暂无）';

  const catStat = {};
  newsItems.forEach(n => { const c = n.business_category || '其他'; catStat[c] = (catStat[c] || 0) + 1; });
  const catBar = Object.entries(catStat).sort((a, b) => b[1] - a[1]).slice(0, 10)
    .map(([c, n]) => `${c}: ${'█'.repeat(Math.min(n, 20))} ${n}`).join('\n');

  const importantCount = newsItems.filter(n => n.is_important === 1).length;
  const sourceCount = new Set(newsItems.map(n => n.source)).size;
  const now = new Date();
  const wStart = new Date(now); wStart.setDate(now.getDate() - now.getDay() + 1);
  const wEnd = new Date(now); wEnd.setDate(now.getDate() + (7 - now.getDay()));
  const dateRange = `${wStart.toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' })}-${wEnd.toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' })}`;

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
• **香港合规所**（HashKey/OSL/Exio）: [本周动作]
• **头部离岸所**（OKX/Bybit/Gate/MEXC等）: [本周动作]
• **政策环境**: [监管趋势]

💡 **对 BitV 的战略建议** (3-5条，每条单独成段，具体可执行)

📊 **本周分类分布**
${catBar}

📈 **数据概览**: 共 ${newsItems.length} 条 | 重要信号 ${importantCount} 条 | ${sourceCount} 个来源

要求：大量加粗核心信息；短段落+bullet；总字数 ≤800 字；不用 # 号标题。`;

  const result = await callAI([{ role: 'user', content: prompt }], { temperature: 0.4, max_tokens: 2000 });

  if (result) {
    return result + '\n\n*由 AI 生成*';
  }

  return generateRuleBasedWeeklySummary(newsItems, stats);
}

// ── 规则引擎版周报 ──────────────────────────────────────────────────────────
function generateRuleBasedWeeklySummary(newsItems, stats = {}) {
  const now = new Date();
  const wStart = new Date(now); wStart.setDate(now.getDate() - now.getDay() + 1);
  const wEnd = new Date(now); wEnd.setDate(now.getDate() + (7 - now.getDay()));
  const dateRange = `${wStart.toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' })}-${wEnd.toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' })}`;

  // 分类统计
  const catStats = {};
  const competitorStats = {};
  const importantItems = [];

  newsItems.forEach(n => {
    const cat = n.business_category || '其他';
    const comp = n.competitor_category || '其他';
    catStats[cat] = (catStats[cat] || 0) + 1;
    competitorStats[comp] = (competitorStats[comp] || 0) + 1;
    if (n.is_important) importantItems.push(n);
  });

  const importantCount = importantItems.length;
  const sourceCount = new Set(newsItems.map(n => n.source)).size;

  let summary = `📅 **调研周期**: ${dateRange}\n\n`;

  summary += `📊 **本周总结论**: 本周共监控到 ${newsItems.length} 条行业情报，其中重要信号 ${importantCount} 条。`;

  // 找出最活跃的维度
  const topCompetitor = Object.entries(competitorStats).sort((a, b) => b[1] - a[1])[0];
  if (topCompetitor) {
    summary += `${topCompetitor[0]}方面动态最为活跃（${topCompetitor[1]}条）。`;
  }
  summary += '\n\n';

  summary += '🏆 **竞品格局**\n';

  // 香港合规所
  const hkItems = importantItems.filter(i => i.competitor_category === '香港合规所').slice(0, 3);
  summary += '• **香港合规所**（HashKey/OSL/Exio）:\n';
  if (hkItems.length > 0) {
    hkItems.forEach(i => summary += `  - ${i.source}: ${i.title.slice(0, 40)}...\n`);
  } else {
    summary += '  （本周暂无重要动态）\n';
  }

  // 离岸所
  const offshoreItems = importantItems.filter(i => i.competitor_category === '离岸所').slice(0, 3);
  summary += '• **头部离岸所**（OKX/Bybit/Gate等）:\n';
  if (offshoreItems.length > 0) {
    offshoreItems.forEach(i => summary += `  - ${i.source}: ${i.title.slice(0, 40)}...\n`);
  } else {
    summary += '  （本周暂无重要动态）\n';
  }

  // 政策
  const policyItems = importantItems.filter(i => ['政策', '合规', '监管'].includes(i.business_category)).slice(0, 3);
  summary += '• **政策环境**:\n';
  if (policyItems.length > 0) {
    policyItems.forEach(i => summary += `  - ${i.source}: ${i.title.slice(0, 40)}...\n`);
  } else {
    summary += '  （本周暂无重要动态）\n';
  }

  summary += '\n💡 **对 BitV 的战略建议**\n';
  summary += '• 持续关注香港合规所动态，评估竞争格局变化\n';
  summary += '• 跟踪监管政策走向，确保合规策略及时调整\n';
  summary += '• 分析头部离岸所业务创新，寻找差异化机会\n';

  summary += '\n📊 **本周分类分布**\n';
  Object.entries(catStats).sort((a, b) => b[1] - a[1]).slice(0, 8).forEach(([cat, count]) => {
    summary += `${cat}: ${'█'.repeat(Math.min(count, 20))} ${count}\n`;
  });

  summary += `\n📈 **数据概览**: 共 ${newsItems.length} 条 | 重要信号 ${importantCount} 条 | ${sourceCount} 个来源\n`;
  summary += '\n*（AI 服务暂不可用，此报告由规则引擎生成）*';

  return summary;
}

// ── 导出 ─────────────────────────────────────────────────────────────────────
module.exports = {
  processWithAI,
  batchClassify,
  generateDailySummary,
  generateWeeklySummary,
  getAIStatus: getStatus,
  ruleEngine,
  // 便捷重导出：调用方可直接从 ai-enhanced 获取 callAI，无需再引 ai-provider
  callAI,
};
