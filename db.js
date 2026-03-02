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
    source TEXT NOT NULL,
    url TEXT UNIQUE,
    category TEXT,
    timestamp INTEGER,
    is_important INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_timestamp ON news(timestamp DESC);
  CREATE INDEX IF NOT EXISTS idx_source ON news(source);
`);

async function saveNews(items) {
  // 1. Save to local SQLite
  const insert = db.prepare(`
    INSERT INTO news (title, content, source, url, category, timestamp, is_important)
    VALUES (@title, @content, @source, @url, @category, @timestamp, @is_important)
    ON CONFLICT(url) DO UPDATE SET
      is_important = excluded.is_important
  `);

  const transaction = db.transaction((items) => {
    for (const item of items) {
      insert.run(item);
    }
  });
  transaction(items);

  // 2. Sync to Supabase if enabled
  if (USE_SUPABASE && supabase) {
    console.log(`[Supabase] Syncing ${items.length} items...`);
    // Upsert into Supabase (PostgreSQL)
    // Note: Items must match the Supabase table schema exactly.
    // Deduplicate by URL before upsert (PostgreSQL rejects duplicate keys in same batch)
    const seen = new Set();
    const cleanItems = items
      .filter(item => item.url && !seen.has(item.url) && seen.add(item.url))
      .map(item => ({
        title: item.title,
        content: item.content || '',
        source: item.source,
        url: item.url,
        category: item.category || 'Signals',
        timestamp: Math.round(item.timestamp),
        is_important: item.is_important || 0
      }));

    const { error } = await supabase
      .from('news')
      .upsert(cleanItems, { onConflict: 'url' });

    if (error) console.error('[Supabase Error]:', error.message);
    else console.log('[Supabase Success]: Items synced.');
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

module.exports = { db, saveNews, getNews };
