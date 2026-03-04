const Database = require('better-sqlite3');
const { createClient } = require('@supabase/supabase-js');
const path = require('path');
require('dotenv').config();

const USE_SUPABASE = process.env.USE_SUPABASE === 'true';

let supabase = null;
if (USE_SUPABASE) {
  supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_KEY
  );
}

const db = new Database(path.join(__dirname, 'alpha_radar.db'));

// SQLite setup (always runs for local caching/fallback)
db.exec(`
  CREATE TABLE IF NOT EXISTS news (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    content TEXT,
    detail TEXT,
    source TEXT NOT NULL,
    url TEXT UNIQUE,
    category TEXT,
    business_category TEXT,
    competitor_category TEXT,
    timestamp INTEGER,
    is_important INTEGER DEFAULT 0,
    sent_to_wecom INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_timestamp ON news(timestamp DESC);
  CREATE INDEX IF NOT EXISTS idx_source ON news(source);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_title_source ON news(title, source);
`);

// Migration: add new columns if they don't exist (safe for existing DBs)
const existingCols = db.prepare('PRAGMA table_info(news)').all().map(c => c.name);
if (!existingCols.includes('detail'))               db.exec("ALTER TABLE news ADD COLUMN detail TEXT DEFAULT ''");
if (!existingCols.includes('business_category'))    db.exec("ALTER TABLE news ADD COLUMN business_category TEXT DEFAULT ''");
if (!existingCols.includes('competitor_category'))  db.exec("ALTER TABLE news ADD COLUMN competitor_category TEXT DEFAULT ''");
if (!existingCols.includes('sent_to_wecom'))        db.exec("ALTER TABLE news ADD COLUMN sent_to_wecom INTEGER DEFAULT 0");

async function saveNews(items) {
  // 1. Save to local SQLite
  // We prioritize (title, source) deduplication as URLs are often unstable
  const insert = db.prepare(`
    INSERT INTO news (title, content, detail, source, url, category, business_category, competitor_category, timestamp, is_important, sent_to_wecom)
    VALUES (@title, @content, @detail, @source, @url, @category, @business_category, @competitor_category, @timestamp, @is_important, @sent_to_wecom)
    ON CONFLICT(title, source) DO UPDATE SET
      url = excluded.url,
      is_important = MAX(news.is_important, excluded.is_important),
      sent_to_wecom = MAX(news.sent_to_wecom, excluded.sent_to_wecom),
      business_category = CASE WHEN excluded.business_category != '' THEN excluded.business_category ELSE news.business_category END,
      competitor_category = CASE WHEN excluded.competitor_category != '' THEN excluded.competitor_category ELSE news.competitor_category END,
      detail = CASE WHEN excluded.detail != '' THEN excluded.detail ELSE news.detail END,
      timestamp = news.timestamp -- Keep original timestamp to avoid "refreshing" old news to 48h window
  `);

  const transaction = db.transaction((items) => {
    for (const item of items) {
      try {
        insert.run({
          ...item,
          detail: item.detail || '',
          business_category: item.business_category || '',
          competitor_category: item.competitor_category || '',
          sent_to_wecom: item.sent_to_wecom || 0
        });
      } catch (err) {
        if (err.message.includes('UNIQUE constraint failed: news.url')) {
          // If URL is also unique but title/source differed, update by URL
          db.prepare(`UPDATE news SET 
            title = @title, content = @content, source = @source, 
            is_important = MAX(is_important, @is_important), 
            sent_to_wecom = MAX(sent_to_wecom, @sent_to_wecom)
            WHERE url = @url`).run({
              ...item,
              sent_to_wecom: item.sent_to_wecom || 0
            });
        } else {
          console.error('[DB Error]:', err.message, item.title);
        }
      }
    }
  });
  transaction(items);

  // 2. Sync to Supabase if enabled
  if (USE_SUPABASE && supabase) {
    console.log(`[Supabase] Syncing ${items.length} items...`);
    const seen = new Set();
    const cleanItems = items
      .filter(item => item.url && !seen.has(item.url) && seen.add(item.url))
      .map(item => ({
        title: item.title,
        content: item.content || '',
        detail: item.detail || '',
        source: item.source,
        url: item.url,
        category: item.category || 'Signals',
        business_category: item.business_category || '',
        competitor_category: item.competitor_category || '',
        timestamp: Math.round(item.timestamp),
        is_important: item.is_important || 0,
        sent_to_wecom: item.sent_to_wecom || 0
      }));

    const { error } = await supabase
      .from('news')
      .upsert(cleanItems, { onConflict: 'title,source' });

    if (error) {
      console.error('[Supabase Error]:', error.message);
    }
  }
}

