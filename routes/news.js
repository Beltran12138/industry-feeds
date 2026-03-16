'use strict';

/**
 * 新闻相关路由
 * /api/news, /api/insights, /api/stats, /api/trend, /api/export
 */

const express = require('express');
const router = express.Router();
const logger = require('../lib/logger');

// 有效的数据源列表
const VALID_SOURCES = new Set([
  'All', 'Important',
  'Binance', 'OKX', 'Bybit', 'Gate', 'MEXC', 'Bitget', 'HTX', 'KuCoin',
  'BlockBeats', 'TechFlow', 'PRNewswire',
  'HashKeyGroup', 'HashKeyExchange', 'WuBlock', 'OSL', 'Exio', 'TechubNews',
  'WuShuo', 'Phyrex', 'JustinSun', 'XieJiayin', 'TwitterAB',
  'Poly-Breaking', 'Poly-China',
]);

module.exports = function createNewsRoutes(deps) {
  const { getNews, getStats, db } = deps;

  // ── 行业记忆 (Insights) 接口 ──────────────────────────────────────────────
  router.get('/insights', async (req, res, next) => {
    try {
      const { insightDAO } = require('../dao');
      const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 10));
      const data = await insightDAO.getRecent(limit);
      res.json({ success: true, data });
    } catch (err) {
      logger.error({ err, path: req.path }, 'Failed to get insights');
      next(err);
    }
  });

  // ── GET /api/news ──────────────────────────────────────────────────────────
  router.get('/news', newsHandler);
  router.get('/', newsHandler);

  async function newsHandler(req, res, next) {
    try {
      let source = req.query.source || 'All';
      const important = req.query.important === '1' ? 1 : 0;
      const page = Math.max(1, parseInt(req.query.page, 10) || 1);
      const perPage = Math.min(500, Math.max(1, parseInt(req.query.limit, 10) || (source === 'All' || important ? 500 : 100)));
      const search = (req.query.q || '').trim().slice(0, 100);

      if (!VALID_SOURCES.has(source)) source = 'All';

      const news = await getNews(perPage, source === 'Important' ? 'All' : source, important, search);
      res.json({
        success: true,
        count: news.length,
        page,
        lastUpdate: new Date().toISOString(),
        data: news,
      });
    } catch (err) {
      logger.error({ err, path: req.path }, 'Failed to get news');
      next(err);
    }
  }

  // ── 统计接口 ───────────────────────────────────────────────────────────────
  router.get('/stats', async (req, res, next) => {
    try {
      const since = parseInt(req.query.since, 10) || (Date.now() - 7 * 24 * 3600 * 1000);
      const stats = await getStats(since);
      res.json({ success: true, data: stats });
    } catch (err) {
      logger.error({ err, path: req.path }, 'Failed to get stats');
      next(err);
    }
  });

  // ── 语义搜索接口 ───────────────────────────────────────────────────────────
  router.get('/search/semantic', async (req, res, next) => {
    try {
      const { q, limit, threshold } = req.query;

      if (!q || q.trim().length < 2) {
        return res.status(400).json({ success: false, error: 'Query too short' });
      }

      const semantic = require('../semantic-search');
      const results = await semantic.semanticSearch(q, {
        limit: Math.min(50, Math.max(1, parseInt(limit, 10) || 10)),
        threshold: Math.min(1, Math.max(0, parseFloat(threshold) || 0.5))
      });

      res.json({ success: true, count: results.length, data: results });
    } catch (err) {
      logger.error({ err, path: req.path }, 'Failed semantic search');
      next(err);
    }
  });

  // ── 生成向量嵌入接口 ───────────────────────────────────────────────────────
  router.post('/embeddings/generate', async (req, res, next) => {
    try {
      const semantic = require('../semantic-search');
      const count = Math.min(500, Math.max(1, parseInt(req.query.count, 10) || 100));
      const result = await semantic.generateEmbeddingsForRecentNews(count);
      res.json({ success: true, ...result });
    } catch (err) {
      logger.error({ err, path: req.path }, 'Failed to generate embeddings');
      next(err);
    }
  });

  // ── 趋势数据接口 ───────────────────────────────────────────────────────────
  router.get('/trend', async (req, res, next) => {
    try {
      const days = Math.min(90, Math.max(1, parseInt(req.query.days, 10) || 7));
      const category = (req.query.category || '').trim();
      const since = Date.now() - days * 24 * 3600 * 1000;

      // Try SQLite first with optimized query
      if (db?.db) {
        let sql, params;

        if (category) {
          sql = `
            SELECT date(datetime(timestamp/1000, 'unixepoch')) as date,
                   COUNT(*) as count
            FROM news
            WHERE timestamp > ? AND business_category = ?
            GROUP BY date
            ORDER BY date ASC
          `;
          params = [since, category];
        } else {
          sql = `
            SELECT date(datetime(timestamp/1000, 'unixepoch')) as date,
                   business_category as category,
                   COUNT(*) as count
            FROM news
            WHERE timestamp > ? AND business_category != ''
            GROUP BY date, business_category
            ORDER BY date ASC
          `;
          params = [since];
        }

        const rows = db.db.prepare(sql).all(...params);
        return res.json({ success: true, days, category: category || 'all', data: rows });
      }

      // Fallback: build trend from news data
      const news = await getNews(1000, 'All', 0, '');
      const filtered = news.filter(n => (n.timestamp || 0) >= since && n.business_category);
      const trendMap = {};
      filtered.forEach(n => {
        const d = new Date(n.timestamp).toISOString().split('T')[0];
        const cat = category || n.business_category;
        if (category && n.business_category !== category) return;
        const key = `${d}|${cat}`;
        if (!trendMap[key]) trendMap[key] = { date: d, category: cat, count: 0 };
        trendMap[key].count++;
      });
      const rows = Object.values(trendMap).sort((a, b) => a.date.localeCompare(b.date));
      res.json({ success: true, days, category: category || 'all', data: rows });
    } catch (err) {
      logger.error({ err, path: req.path }, 'Failed to get trend');
      next(err);
    }
  });

  // ── 数据源健康度接口 ───────────────────────────────────────────────────────
  router.get('/source-health', async (req, res, next) => {
    try {
      let allTracking = [];
      try {
        allTracking = await db.getAllSourceTracking();
      } catch (_) {}

      // 从 news 表获取各源最新一条的时间
      let latestBySource = [];
      if (db?.db) {
        latestBySource = db.db.prepare(`
          SELECT source, MAX(timestamp) as latest_timestamp, COUNT(*) as total_count
          FROM news
          GROUP BY source
          ORDER BY latest_timestamp DESC
        `).all();
      } else {
        // Supabase fallback
        const news = await getNews(500, 'All', 0, '');
        const srcMap = {};
        news.forEach(n => {
          if (!srcMap[n.source]) srcMap[n.source] = { source: n.source, latest_timestamp: 0, total_count: 0 };
          srcMap[n.source].total_count++;
          if ((n.timestamp || 0) > srcMap[n.source].latest_timestamp) {
            srcMap[n.source].latest_timestamp = n.timestamp;
          }
        });
        latestBySource = Object.values(srcMap).sort((a, b) => b.latest_timestamp - a.latest_timestamp);
      }

      const now = Date.now();
      const TWO_HOURS = 2 * 60 * 60 * 1000;
      const sourceHealth = latestBySource.map(row => {
        const tracking = allTracking.find(t => t.source === row.source);
        const timeSinceUpdate = now - (row.latest_timestamp || 0);
        return {
          source: row.source,
          latest_timestamp: row.latest_timestamp,
          total_count: row.total_count,
          last_pushed_timestamp: tracking?.last_pushed_timestamp || null,
          last_pushed_title: tracking?.last_pushed_title || null,
          status: timeSinceUpdate > TWO_HOURS ? 'stale' : 'healthy',
          hours_since_update: Math.floor(timeSinceUpdate / (60 * 60 * 1000)),
        };
      });

      res.json({ success: true, data: sourceHealth });
    } catch (err) {
      logger.error({ err, path: req.path }, 'Failed to get source health');
      next(err);
    }
  });

  // ── 数据导出接口（CSV）─────────────────────────────────────────────────────
  router.get('/export', async (req, res, next) => {
    try {
      const format = req.query.format || 'csv';
      const days = Math.min(90, Math.max(1, parseInt(req.query.days, 10) || 7));
      const since = Date.now() - days * 24 * 3600 * 1000;

      // 优化：直接使用 SQL 查询，避免内存中过滤
      let filtered = [];
      if (db?.db) {
        const rows = db.db.prepare(`
          SELECT id, title, source, business_category, competitor_category,
                 alpha_score, is_important, detail, url, timestamp
          FROM news
          WHERE timestamp > ?
          ORDER BY timestamp DESC
        `).all(since);
        filtered = rows;
      } else {
        // Fallback
        const news = await getNews(1000, 'All', 0, '');
        filtered = news.filter(n => (n.timestamp || 0) >= since);
      }

      if (format === 'csv') {
        const headers = ['id', 'title', 'source', 'business_category', 'competitor_category', 'alpha_score', 'is_important', 'detail', 'url', 'timestamp'];
        const csvRows = [headers.join(',')];
        filtered.forEach(row => {
          csvRows.push(headers.map(h => {
            let val = row[h] ?? '';
            if (typeof val === 'string') val = '"' + val.replace(/"/g, '""') + '"';
            return val;
          }).join(','));
        });
        const csv = csvRows.join('\n');
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename=alpha-radar-export-${days}d.csv`);
        res.send('\uFEFF' + csv); // BOM for Excel compatibility
      } else {
        res.json({ success: true, count: filtered.length, data: filtered });
      }
    } catch (err) {
      logger.error({ err, path: req.path }, 'Failed to export data');
      next(err);
    }
  });

  return router;
};
