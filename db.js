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

// Helper for fuzzy deduplication
function normalizeKey(title, source) {
  return (title || '').trim().toLowerCase().replace(/[^\w\u4e00-\u9fa5]/g, '') + '|' + (source || '').trim().toLowerCase();
}

// SQLite setup (always runs for local caching/fallback)
db.exec(`
  CREATE TABLE IF NOT EXISTS news (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    normalized_title TEXT,
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
if (!existingCols.includes('detail')) db.exec("ALTER TABLE news ADD COLUMN detail TEXT DEFAULT ''");
if (!existingCols.includes('business_category')) db.exec("ALTER TABLE news ADD COLUMN business_category TEXT DEFAULT ''");
if (!existingCols.includes('competitor_category')) db.exec("ALTER TABLE news ADD COLUMN competitor_category TEXT DEFAULT ''");
if (!existingCols.includes('sent_to_wecom')) db.exec("ALTER TABLE news ADD COLUMN sent_to_wecom INTEGER DEFAULT 0");
if (!existingCols.includes('normalized_title')) {
  db.exec("ALTER TABLE news ADD COLUMN normalized_title TEXT DEFAULT ''");
  db.exec("CREATE INDEX IF NOT EXISTS idx_normalized_title ON news(normalized_title)");
}

async function saveNews(items) {
  // 1. Save to local SQLite
  const insert = db.prepare(`
    INSERT INTO news (title, normalized_title, content, detail, source, url, category, business_category, competitor_category, timestamp, is_important, sent_to_wecom)
    VALUES (@title, @normalized_title, @content, @detail, @source, @url, @category, @business_category, @competitor_category, @timestamp, @is_important, @sent_to_wecom)
    ON CONFLICT(title, source) DO UPDATE SET
      url = CASE WHEN excluded.url IS NOT NULL AND excluded.url != '' THEN excluded.url ELSE news.url END,
      normalized_title = excluded.normalized_title,
      is_important = MAX(news.is_important, excluded.is_important),
      sent_to_wecom = MAX(news.sent_to_wecom, excluded.sent_to_wecom),
      business_category = CASE WHEN excluded.business_category != '' THEN excluded.business_category ELSE news.business_category END,
      competitor_category = CASE WHEN excluded.competitor_category != '' THEN excluded.competitor_category ELSE news.competitor_category END,
      timestamp = news.timestamp, -- Keep original timestamp
      created_at = news.created_at
  `);

  const transaction = db.transaction((items) => {
    for (const item of items) {
      try {
        const nTitle = normalizeKey(item.title, '').split('|')[0];
        insert.run({
          ...item,
          normalized_title: nTitle,
          detail: item.detail || '',
          business_category: item.business_category || '',
          competitor_category: item.competitor_category || '',
          sent_to_wecom: item.sent_to_wecom || 0
        });
      } catch (err) {
        if (err.message.includes('UNIQUE constraint failed: news.url')) {
          try {
            db.prepare(`UPDATE news SET 
              title = @title, 
              normalized_title = @normalized_title,
              content = @content, source = @source, 
              is_important = MAX(is_important, @is_important), 
              sent_to_wecom = MAX(sent_to_wecom, @sent_to_wecom),
              business_category = CASE WHEN @business_category != '' THEN @business_category ELSE business_category END,
              competitor_category = CASE WHEN @competitor_category != '' THEN @competitor_category ELSE competitor_category END,
              detail = CASE WHEN @detail != '' THEN @detail ELSE detail END
              WHERE url = @url`).run({
              ...item,
              normalized_title: normalizeKey(item.title, '').split('|')[0],
              business_category: item.business_category || '',
              competitor_category: item.competitor_category || '',
              detail: item.detail || '',
              sent_to_wecom: item.sent_to_wecom || 0
            });
          } catch (e2) {
            console.warn('[DB Error during URL-update]:', e2.message);
          }
        } else {
          console.warn('[DB Error during Insert]:', err.message, item.title);
        }
      }
    }
  });
  
  try {
    transaction(items);
  } catch (fatalErr) {
    console.error('[DB Fatal Error in saveNews]:', fatalErr.message);
  }

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

      // 第一轮：按 URL 精确匹配
      const { data } = await supabase
        .from('news')
        .select('url, title, source, is_important, sent_to_wecom, business_category, timestamp')
        .in('url', chunkUrls);

      const foundByUrl = new Set();
      (data || []).forEach(r => {
        foundByUrl.add(r.url);
        const nKey = normalizeKey(r.title, r.source);
        if (r.business_category) {
          processed.add(r.url);
          processed.add(nKey);
        }
        if (!!r.sent_to_wecom) {
          sentToWeCom.add(r.url);
          sentToWeCom.add(nKey);
        }
        if (r.timestamp) {
          existingTimestamps.set(r.url, r.timestamp);
          existingTimestamps.set(nKey, r.timestamp);
        }
      });

      // 第二轮：对 URL 未命中的条目，用 title+source 兜底（防止 URL 微变导致重复推送）
      const notFound = chunk.filter(c => c.url && !foundByUrl.has(c.url));
      if (notFound.length > 0) {
        const titleList = notFound.map(c => c.title);
        const { data: td } = await supabase
          .from('news')
          .select('url, title, source, sent_to_wecom, business_category, timestamp')
          .in('title', titleList);

        (td || []).forEach(r => {
          // Find matching item using loose title match
          // But here we rely on Supabase exact match for 'in' query.
          // We can double check using normalizeKey.
          const nKeyR = normalizeKey(r.title, r.source);
          
          const match = notFound.find(i => normalizeKey(i.title, i.source) === nKeyR);
          if (match) {
            if (r.business_category) {
              processed.add(match.url);
              processed.add(nKeyR);
            }
            if (!!r.sent_to_wecom) {
              sentToWeCom.add(match.url);
              sentToWeCom.add(nKeyR);
            }
            if (r.timestamp) {
              existingTimestamps.set(match.url, r.timestamp);
              existingTimestamps.set(nKeyR, r.timestamp);
            }
          }
        });
      }
    }
  } else {
    // 本地模式：查 SQLite
    if (urls.length > 0) {
      const placeholders = urls.map(() => '?').join(',');
      db.prepare(`SELECT url, title, normalized_title, source, business_category, sent_to_wecom, timestamp FROM news WHERE url IN (${placeholders})`)
        .all(...urls).forEach(r => {
          const nKey = r.normalized_title + '|' + (r.source || '').trim().toLowerCase();
          const nTitle = r.normalized_title;
          if (r.business_category) {
            processed.add(r.url);
            processed.add(nKey);
            processed.add(nTitle);
          }
          if (r.sent_to_wecom === 1) {
            sentToWeCom.add(r.url);
            sentToWeCom.add(nKey);
            sentToWeCom.add(nTitle);
          }
          if (r.timestamp) {
            existingTimestamps.set(r.url, r.timestamp);
            existingTimestamps.set(nKey, r.timestamp);
            existingTimestamps.set(nTitle, r.timestamp);
          }
        });
    }

    // 也要通过 normalized_title 检查
    for (const item of items) {
      const nTitle = normalizeKey(item.title, '').split('|')[0];
      const nKey = nTitle + '|' + (item.source || '').trim().toLowerCase();
      
      if ((processed.has(item.url) || processed.has(nKey) || processed.has(nTitle)) &&
        (sentToWeCom.has(item.url) || sentToWeCom.has(nKey) || sentToWeCom.has(nTitle))) continue;

      // Use normalized_title for more robust matching (CROSS-SOURCE)
      const row = db.prepare('SELECT url, sent_to_wecom, business_category, timestamp FROM news WHERE normalized_title = ? ORDER BY sent_to_wecom DESC, timestamp DESC LIMIT 1').get(nTitle);
      if (row) {
        if (row.business_category) {
          if (item.url) processed.add(item.url);
          processed.add(nKey);
          processed.add(nTitle);
        }
        if (row.sent_to_wecom === 1) {
          if (item.url) sentToWeCom.add(item.url);
          sentToWeCom.add(nKey);
          sentToWeCom.add(nTitle);
        }
        if (row.timestamp) {
          if (item.url) existingTimestamps.set(item.url, row.timestamp);
          existingTimestamps.set(nKey, row.timestamp);
        }
      }
    }
  }

  return { processed, sentToWeCom, existingTimestamps };
}

/**
 * 立即更新单条新闻的推送状态
 */
async function updateSentStatus(item) {
  const nTitle = normalizeKey(item.title, '').split('|')[0];
  
  try {
    // 1. First, try updating any existing record that matches either the URL or Title+Source
    if (item.url) {
      db.prepare(`UPDATE news SET sent_to_wecom = 1 WHERE url = ?`).run(item.url);
    }
    db.prepare(`UPDATE news SET sent_to_wecom = 1 WHERE title = ? AND source = ?`).run(item.title, item.source);
    db.prepare(`UPDATE news SET sent_to_wecom = 1 WHERE normalized_title = ? AND source = ?`).run(nTitle, item.source);

    // 2. Then, try to insert a new record if it doesn't exist yet (based on title+source as the main key)
    // We use ON CONFLICT DO UPDATE to handle the case where it exists but wasn't updated above (e.g. slight race condition)
    const upsert = db.prepare(`
      INSERT INTO news (title, normalized_title, source, url, content, sent_to_wecom, is_important, timestamp, category, created_at)
      VALUES (@title, @normalized_title, @source, @url, @content, 1, @is_important, @timestamp, @category, CURRENT_TIMESTAMP)
      ON CONFLICT(title, source) DO UPDATE SET sent_to_wecom = 1
    `);
    
    upsert.run({
      title: item.title,
      normalized_title: nTitle,
      source: item.source,
      url: item.url || null,
      content: item.content || '',
      is_important: item.is_important || 0,
      timestamp: item.timestamp || Date.now(),
      category: item.category || ''
    });
  } catch (e) {
    // If it fails (e.g. URL unique constraint violation), we catch it here to prevent pipeline crash
    if (e.message.includes('UNIQUE constraint failed: news.url')) {
       // It means another record with this URL exists, let's just update its status
       try {
         db.prepare(`UPDATE news SET sent_to_wecom = 1 WHERE url = ?`).run(item.url);
       } catch (e2) {}
    } else {
       console.warn('[updateSentStatus Warning]:', e.message, item.title);
    }
  }

  if (USE_SUPABASE && supabase) {
    // ... Supabase logic remains same or similarly updated ...
    // 先尝试 UPDATE（行已存在时最安全），再 UPSERT 兜底（行尚未入库时防止遗漏）
    await supabase
      .from('news')
      .update({ sent_to_wecom: 1 })
      .match({ title: item.title, source: item.source });
    await supabase
      .from('news')
      .update({ sent_to_wecom: 1 })
      .eq('url', item.url);
    // 若行尚不存在（新条目 saveNews 尚未运行），先插入最小记录确保推送状态持久化
    await supabase
      .from('news')
      .upsert({
        title: item.title,
        source: item.source,
        url: item.url || '',
        content: item.content || '',
        category: item.category || '',
        timestamp: item.timestamp || Date.now(),
        is_important: item.is_important || 1,
        sent_to_wecom: 1,
        business_category: item.business_category || '',
        competitor_category: item.competitor_category || '',
        detail: item.detail || ''
      }, { onConflict: 'title,source' });
  }
}

module.exports = { db, saveNews, getNews, getAlreadyProcessed, updateSentStatus, normalizeKey };
