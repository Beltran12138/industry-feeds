'use strict';
/**
 * report.js — 日报 / 周报生成（重构版）
 *
 * 核心改进：
 *   1. 周报生成前先批量补充未分类条目（batchClassify）
 *   2. 双层噪声过滤（filter.js isReportNoise）
 *   3. 周报 AI 先精选 top-30 再生成，输出接近手工整理水平
 *   4. 统一从 config.js 读配置
 */

const { db }                    = require('./db');
const { isReportNoise } = require('./filter');
const { batchClassify, generateDailySummary, generateWeeklySummary } = require('./ai');
const { sendReportToWeCom }     = require('./wecom');
const { createClient }          = require('@supabase/supabase-js');
const { REPORT }                = require('./config');
require('dotenv').config();

const USE_SUPABASE = process.env.USE_SUPABASE === 'true';
let supabase = null;
if (USE_SUPABASE && process.env.SUPABASE_URL && process.env.SUPABASE_KEY) {
  supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
}

// ── 时间工具 ──────────────────────────────────────────────────────────────────
function getTodayMidnightBJ() {
  const bj = new Date(Date.now() + 8 * 3600000);
  return Date.UTC(bj.getUTCFullYear(), bj.getUTCMonth(), bj.getUTCDate(), -8, 0, 0, 0);
}

function getWeekStartBJ() {
  const bj  = new Date(Date.now() + 8 * 3600000);
  const day = bj.getUTCDay();
  const diff = day === 0 ? 6 : day - 1;
  return Date.UTC(bj.getUTCFullYear(), bj.getUTCMonth(), bj.getUTCDate() - diff, -8, 0, 0, 0);
}

function formatDateBJ(ts) {
  return new Date(ts + 8 * 3600000).toISOString().split('T')[0];
}

// ── 数据获取 ──────────────────────────────────────────────────────────────────
async function fetchNewsForReport(since, limit = 500) {
  if (USE_SUPABASE && supabase) {
    try {
      // 先尝试按 alpha_score 排序（如果列存在）
      let query = supabase
        .from('news')
        .select('*')
        .gte('timestamp', since)
        .order('timestamp', { ascending: false })
        .limit(limit);
      
      const { data, error } = await query;
      
      if (error) {
        // 如果失败，可能是 alpha_score 列不存在，尝试只用 timestamp 排序
        console.log('[Report] Retrying without alpha_score sort...');
        const { data: data2, error: error2 } = await supabase
          .from('news')
          .select('*')
          .gte('timestamp', since)
          .order('timestamp', { ascending: false })
          .limit(limit);
        if (error2) { console.error('[Report] Supabase error:', error2.message); return []; }
        return data2 || [];
      }
      return data || [];
    } catch (e) {
      console.error('[Report] Supabase fetch error:', e.message);
      return [];
    }
  }
  if (!db) return [];
  // SQLite 使用 alpha_score（本地数据库有该列）
  return db.prepare(
    'SELECT * FROM news WHERE timestamp > ? ORDER BY alpha_score DESC, timestamp DESC LIMIT ?'
  ).all(since, limit);
}

// ── 批量补充分类（报告前预处理）───────────────────────────────────────────────
/**
 * 找出未分类的条目（business_category 为空/其他），批量调用 AI 填充。
 * 限制处理数量（MAX_ITEMS_FOR_AI），避免 token 超支。
 */
async function fillMissingCategories(rows) {
  const unclassified = rows.filter(r =>
    !r.business_category || r.business_category === '' || r.business_category === '其他'
  ).slice(0, REPORT.MAX_ITEMS_FOR_AI);

  if (unclassified.length === 0) return rows;

  console.log(`[Report] Batch classifying ${unclassified.length} unclassified items…`);
  const resultMap = await batchClassify(unclassified);

  // 把 AI 结果写回 rows（仅内存，不再写 DB 以减少干扰）
  const unclassifiedMap = new Map(unclassified.map((r, i) => [i, r]));
  resultMap.forEach((aiResult, idx) => {
    const item = unclassifiedMap.get(idx);
    if (item && aiResult) {
      Object.assign(item, {
        business_category:   aiResult.business_category   || item.business_category,
        competitor_category: aiResult.competitor_category || item.competitor_category,
        detail:              aiResult.detail              || item.detail,
        alpha_score:         aiResult.alpha_score         || item.alpha_score,
        impact:              aiResult.impact              || item.impact,
        bitv_action:         aiResult.bitv_action         || item.bitv_action,
        is_important:        aiResult.is_important        ?? item.is_important,
      });
    }
  });

  return rows;
}

