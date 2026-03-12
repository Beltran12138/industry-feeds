// Vercel Serverless 模式：导出 handler
// 本地运行时使用 app.listen()
let app;

// 初始化 app 的函数
function createApp() {
  if (app) return app;
  
  const express = require('express');
  const cors    = require('cors');
  const cron    = require('node-cron');
  const path    = require('path');
  const { getNews, getStats } = require('./db');
  const { runAllScrapers }    = require('./scrapers/index');
  const { runDailyReport, runWeeklyReport } = require('./report');
  const { SERVER } = require('./config');

  app = express();
  const PORT = SERVER.PORT;
  app.locals.PORT = PORT;

  // ── 启动时间，用于 /api/health ──────────────────────────────────────────────
  const START_TIME = new Date();

  // ── 简单 API Key 保护（可选，设置 API_SECRET 环境变量后生效）──────────────
  function apiKeyGuard(req, res, next) {
    const secret = process.env.API_SECRET;
    if (!secret) return next(); // 未配置则跳过
    const provided = req.headers['x-api-key'] || req.query.apiKey;
    if (provided !== secret) {
      return res.status(401).json({ success: false, error: 'Unauthorized' });
    }
    next();
  }

  app.use(cors());
  app.use(express.json());
  app.use(express.static(path.join(__dirname, 'public')));

  // ── 健康检查（无需认证）─────────────────────────────────────────────────────
  app.get('/api/health', (req, res) => {
    const stats = getStats();
    res.json({
      status: 'ok',
      uptime: Math.floor((Date.now() - START_TIME) / 1000),
      startedAt: START_TIME.toISOString(),
      db: {
        total: stats.total,
        important: stats.important,
        sources: stats.sources,
      },
      version: require('./package.json').version,
    });
  });

  // ── GET /api/news ──────────────────────────────────────────────────────────
  const VALID_SOURCES = new Set([
    'All', 'Important',
    'Binance', 'OKX', 'Bybit', 'Gate', 'MEXC', 'Bitget', 'HTX', 'KuCoin',
    'BlockBeats', 'TechFlow', 'PRNewswire',
    'HashKeyGroup', 'HashKeyExchange', 'WuBlock', 'OSL', 'Exio', 'TechubNews', 'Matrixport',
    'WuShuo', 'Phyrex', 'JustinSun', 'XieJiayin', 'TwitterAB',
    'Poly-Breaking', 'Poly-China',
  ]);

  app.get('/api/news', (req, res) => {
    let source    = req.query.source    || 'All';
    const important = req.query.important === '1' ? 1 : 0;
    const page    = Math.max(1, parseInt(req.query.page, 10) || 1);
    const perPage = Math.min(500, Math.max(1, parseInt(req.query.limit, 10) || (source === 'All' || important ? 500 : 100)));
    const search  = (req.query.q || '').trim().slice(0, 100);

    if (!VALID_SOURCES.has(source)) source = 'All';

    const news = getNews(perPage, source === 'Important' ? 'All' : source, important, search);
    res.json({
      success:    true,
      count:      news.length,
      page,
      lastUpdate: new Date().toISOString(),
      data:       news,
    });
  });

  // ── 统计接口（供前端图表使用）───────────────────────────────────────────────
  app.get('/api/stats', (req, res) => {
    const since = parseInt(req.query.since, 10) || (Date.now() - 7 * 24 * 3600 * 1000);
    const stats = getStats(since);
    res.json({ success: true, data: stats });
  });

  // ── 以下写操作需要 API Key 保护 ────────────────────────────────────────────
  app.post('/api/refresh', apiKeyGuard, async (req, res) => {
    try {
      const data = await runAllScrapers();
      res.json({ success: true, count: data.length, data: data.slice(0, 10) });
    } catch (err) {
      console.error('[API /refresh]', err.message);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.post('/api/daily-report', apiKeyGuard, async (req, res) => {
    try {
      const dryRun = req.query.dryRun === 'true';
      const report = await runDailyReport(dryRun);
      res.json({ success: true, dryRun, report: report ? report.substring(0, 500) + '…' : null });
    } catch (err) {
      console.error('[API /daily-report]', err.message);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.post('/api/weekly-report', apiKeyGuard, async (req, res) => {
    try {
      const dryRun = req.query.dryRun === 'true';
      const report = await runWeeklyReport(dryRun);
      res.json({ success: true, dryRun, report: report ? report.substring(0, 500) + '…' : null });
    } catch (err) {
      console.error('[API /weekly-report]', err.message);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // Vercel Serverless 环境不支持 cron，只在本地运行
  if (process.env.VERCEL !== 'true') {
    cron.schedule(SERVER.SCRAPE_CRON, async () => {
      console.log('[CRON] Running scheduled scrape…');
      try { await runAllScrapers(); } catch (e) { console.error('[CRON] Scrape error:', e.message); }
    });

    cron.schedule(SERVER.DAILY_REPORT_CRON, async () => {
      console.log('[CRON] Daily report (18:00 BJT)…');
      try { await runDailyReport(false); } catch (e) { console.error('[CRON] Daily report error:', e.message); }
    }, { timezone: 'UTC' });

    cron.schedule(SERVER.WEEKLY_REPORT_CRON, async () => {
      console.log('[CRON] Weekly report (Friday 18:00 BJT)…');
      try { await runWeeklyReport(false); } catch (e) { console.error('[CRON] Weekly report error:', e.message); }
    }, { timezone: 'UTC' });
  }

  // ── SPA fallback ────────────────────────────────────────────────────────────
  app.get('/{*path}', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
  });

  return app;
}

// 本地运行模式
if (require.main === module) {
  const app = createApp();
  const PORT = app.locals.PORT || SERVER.PORT;
  
  app.listen(PORT, async () => {
    console.log(`[SERVER] Alpha Radar running on http://localhost:${PORT}`);
    console.log(`[SERVER] Scrape cron : ${SERVER.SCRAPE_CRON}`);
    console.log(`[SERVER] Daily  cron : ${SERVER.DAILY_REPORT_CRON}  (UTC)`);
    console.log(`[SERVER] Weekly cron : ${SERVER.WEEKLY_REPORT_CRON} (UTC)`);

    const current = getNews(1);
    if (current.length === 0) {
      console.log('[INIT] DB empty — running initial scrape…');
      await runAllScrapers().catch(e => console.error('[INIT] Scrape error:', e.message));
    }
  });
}

// Vercel Serverless 导出
module.exports = createApp;
