const { db } = require('./db');
const { filterNewsItems } = require('./filter');
const { generateDailySummary, generateWeeklySummary } = require('./ai');
const { sendReportToWeCom } = require('./wecom');
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const USE_SUPABASE = process.env.USE_SUPABASE === 'true';
let supabase = null;
if (USE_SUPABASE && process.env.SUPABASE_URL && process.env.SUPABASE_KEY) {
  supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
}

/**
 * 从 Supabase 或本地 SQLite 查询新闻（用于报告生成）
 * 优先 Supabase（GitHub Actions 环境无持久化 SQLite）
 */
async function fetchNewsForReport(since) {
  if (USE_SUPABASE && supabase) {
    const { data, error } = await supabase
      .from('news')
      .select('*')
      .gte('timestamp', since)
      .order('is_important', { ascending: false })
      .order('timestamp', { ascending: false })
      .limit(500);
    if (error) {
      console.error('[Report] Supabase query error:', error.message);
      return [];
    }
    return data || [];
  }
  // 本地 SQLite fallback
  return db.prepare('SELECT * FROM news WHERE timestamp > ? ORDER BY is_important DESC, timestamp DESC LIMIT 500').all(since);
}

// 业务分类排序
const CATEGORY_ORDER = [
  '合规', '监管', '政策', 'RWA', '稳定币/平台币', '交易/量化',
  '钱包/支付', 'toB/机构', '学院/社交/内容', '大客户/VIP',
  '法币兑换', '理财', '拉新/社媒/社群/pr', '投融资', '其他'
];

/**
 * 获取当天北京时间零点的 UTC 时间戳
 */
function getTodayMidnightBJ() {
  const now = new Date();
  const bjNow = new Date(now.getTime() + 8 * 60 * 60 * 1000);
  return Date.UTC(bjNow.getUTCFullYear(), bjNow.getUTCMonth(), bjNow.getUTCDate(), -8, 0, 0, 0);
}

/**
 * 获取本周一北京时间零点的 UTC 时间戳
 */
function getWeekStartBJ() {
  const now = new Date();
  const bjNow = new Date(now.getTime() + 8 * 60 * 60 * 1000);
  const day = bjNow.getUTCDay();
  const diff = day === 0 ? 6 : day - 1; // 周一为一周起始
  return Date.UTC(bjNow.getUTCFullYear(), bjNow.getUTCMonth(), bjNow.getUTCDate() - diff, -8, 0, 0, 0);
}

/**
 * 格式化日期为 YYYY-MM-DD (北京时间)
 */
function formatDateBJ(timestamp) {
  const d = new Date(timestamp + 8 * 60 * 60 * 1000);
  return d.toISOString().split('T')[0];
}

/**
 * 构建数据统计面板文本
 */
function buildStatsPanel(items, period = '今日') {
  const total = items.length;
  const important = items.filter(i => i.is_important === 1).length;
  const sources = new Set(items.map(i => i.source)).size;
  const categories = new Set(items.filter(i => i.business_category).map(i => i.business_category)).size;
  const withDetail = items.filter(i => i.detail && i.detail.length > 5).length;

  return `📊 **${period}数据概览**
> 抓取 **${total}** 条 | 重要 **${important}** 条 | AI 分析 **${withDetail}** 条
> 来源 **${sources}** 个 | 分类 **${categories}** 个板块`;
}

// ===================================================================
//  日报
// ===================================================================

/**
 * 生成日报并推送到企业微信
 * @param {boolean} dryRun - true 则只打印不推送
 */