function getNews(limit = 100, source = null, important = 0) {
  let query = 'SELECT * FROM news WHERE 1=1 ';
  const params = [];

  if (important == 1) {
    query += 'AND is_important = 1 ';
  } else if (source && source !== 'All') {
    query += 'AND source = ? ';
    params.push(source);
  }

  query += 'ORDER BY timestamp DESC LIMIT ?';
  params.push(limit);

  return db.prepare(query).all(...params);
}

/**
 * 批量查询哪些 URL/Title 已经过 AI 处理及已推送企微
 * 同时返回已存在的 timestamp 以便严格执行 48h 推送规则
 */
async function getAlreadyProcessed(items) {
  const processed = new Set();
  const sentToWeCom = new Set();
  const existingTimestamps = new Map(); // url -> timestamp
  if (!items || items.length === 0) return { processed, sentToWeCom, existingTimestamps };

  const urls = items.map(i => i.url).filter(Boolean);

  if (USE_SUPABASE && supabase) {
    const CHUNK = 100;
    for (let i = 0; i < items.length; i += CHUNK) {
      const chunk = items.slice(i, i + CHUNK);
      const chunkUrls = chunk.map(c => c.url).filter(Boolean);
      const { data } = await supabase
        .from('news')
        .select('url, title, source, is_important, sent_to_wecom, business_category, timestamp')
        .in('url', chunkUrls);
      
      (data || []).forEach(r => {
        if (r.business_category) processed.add(r.url);
        if (r.sent_to_wecom === 1) sentToWeCom.add(r.url);
        if (r.timestamp) existingTimestamps.set(r.url, r.timestamp);
      });
    }
  } else {
    // 本地模式：查 SQLite
    if (urls.length > 0) {
      const placeholders = urls.map(() => '?').join(',');
      db.prepare(`SELECT url, business_category, sent_to_wecom, timestamp FROM news WHERE url IN (${placeholders})`)
        .all(...urls).forEach(r => {
          if (r.business_category) processed.add(r.url);
          if (r.sent_to_wecom === 1) sentToWeCom.add(r.url);
          if (r.timestamp) existingTimestamps.set(r.url, r.timestamp);
        });
    }
    
    // 也要通过 title + source 检查
    for (const item of items) {
      if (processed.has(item.url) && sentToWeCom.has(item.url)) continue;

      const row = db.prepare('SELECT url, sent_to_wecom, business_category, timestamp FROM news WHERE title = ? AND source = ?').get(item.title, item.source);
      if (row) {
        if (row.business_category) processed.add(item.url);
        if (row.sent_to_wecom === 1) sentToWeCom.add(item.url);
        // Prioritize existing URL's timestamp if it exists, otherwise use this one's
        if (row.timestamp) existingTimestamps.set(item.url, row.timestamp);
      }
    }
  }

  return { processed, sentToWeCom, existingTimestamps };
}

/**
 * 立即更新单条新闻的推送状态
 * 防止脚本异常退出导致下次重复推送
 */
async function updateSentStatus(item) {
  db.prepare('UPDATE news SET sent_to_wecom = 1 WHERE url = ?').run(item.url);
  db.prepare('UPDATE news SET sent_to_wecom = 1 WHERE title = ? AND source = ?').run(item.title, item.source);

  if (USE_SUPABASE && supabase) {
    await supabase
      .from('news')
      .update({ sent_to_wecom: 1 })
      .match({ title: item.title, source: item.source });
  }
}

module.exports = { db, saveNews, getNews, getAlreadyProcessed, updateSentStatus };
