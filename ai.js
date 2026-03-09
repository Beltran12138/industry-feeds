const axios = require('axios');
require('dotenv').config();

const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY;
const API_URL = 'https://api.deepseek.com/chat/completions';

/**
 * 智能分类与摘要（DeepSeek V3）
 */
async function processWithAI(title, content = '') {
  if (!DEEPSEEK_API_KEY) {
    console.warn('[AI] No DeepSeek API Key found, skipping AI processing.');
    return null;
  }

  const prompt = `你是一个加密货币行业资深分析师。请对以下快讯进行分类和提炼。

快讯内容：
标题: ${title}
内容: ${content}

请输出一个 JSON 对象，包含以下字段，不要包含任何 Markdown 格式：
1. business_category: 必须从以下选项中选择一个：[合规, 监管, 政策, RWA, 稳定币/平台币, 交易/量化, 钱包/支付, toB/机构, 学院/社交/内容, 大客户/VIP, 法币兑换, 理财, 拉新/社媒/社群/pr, 投融资, 其他]
2. competitor_category: 必须从以下选项中选择一个：[香港合规所, 离岸所, 政策, 香港其他, 传统金融, 其他]
3. detail: 请用一句话（100字以内）总结该快讯的核心详情，文风要专业、干练，类似于周报中的 Bullet point。
4. is_important: 如果满足以下【任意一个】判定标准，请返回 1，否则返回 0：
   - 标准 1：是否和香港（HK）有关的消息（如政策、牌照、香港业务进展等）。
   - 标准 2：是否主流交易所（Binance, OKX, Bybit, HTX, Gate, Bitget等）的重大动作，但必须【排除】普通的上币（Listing）消息。重大动作包括：监管处罚、高层变动、重大产品升级、重大收购、地区牌照获取等。
   - 标准 3：是否香港合规交易所（如 HashKey, OSL 等）的任何官方消息。
   - 标准 4：其他对公司高层具有重大战略参考价值的消息。

示例格式：
{"business_category":"RWA","competitor_category":"香港合规所","detail":"HashKey Group 推出 RWA 一站式发行解决方案，面向发行方与中介机构赋能。","is_important":1}`;

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const response = await axios.post(API_URL, {
        model: 'deepseek-chat',
        messages: [{ role: 'user', content: prompt }],
        response_format: { type: 'json_object' },
        temperature: 0.1
      }, {
        headers: {
          'Authorization': `Bearer ${DEEPSEEK_API_KEY}`,
          'Content-Type': 'application/json'
        },
        timeout: 15000
      });

      const text = response.data?.choices?.[0]?.message?.content;
      if (!text) return null;

      return JSON.parse(text);
    } catch (err) {
      const status = err.response?.status;
      if (status === 429 && attempt < 3) {
        const wait = attempt * 8000;
        console.warn(`[AI] Rate limited, retrying in ${wait / 1000}s...`);
        await new Promise(r => setTimeout(r, wait));
      } else {
        console.error('[AI Error]:', err.response?.data?.error?.message || err.message);
        return null;
      }
    }
  }
}

/**
 * AI 生成日报总结
 * @param {Array} newsItems - 当日新闻条目（已过滤、已分类）
 * @returns {string|null} 日报总结文本
 */
async function generateDailySummary(newsItems) {
  if (!DEEPSEEK_API_KEY || newsItems.length === 0) return null;

  // 构建新闻摘要列表（限制长度避免 token 超限）
  const digest = newsItems.slice(0, 60).map((item, i) =>
    `${i + 1}. [${item.business_category || item.source}] ${item.title}${item.detail ? ' — ' + item.detail : ''}`
  ).join('\n');

  // 统计数据
  const sourceStats = {};
  newsItems.forEach(item => {
    sourceStats[item.source] = (sourceStats[item.source] || 0) + 1;
  });
  const topSources = Object.entries(sourceStats)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([s, c]) => `${s}(${c})`)
    .join('、');

  const prompt = `你现在是香港Web3领域的行业专家，负责 BitV（BitValve，正在申请 SFC VATP 牌照）的研究与规划。

今日行业动态：
${digest}

请撰写今日行业简报，结构如下（极度易读为原则）：

📅 **日期**: ${new Date().toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric' })}

📊 **总结论** (2-3句话，概括今日整体态势)

🔍 **分板块动态**
• **合规/监管**: [关键动态]
• **交易所**: [头部交易所动作]
• **香港市场**: [牌照与业务进展]
• **投融资**: [重要融资事件]

💡 **对 BitV 业务的启示** (重点! 1-2条具体可执行的建议)

📈 **今日数据**: 抓取 ${newsItems.length} 条 | 来源: ${topSources}

要求：
- 大量使用 **加粗** 高亮核心信息
- 短段落 +  bullet points
- 假设阅读者时间极其宝贵，一眼能抓住重点
- 总字数控制在 400 字以内
- 不要使用 Markdown 标题符号（#）`;

  try {
    const response = await axios.post(API_URL, {
      model: 'deepseek-chat',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.3,
      max_tokens: 1000
    }, {
      headers: {
        'Authorization': `Bearer ${DEEPSEEK_API_KEY}`,
        'Content-Type': 'application/json'
      },
      timeout: 30000
    });

    return response.data?.choices?.[0]?.message?.content?.trim() || null;
  } catch (err) {
    console.error('[AI DailySummary Error]:', err.response?.data?.error?.message || err.message);
    return null;
  }
}