async function runDailyReport(dryRun = false) {
  console.log('[DailyReport] Generating daily report...');

  const todayStart = getTodayMidnightBJ();
  const dateStr = formatDateBJ(Date.now());

  // 查询当天所有新闻（不过滤 sent_to_wecom：日报是全天汇总摘要，即时推送过的也要包含）
  const rawRows = await fetchNewsForReport(todayStart);

  // 数据清洗
  const rows = filterNewsItems(rawRows);

  if (rows.length === 0) {
    console.log('[DailyReport] No news found for today.');
    return;
  }

  console.log(`[DailyReport] Found ${rows.length} items (raw: ${rawRows.length})`);

  // 统计面板
  const statsPanel = buildStatsPanel(rows, '今日');

  // 构建分类内容
  const importantItems = rows.filter(
    i => i.is_important === 1 && i.detail && i.detail.length > 5
  );
  const categorized = {};
  importantItems.forEach(item => {
    const cat = item.business_category || '其他';
    if (!categorized[cat]) categorized[cat] = [];
    categorized[cat].push(item);
  });

  // 按预设顺序排列
  const sortedCats = Object.keys(categorized).sort((a, b) =>
    CATEGORY_ORDER.indexOf(a) - CATEGORY_ORDER.indexOf(b)
  );

  // 构建新闻列表部分
  let newsList = '';
  sortedCats.forEach(cat => {
    const items = categorized[cat];
    newsList += `\n**${cat}** (${items.length})\n`;
    items.forEach((item, idx) => {
      const comp = item.competitor_category ? ` \`${item.competitor_category}\`` : '';
      newsList += `${idx + 1}. ${item.title}${comp}\n`;
      if (item.detail) {
        newsList += `> ${item.detail}\n`;
      }
    });
  });

  // 如果没有重要新闻有 AI detail，使用所有有 detail 的
  if (newsList.trim().length === 0) {
    const withDetail = rows.filter(i => i.detail && i.detail.length > 5).slice(0, 20);
    withDetail.forEach((item, idx) => {
      newsList += `${idx + 1}. **[${item.business_category || item.source}]** ${item.title}\n`;
      if (item.detail) newsList += `> ${item.detail}\n`;
    });
  }

  // AI 生成总结
  console.log('[DailyReport] Generating AI summary...');
  const allForAI = rows.filter(i => i.detail || i.is_important === 1);
  const aiSummary = await generateDailySummary(allForAI.length > 0 ? allForAI : rows.slice(0, 30));

  // 组装最终报告
  let report = `📋 **Alpha-Radar 行业日报 | ${dateStr}**\n\n`;
  report += statsPanel + '\n\n';

  if (aiSummary) {
    report += `---\n\n${aiSummary}\n\n`;
  }

  if (newsList.trim()) {
    report += `---\n\n🔍 **重点动态**\n${newsList}\n`;
  }

  report += `\n---\n*由 Alpha-Radar 自动生成 | ${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}*`;

  if (dryRun) {
    console.log('\n===== DAILY REPORT (DRY RUN) =====');
    console.log(report);
    console.log('===== END =====\n');
    return report;
  }

  // 推送到企业微信
  await sendReportToWeCom(report, '日报');
  // 标记已发送的新闻（仅在本地 SQLite 模式下，Supabase 模式下不需要）
  if (!USE_SUPABASE) {
    const sentIds = rows.map(r => r.id);
    if (sentIds.length > 0) {
      const placeholders = sentIds.map(() => '?').join(',');
      db.prepare(`UPDATE news SET sent_to_wecom = 1 WHERE id IN (${placeholders})`).run(...sentIds);
    }
  }
  console.log('[DailyReport] Done.');
  return report;
}

// ===================================================================
//  周报
// ===================================================================

/**
 * 生成周报并推送到企业微信
 * @param {boolean} dryRun - true 则只打印不推送
 */
