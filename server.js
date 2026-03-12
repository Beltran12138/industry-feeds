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

  let getNews, getStats, runAllScrapers, runDailyReport, runWeeklyReport, SERVER;
  
  try {
    const db = require('./db');
    getNews = db.getNews;
    getStats = db.getStats;
    console.log('[server] DB loaded successfully');
  } catch (e) {
    console.error('[server] Failed to load db:', e.message, e.stack);
    getNews = async () => [];
    getStats = async () => ({ total: 0, important: 0, sources: [], categories: [] });
  }
  
  try {
    const scrapers = require('./scrapers/index');
    runAllScrapers = scrapers.runAllScrapers;
  } catch (e) {
    console.error('[server] Failed to load scrapers:', e.message);
    runAllScrapers = async () => [];
  }
  
  try {
    const report = require('./report');
    runDailyReport = report.runDailyReport;
    runWeeklyReport = report.runWeeklyReport;
  } catch (e) {
    console.error('[server] Failed to load report:', e.message);
    runDailyReport = async () => 'Report unavailable';
    runWeeklyReport = async () => 'Report unavailable';
  }
  
  try {
    SERVER = require('./config').SERVER;
  } catch (e) {
    console.error('[server] Failed to load config:', e.message);
    SERVER = { 
      PORT: 3001, 
      SCRAPE_HIGH_CRON: '*/5 * * * *', 
      SCRAPE_LOW_CRON: '*/30 * * * *', 
      DAILY_REPORT_CRON: '0 18 * * *', 
      WEEKLY_REPORT_CRON: '0 18 * * 5' 
    };
  }

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
  const healthHandler = async (req, res) => {
    try {
      const stats = await getStats();
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
    } catch (e) {
      console.error('[health] Error:', e.message, e.stack);
      res.status(500).json({ status: 'error', error: e.message });
    }
  };
  app.get('/api/health', healthHandler);
  app.get('/health', healthHandler);

  // ── GET /api/news ──────────────────────────────────────────────────────────
  const newsHandler = async (req, res) => {
    let source    = req.query.source    || 'All';
    const important = req.query.important === '1' ? 1 : 0;
    const page    = Math.max(1, parseInt(req.query.page, 10) || 1);
    const perPage = Math.min(500, Math.max(1, parseInt(req.query.limit, 10) || (source === 'All' || important ? 500 : 100)));
    const search  = (req.query.q || '').trim().slice(0, 100);

    const VALID_SOURCES = new Set([
      'All', 'Important',
      'Binance', 'OKX', 'Bybit', 'Gate', 'MEXC', 'Bitget', 'HTX', 'KuCoin',
      'BlockBeats', 'TechFlow', 'PRNewswire',
      'HashKeyGroup', 'HashKeyExchange', 'WuBlock', 'OSL', 'Exio', 'TechubNews', 'Matrixport',
      'WuShuo', 'Phyrex', 'JustinSun', 'XieJiayin', 'TwitterAB',
      'Poly-Breaking', 'Poly-China',
    ]);
    if (!VALID_SOURCES.has(source)) source = 'All';

    const news = await getNews(perPage, source === 'Important' ? 'All' : source, important, search);
    res.json({
      success:    true,
      count:      news.length,
      page,
      lastUpdate: new Date().toISOString(),
      data:       news,
    });
  };
  app.get('/api/news', newsHandler);
  app.get('/news', newsHandler);

  // ── 统计接口 ───────────────────────────────────────────────────────────────
  const statsHandler = async (req, res) => {
    const since = parseInt(req.query.since, 10) || (Date.now() - 7 * 24 * 3600 * 1000);
    const stats = await getStats(since);
    res.json({ success: true, data: stats });
  };
  app.get('/api/stats', statsHandler);
  app.get('/stats', statsHandler);

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
    cron.schedule(SERVER.SCRAPE_HIGH_CRON || '*/5 * * * *', async () => {
      console.log('[CRON] Running scheduled high-freq scrape…');
      try { await runAllScrapers('high'); } catch (e) { console.error('[CRON] High-freq Scrape error:', e.message); }
    });

    cron.schedule(SERVER.SCRAPE_LOW_CRON || '*/30 * * * *', async () => {
      console.log('[CRON] Running scheduled low-freq scrape…');
      try { await runAllScrapers('low'); } catch (e) { console.error('[CRON] Low-freq Scrape error:', e.message); }
    });

    cron.schedule(SERVER.DAILY_REPORT_CRON, async () => {
      console.log('[CRON] Daily report (18:00 BJT)…');
      try { await runDailyReport(false); } catch (e) { console.error('[CRON] Daily report error:', e.message); }
    }, { timezone: 'Asia/Shanghai' });

    cron.schedule(SERVER.WEEKLY_REPORT_CRON, async () => {
      console.log('[CRON] Weekly report (Friday 18:00 BJT)…');
      try { await runWeeklyReport(false); } catch (e) { console.error('[CRON] Weekly report error:', e.message); }
    }, { timezone: 'Asia/Shanghai' });
  }

  // ── SPA fallback ────────────────────────────────────────────────────────────
  app.use((req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
  });

  return app;
}

// 本地运行模式
if (require.main === module) {
  const app = createApp();
  const PORT = app.locals.PORT || 3001;
  
  app.listen(PORT, async () => {
    console.log(`[SERVER] Alpha Radar running on http://localhost:${PORT}`);
    const SERVER_CONFIG = require('./config').SERVER || {};
    console.log(`[SERVER] Scrape HIGH cron : ${SERVER_CONFIG.SCRAPE_HIGH_CRON}`);
    console.log(`[SERVER] Scrape LOW  cron : ${SERVER_CONFIG.SCRAPE_LOW_CRON}`);
    console.log(`[SERVER] Daily  cron : ${SERVER_CONFIG.DAILY_REPORT_CRON}  (Asia/Shanghai)`);
    console.log(`[SERVER] Weekly cron : ${SERVER_CONFIG.WEEKLY_REPORT_CRON} (Asia/Shanghai)`);

    const db = require('./db');
    const current = await db.getNews(1);
    if (current.length === 0) {
      console.log('[INIT] DB empty — running initial scrape…');
      const scrapers = require('./scrapers/index');
      await scrapers.runAllScrapers().catch(e => console.error('[INIT] Scrape error:', e.message));
    }
  });
}

// Vercel Serverless 导出 - 需要导出 handler 函数
const appInstance = createApp();

// Vercel serverless handler
module.exports = (req, res) => {
  return appInstance(req, res);
};