// ── 统计面板 ──────────────────────────────────────────────────────────────────
function buildStatsPanel(items, period = '今日') {
  const total      = items.length;
  const important  = items.filter(i => i.is_important === 1).length;
  const sources    = new Set(items.map(i => i.source)).size;
  const withDetail = items.filter(i => i.detail?.length > 5).length;
  return `📊 **${period}数据概览**\n> 抓取 **${total}** 条 | 重要 **${important}** 条 | AI 摘要 **${withDetail}** 条 | 来源 **${sources}** 个`;
}

// ═══════════════════════════════════════════════════════════════════════
//  日报
// ═══════════════════════════════════════════════════════════════════════
async function runDailyReport(dryRun = false) {
  console.log('[DailyReport] Start…');
  console.log(`[DailyReport] dryRun=${dryRun}, Time: ${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`);
  
  const since   = getTodayMidnightBJ();
  const dateStr = formatDateBJ(Date.now());
  console.log(`[DailyReport] Fetching news since: ${new Date(since).toISOString()}`);
  
  let rawRows = [];
  try {
    rawRows = await fetchNewsForReport(since);
    console.log(`[DailyReport] Fetched ${rawRows.length} raw rows`);
  } catch (err) {
    console.error('[DailyReport] Error fetching news:', err.message);
    return null;
  }

  // 噪声过滤：仅去除报告噪声源（不重新跑完整的 filterNewsItems，
  // 因为 DB 中的数据已经过滤过，重跑 validateTimestamp 会误删有效条目）
  let rows = rawRows.filter(r => !isReportNoise(r));
  console.log(`[DailyReport] After filtering: ${rows.length} rows`);

  if (rows.length === 0) {
    console.log('[DailyReport] No qualifying news today.');
    // 即使没有新闻，也发送一个空报告通知，避免用户以为系统故障
    if (!dryRun) {
      const { sendReportToWeCom } = require('./wecom');
      await sendReportToWeCom(`📋 **Alpha-Radar 行业日报 | ${dateStr}**\n\n今日暂无符合条件的行业动态。\n\n---\n*Alpha-Radar 战略分析引擎*`, '日报');
    }
    return null;
  }

  // 补充分类
  rows = await fillMissingCategories(rows);

  // 重要条目列表（权重优先）
  const importantItems = rows
    .filter(r => (r.alpha_score >= 70 || r.is_important === 1) && r.detail?.length > 5)
    .slice(0, REPORT.DAILY_IMPORTANT_TOP);

  const categorized = {};
  importantItems.forEach(item => {
    const cat = item.business_category || '其他';
    if (!categorized[cat]) categorized[cat] = [];
    categorized[cat].push(item);
  });

  const sortedCats = Object.keys(categorized).sort(
    (a, b) => REPORT.CATEGORY_ORDER.indexOf(a) - REPORT.CATEGORY_ORDER.indexOf(b)
  );

  let newsList = '';
  sortedCats.forEach(cat => {
    const items = categorized[cat];
    newsList += `\n**${cat}** (${items.length})\n`;
    items.forEach((item, i) => {
      const scoreEmoji = item.alpha_score >= 90 ? '🔥' : (item.alpha_score >= 70 ? '⭐️' : '📡');
      const impactLabel = item.impact ? `[${item.impact}]` : '';
      const comp = item.competitor_category ? ` \`${item.competitor_category}\`` : '';
      
      newsList += `${i + 1}. ${scoreEmoji}${item.title}${comp} \`${item.alpha_score || ''}\` ${impactLabel}\n`;
      if (item.detail) newsList += `   > ${item.detail}\n`;
      if (item.bitv_action) newsList += `   > 💡 **建议:** ${item.bitv_action}\n`;
    });
  });

  // AI 总结
  const aiInput   = rows.filter(r => r.detail || r.alpha_score >= 70);
  const aiSummary = await generateDailySummary(aiInput.length ? aiInput : rows.slice(0, 30));

  // 组装报告
  let report = `📋 **Alpha-Radar 行业日报 | ${dateStr}**\n\n`;
  report    += buildStatsPanel(rows, '今日') + '\n\n';
  if (aiSummary) report += `---\n\n${aiSummary}\n\n`;
  if (newsList.trim()) report += `---\n\n🔍 **重点动态分析**\n${newsList}\n`;
  report    += `\n---\n*Alpha-Radar 战略分析引擎 | ${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}*`;

  if (dryRun) {
    console.log('\n=== DAILY REPORT (DRY RUN) ===\n', report, '\n=== END ===\n');
    return report;
  }

  await sendReportToWeCom(report, '日报');
  console.log('[DailyReport] Done.');
  return report;
}