/**
 * AI 生成周报总结 + 润色
 * @param {Array} newsItems -
 * @param {Object} stats 本周新闻条目 - 统计数据 {total, important, sources, categories}
 * @returns {string|null} 周报总结文本
 */
async function generateWeeklySummary(newsItems, stats = {}) {
  if (!DEEPSEEK_API_KEY || newsItems.length === 0) return null;

  // 按 business_category 分组统计
  const catGroups = {};
  newsItems.forEach(item => {
    const cat = item.business_category || '其他';
    if (!catGroups[cat]) catGroups[cat] = [];
    if (catGroups[cat].length < 8) {
      catGroups[cat].push(item.detail || item.title);
    }
  });

  let groupedDigest = '';
  for (const [cat, items] of Object.entries(catGroups)) {
    groupedDigest += `\n【${cat}】\n`;
    items.forEach((text, i) => {
      groupedDigest += `  ${i + 1}. ${text}\n`;
    });
  }

  // 统计数据
  const sourceCount = new Set(newsItems.map(n => n.source)).size;
  const importantCount = newsItems.filter(n => n.is_important === 1).length;
  
  const sourceStats = {};
  newsItems.forEach(item => {
    sourceStats[item.source] = (sourceStats[item.source] || 0) + 1;
  });
  const topSources = Object.entries(sourceStats)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([s, c]) => `${s}(${c})`)
    .join('、');

  // 计算本周起止日期
  const now = new Date();
  const weekStart = new Date(now);
  weekStart.setDate(now.getDate() - now.getDay() + 1);
  const weekEnd = new Date(now);
  weekEnd.setDate(now.getDate() + (7 - now.getDay()));
  const dateRange = `${weekStart.toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' })}-${weekEnd.toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' })}`;

  const prompt = `你现在是香港Web3领域的行业专家，负责 BitV（BitValve，正在申请 SFC VATP 牌照）的研究与规划。

本周行业动态分板块摘要：

${groupedDigest}

请撰写本周调研报告，结构如下（极度易读为原则）：

📅 **调研周期**: ${dateRange}

📊 **总结论** (3-4句话，概括本周整体趋势)

🔍 **分板块总结**
• **合规/监管**: [政策动向与监管动态]
• **交易所**: [头部交易所竞争格局]
• **香港市场**: [牌照申请与业务进展]
• **投融资**: [重要融资事件]

💡 **对 BitV 业务的思考** (重点! 3-5条具体可执行的建议，每条单独成段)

📈 **本周数据概览**
- 抓取: ${newsItems.length} 条
- 重要信号: ${importantCount} 条
- 来源: ${sourceCount} 个 (${topSources})

要求：
- 大量使用 **加粗** 高亮核心信息
- 短段落 + bullet points
- 假设阅读者时间极其宝贵，一眼能抓住重点
- 业务思考部分每条建议单独成段，便于快速浏览
- 总字数控制在 800 字以内
- 不要使用 Markdown 标题符号（#）`;

  try {
    const response = await axios.post(API_URL, {
      model: 'deepseek-chat',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.4,
      max_tokens: 2000
    }, {
      headers: {
        'Authorization': `Bearer ${DEEPSEEK_API_KEY}`,
        'Content-Type': 'application/json'
      },
      timeout: 45000
    });

    return response.data?.choices?.[0]?.message?.content?.trim() || null;
  } catch (err) {
    console.error('[AI WeeklySummary Error]:', err.response?.data?.error?.message || err.message);
    return null;
  }
}

module.exports = { processWithAI, generateDailySummary, generateWeeklySummary };