async function runWeeklyReport(dryRun = false) {
  console.log('[WeeklyReport] Generating weekly report...');

  const weekStart = getWeekStartBJ();
  const startDate = formatDateBJ(weekStart);
  const endDate = formatDateBJ(Date.now());

  // 查询本周的新闻（Supabase 优先）
  const rawRows = await fetchNewsForReport(weekStart);

  // 数据清洗，按业务分类和重要性排序
  const rows = filterNewsItems(rawRows).sort((a, b) => {
    const catCmp = (a.business_category || '其他').localeCompare(b.business_category || '其他');
    if (catCmp !== 0) return catCmp;
    return (b.is_important || 0) - (a.is_important || 0);
  });

  if (rows.length === 0) {
    console.log('[WeeklyReport] No news found for this week.');
    return;
  }

  console.log(`[WeeklyReport] Found ${rows.length} items (raw: ${rawRows.length})`);

  // 统计信息
  const stats = {
    total: rows.length,
    important: rows.filter(i => i.is_important === 1).length,
    sources: new Set(rows.map(i => i.source)).size,
    categories: new Set(rows.filter(i => i.business_category).map(i => i.business_category)).size
  };
  const statsPanel = buildStatsPanel(rows, '本周');

  // 构建分类概要 — 每个分类只取前 5 条有 detail 的
  const categorized = {};
  rows.forEach(item => {
    const cat = item.business_category || '其他';
    if (!categorized[cat]) categorized[cat] = [];
    categorized[cat].push(item);
  });

  const sortedCats = Object.keys(categorized).sort((a, b) =>
    CATEGORY_ORDER.indexOf(a) - CATEGORY_ORDER.indexOf(b)
  );

  let newsList = '';
  sortedCats.forEach(cat => {
    const items = categorized[cat];
    const topItems = items.filter(i => i.detail && i.detail.length > 5).slice(0, 5);
    if (topItems.length === 0) return;

    newsList += `\n**${cat}** (${items.length} 条)\n`;
    topItems.forEach((item, idx) => {
      const comp = item.competitor_category ? ` \`${item.competitor_category}\`` : '';
      newsList += `${idx + 1}. ${item.title}${comp}\n`;
      if (item.detail) {
        newsList += `> ${item.detail}\n`;
      }
    });
  });

  // AI 周报总结 + 润色
  console.log('[WeeklyReport] Generating AI weekly summary...');
  const importantRows = rows.filter(i => i.is_important === 1 || (i.detail && i.detail.length > 5));
  const aiSummary = await generateWeeklySummary(importantRows.length > 0 ? importantRows : rows.slice(0, 50), stats);

  // 组装最终周报
  let report = `📰 **Alpha-Radar 行业周报 | ${startDate} ~ ${endDate}**\n\n`;
  report += statsPanel + '\n\n';

  if (aiSummary) {
    report += `---\n\n${aiSummary}\n\n`;
  }

  if (newsList.trim()) {
    report += `---\n\n📌 **本周重点动态**\n${newsList}\n`;
  }

  report += `\n---\n*由 Alpha-Radar 自动生成 | ${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}*`;

  if (dryRun) {
    console.log('\n===== WEEKLY REPORT (DRY RUN) =====');
    console.log(report);
    console.log('===== END =====\n');
    return report;
  }

  // 推送到企业微信
  await sendReportToWeCom(report, '周报');
  console.log('[WeeklyReport] Done.');
  return report;
}

// 兼容旧的 generateWeeklyReport 函数（仍可生成 MD 文件）
function generateWeeklyReport() {
  const fs = require('fs');
  const path = require('path');
  const oneWeekAgo = Date.now() - (7 * 24 * 60 * 60 * 1000);

  const rawRows = db.prepare(`
    SELECT * FROM news
    WHERE timestamp > ?
    ORDER BY business_category, timestamp DESC
  `).all(oneWeekAgo);

  const rows = filterNewsItems(rawRows);

  if (rows.length === 0) {
    console.log('No news found for this week.');
    return;
  }

  const reportData = {};
  rows.forEach(row => {
    const cat = row.business_category || '其他';
    if (!reportData[cat]) reportData[cat] = [];
    reportData[cat].push(row);
  });

  const dateStr = new Date().toISOString().split('T')[0];
  let md = `# ${dateStr} 行业动态周报\n\n`;

  const categories = Object.keys(reportData).sort((a, b) =>
    CATEGORY_ORDER.indexOf(a) - CATEGORY_ORDER.indexOf(b)
  );

  categories.forEach(cat => {
    const items = reportData[cat];
    md += `## ${cat}（${items.length} 条）\n\n`;
    items.forEach((item, index) => {
      const compTag = item.competitor_category ? ` \`${item.competitor_category}\`` : '';
      md += `${index + 1}. **${item.title}**${compTag}\n`;
      if (item.detail) {
        md += `   > ${item.detail}\n`;
      }
      md += `   [原文链接](${item.url})\n\n`;
    });
  });

  md += `## 个人思考\n`;
  md += `1. [在此输入本周的洞察...]\n`;

  const filePath = path.join(__dirname, `Weekly_Report_${dateStr}.md`);
  fs.writeFileSync(filePath, md);
  console.log(`[Success] Weekly report generated: ${filePath}`);
}

if (require.main === module) {
  generateWeeklyReport();
}

module.exports = { generateWeeklyReport, runDailyReport, runWeeklyReport };
