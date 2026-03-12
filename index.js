const express = require('express');
const cors = require('cors');
const path = require('path');

const app = express();

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

let getNews, getStats;

try {
  const db = require('./db');
  getNews = db.getNews;
  getStats = db.getStats;
} catch (e) {
  console.error('[server] Failed to load db:', e.message);
  getNews = async () => [];
  getStats = async () => ({ total: 0, important: 0, sources: [], categories: [] });
}

app.get('/api/health', async (req, res) => {
  try {
    const stats = await getStats();
    res.json({
      status: 'ok',
      uptime: Math.floor(Date.now() / 1000),
      db: {
        total: stats.total,
        important: stats.important,
        sources: stats.sources,
      },
      version: '1.2.0',
    });
  } catch (e) {
    console.error('[health] Error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

const VALID_SOURCES = new Set([
  'All', 'Important',
  'Binance', 'OKX', 'Bybit', 'Gate', 'MEXC', 'Bitget', 'HTX', 'KuCoin',
  'BlockBeats', 'TechFlow', 'PRNewswire',
  'HashKeyGroup', 'HashKeyExchange', 'WuBlock', 'OSL', 'Exio', 'TechubNews', 'Matrixport',
  'WuShuo', 'Phyrex', 'JustinSun', 'XieJiayin', 'TwitterAB',
  'Poly-Breaking', 'Poly-China',
]);

app.get('/api/news', async (req, res) => {
  try {
    let source = req.query.source || 'All';
    const important = req.query.important === '1' ? 1 : 0;
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const perPage = Math.min(500, Math.max(1, parseInt(req.query.limit, 10) || 500));
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
  } catch (e) {
    console.error('[news] Error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/stats', async (req, res) => {
  try {
    const since = parseInt(req.query.since, 10) || (Date.now() - 7 * 24 * 3600 * 1000);
    const stats = await getStats(since);
    res.json({ success: true, data: stats });
  } catch (e) {
    console.error('[stats] Error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

module.exports = app;