// ═══════════════════════════════════════════════════════════════════════
//  周报（精选模式）
// ═══════════════════════════════════════════════════════════════════════
async function runWeeklyReport(dryRun = false) {
  console.log('[WeeklyReport] Start…');
  const weekStart = getWeekStartBJ();
  const startDate = formatDateBJ(weekStart);
  const endDate   = formatDateBJ(Date.now());
  const rawRows   = await fetchNewsForReport(weekStart);

  // 噪声过滤：仅去除报告噪声源
  let rows = rawRows.filter(r => !isReportNoise(r));

  if (rows.length === 0) {
    console.log('[WeeklyReport] No qualifying news this week.');
    return null;
  }

  console.log(`[WeeklyReport] ${rawRows.length} raw → ${rows.length} after filter`);

  // 补充分类
  rows = await fillMissingCategories(rows);

  // 统计
  const stats = {
    total:      rows.length,
    important:  rows.filter(r => r.alpha_score >= 70).length,
    sources:    new Set(rows.map(r => r.source)).size,
    categories: new Set(rows.filter(r => r.business_category).map(r => r.business_category)).size,
  };

  // AI 周报
  const aiInput   = rows.filter(r => r.alpha_score >= 70 || r.detail?.length > 5);
  const aiSummary = await generateWeeklySummary(aiInput.length >= 5 ? aiInput : rows.slice(0, 80), stats);

  // 按分类汇总附录
  const categorized = {};
  rows.forEach(item => {
    const cat = item.business_category || '其他';
    if (!categorized[cat]) categorized[cat] = [];
    categorized[cat].push(item);
  });

  const sortedCats = Object.keys(categorized).sort(
    (a, b) => REPORT.CATEGORY_ORDER.indexOf(a) - REPORT.CATEGORY_ORDER.indexOf(b)
  );

  let appendix = '';
  sortedCats.forEach(cat => {
    const items    = categorized[cat];
    const topItems = items.filter(i => i.detail?.length > 5).slice(0, REPORT.WEEKLY_TOP_PER_CAT);
    if (topItems.length === 0) return;
    appendix += `\n**${cat}** (共 ${items.length} 条)\n`;
    topItems.forEach((item, i) => {
      const scoreEmoji = item.alpha_score >= 90 ? '🔥' : (item.alpha_score >= 70 ? '⭐️' : '');
      const impactLabel = item.impact ? `[${item.impact}]` : '';
      const comp = item.competitor_category ? ` \`${item.competitor_category}\`` : '';
      
      appendix += `${i + 1}. ${scoreEmoji}${item.title}${comp} \`${item.alpha_score || ''}\` ${impactLabel}\n`;
      appendix += `   > ${item.detail}\n`;
      if (item.bitv_action) appendix += `   > 💡 **分析:** ${item.bitv_action}\n`;
    });
  });

  // 组装周报
  let report = `📰 **Alpha-Radar 行业周报 | ${startDate} ~ ${endDate}**\n\n`;
  report    += buildStatsPanel(rows, '本周') + '\n\n';
  if (aiSummary) report += `---\n\n${aiSummary}\n\n`;
  if (appendix.trim()) report += `---\n\n📌 **本周分类策略详情**\n${appendix}\n`;
  report    += `\n---\n*Alpha-Radar 战略分析引擎 | ${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}*`;

  if (dryRun) {
    console.log('\n=== WEEKLY REPORT (DRY RUN) ===\n', report, '\n=== END ===\n');
    return report;
  }

  await sendReportToWeCom(report, '周报');
  console.log('[WeeklyReport] Done.');
  return report;
}

module.exports = { runDailyReport, runWeeklyReport };
