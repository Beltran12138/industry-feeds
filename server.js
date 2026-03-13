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

  let getNews, getStats, runAllScrapers, runDailyReport, runWeeklyReport, SERVER, DATA_RETENTION;

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
    const config = require('./config');
    SERVER = config.SERVER;
    DATA_RETENTION = config.DATA_RETENTION;
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

  // ── 初始化数据生命周期管理 ─────────────────────────────────────────────────
  let lifecycleManager = null;
  try {
    const { DataLifecycleManager } = require('./data-lifecycle');
    const dbModule = require('./db');
    if (dbModule.db) {
      lifecycleManager = new DataLifecycleManager(dbModule.db);
      console.log('[server] Data lifecycle manager initialized');
    }
  } catch (e) {
    console.warn('[server] Failed to init lifecycle manager:', e.message);
  }

  // ── 初始化推送管理器 ───────────────────────────────────────────────────────
  let pushManager = null;
  try {
    const { pushManager: pm } = require('./push-channel');
    pushManager = pm;
    console.log('[server] Push manager initialized with', pushManager.getEnabledChannels().length, 'channels');
  } catch (e) {
    console.warn('[server] Failed to init push manager:', e.message);
  }

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

  // ── CORS 配置 ──────────────────────────────────────────────────────────────
  const corsOptions = {
    origin: process.env.CORS_ORIGIN || '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-API-Key'],
  };

  app.use(cors(corsOptions));
  app.use(express.json());
  app.use(express.static(path.join(__dirname, 'public')));

  // ── 健康检查（无需认证）─────────────────────────────────────────────────────
  const healthHandler = async (req, res) => {
    try {
      const stats = await getStats();

      // 获取 AI 状态
      let aiStatus = null;
      try {
        const { getAIStatus } = require('./ai-enhanced');
        aiStatus = getAIStatus();
      } catch (e) {
        // ignore
      }

      // 获取推送渠道状态
      let pushStatus = null;
      if (pushManager) {
        pushStatus = pushManager.getStatus();
      }

      // 获取存储统计
      let storageStats = null;
      if (lifecycleManager) {
        storageStats = lifecycleManager.getStorageStats();
      }

      res.json({
        status: 'ok',
        uptime: Math.floor((Date.now() - START_TIME) / 1000),
        startedAt: START_TIME.toISOString(),
        db: {
          total: stats.total,
          important: stats.important,
          sources: stats.sources,
        },
        ai: aiStatus,
        push: pushStatus,
        storage: storageStats,
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
      'HashKeyGroup', 'HashKeyExchange', 'WuBlock', 'OSL', 'Exio', 'TechubNews',
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

  // ── 归档数据查询接口 ───────────────────────────────────────────────────────
  app.get('/api/archive', async (req, res) => {
    if (!lifecycleManager) {
      return res.status(503).json({ success: false, error: 'Lifecycle manager not available' });
    }

    try {
      const options = {
        source: req.query.source,
        startDate: req.query.startDate,
        endDate: req.query.endDate,
        limit: Math.min(500, parseInt(req.query.limit, 10) || 100),
      };

      const data = lifecycleManager.queryArchive(options);
      res.json({ success: true, count: data.length, data });
    } catch (err) {
      console.error('[API /archive]', err.message);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // ── 统计数据查询接口 ───────────────────────────────────────────────────────
  app.get('/api/history-stats', async (req, res) => {
    if (!lifecycleManager) {
      return res.status(503).json({ success: false, error: 'Lifecycle manager not available' });
    }

    try {
      const options = {
        source: req.query.source,
        startDate: req.query.startDate,
        endDate: req.query.endDate,
      };

      const data = lifecycleManager.queryStats(options);
      res.json({ success: true, count: data.length, data });
    } catch (err) {
      console.error('[API /history-stats]', err.message);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // ── 数据清理接口（需要 API Key）────────────────────────────────────────────
  app.post('/api/cleanup', apiKeyGuard, async (req, res) => {
    if (!lifecycleManager) {
      return res.status(503).json({ success: false, error: 'Lifecycle manager not available' });
    }

    try {
      const stats = await lifecycleManager.cleanup();
      res.json({ success: true, stats });
    } catch (err) {
      console.error('[API /cleanup]', err.message);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // ── 推送渠道状态接口 ───────────────────────────────────────────────────────
  app.get('/api/push-status', (req, res) => {
    if (!pushManager) {
      return res.json({ success: true, channels: [] });
    }

    res.json({
      success: true,
      channels: pushManager.getEnabledChannels(),
    });
  });

  // ── 测试推送接口（需要 API Key）────────────────────────────────────────────
  app.post('/api/push-test', apiKeyGuard, async (req, res) => {
    if (!pushManager) {
      return res.status(503).json({ success: false, error: 'Push manager not available' });
    }

    const { channel, message } = req.body;
    const testMessage = message || {
      title: 'Alpha Radar 测试消息',
      content: '这是一条测试推送消息。\n\n如果您收到此消息，说明推送配置正确。\n\n时间：' + new Date().toLocaleString('zh-CN'),
      type: 'markdown',
    };

    try {
      let result;
      if (channel) {
        result = await pushManager.pushTo(channel, testMessage);
      } else {
        result = await pushManager.pushToAll(testMessage);
      }

      res.json({ success: true, result });
    } catch (err) {
      console.error('[API /push-test]', err.message);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // ── Twitter 抓取状态接口 ───────────────────────────────────────────────────
  app.get('/api/twitter-status', (req, res) => {
    try {
      const { getStats } = require('./scrapers/sources/twitter-enhanced');
      const stats = getStats();
      res.json({ success: true, stats });
    } catch (err) {
      console.error('[API /twitter-status]', err.message);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // ── AI 状态接口 ────────────────────────────────────────────────────────────
  app.get('/api/ai-status', (req, res) => {
    try {
      const { getAIStatus } = require('./ai-enhanced');
      const status = getAIStatus();
      res.json({ success: true, status });
    } catch (err) {
      console.error('[API /ai-status]', err.message);
      res.status(500).json({ success: false, error: err.message });
    }
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

    // 数据自动清理任务
    if (DATA_RETENTION?.AUTO_CLEANUP_CRON && lifecycleManager) {
      cron.schedule(DATA_RETENTION.AUTO_CLEANUP_CRON, async () => {
        console.log('[CRON] Running data cleanup…');
        try {
          const stats = await lifecycleManager.cleanup();
          console.log('[CRON] Cleanup completed:', stats);
        } catch (e) {
          console.error('[CRON] Cleanup error:', e.message);
        }
      });
    }
  }

  // ── SPA fallback (只捕获非 API 路由) ───────────────────────────────────────
  app.use((req, res, next) => {
    // API 路由不应该被 SPA fallback 捕获
    if (req.path.startsWith('/api/') || req.path.startsWith('/health') || req.path.startsWith('/news') || req.path.startsWith('/stats')) {
      return res.status(404).json({ success: false, error: 'API endpoint not found' });
    }
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
