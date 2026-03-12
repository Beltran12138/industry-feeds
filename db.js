'use strict';

const { createClient } = require('@supabase/supabase-js');
const path         = require('path');
require('dotenv').config();

let DB;
try {
  DB = require('./config').DB;
} catch (e) {
  DB = { SUPABASE_CHUNK_SIZE: 100, NEWS_FETCH_LIMIT: 500 };
}

const USE_SUPABASE = process.env.USE_SUPABASE === 'true';
const IS_VERCEL = process.env.VERCEL === 'true';

let supabase = null;
if (USE_SUPABASE && process.env.SUPABASE_URL && process.env.SUPABASE_KEY) {
  supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
} else if (USE_SUPABASE) {
  console.log('[DB] Supabase enabled but missing credentials');
}

let db = null;
let STMT = null;

// ── 归一化 key（用于模糊去重）─────────────────────────────────────────────────
function normalizeKey(title, source) {
  if (!title) return '';
  
  let normalized = title.trim().toLowerCase();
  
  // 1. 移除常见的新闻后缀/前缀（如 [Update], (Updated), [ANN] 等）
  normalized = normalized
    .replace(/\[[^\]]+\]/g, '') // 移除 [xxx]
    .replace(/\([^)]+\)/g, '')  // 移除 (xxx)
    .replace(/【[^】]+】/g, '') // 移除 【xxx】
    .replace(/(updated|update|new|announcement|ann|official|official announcement|latest)/gi, '')
    .trim();

  // 2. 移除非字母数字字符
  normalized = normalized.replace(/[\s\-_,.:;!?()\[\]{}"'\\/|@#$%^&*+=<>~`]+/g, '');
  
  return source ? `${normalized}|${source.trim().toLowerCase()}` : normalized;
}

if (!USE_SUPABASE) {
  const Database = require('better-sqlite3');
  db = new Database(path.join(__dirname, 'alpha_radar.db'));
  // ── 建表 + 索引 ───────────────────────────────────────────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS news (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      normalized_title TEXT,
      content TEXT,
      detail TEXT DEFAULT '',
      impact TEXT DEFAULT '',
      bitv_action TEXT DEFAULT '',
      source TEXT NOT NULL,
      url TEXT UNIQUE,
      category TEXT,
      business_category TEXT DEFAULT '',
      competitor_category TEXT DEFAULT '',
      timestamp INTEGER,
      is_important INTEGER DEFAULT 0,
      alpha_score INTEGER DEFAULT 0,
      sent_to_wecom INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS source_tracking (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source TEXT UNIQUE NOT NULL,
      last_pushed_timestamp INTEGER,
      last_pushed_title TEXT,
      last_updated DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_timestamp       ON news(timestamp DESC);
    CREATE INDEX IF NOT EXISTS idx_source          ON news(source);
    CREATE INDEX IF NOT EXISTS idx_is_important    ON news(is_important);
    CREATE INDEX IF NOT EXISTS idx_alpha_score     ON news(alpha_score);
    CREATE INDEX IF NOT EXISTS idx_business_cat    ON news(business_category);
    CREATE INDEX IF NOT EXISTS idx_sent_wecom      ON news(sent_to_wecom);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_title_source ON news(title, source);
    CREATE INDEX IF NOT EXISTS idx_normalized_title ON news(normalized_title);
    CREATE INDEX IF NOT EXISTS idx_source_tracking ON source_tracking(source);
  `);

  // ── 安全迁移（已有数据库补列）────────────────────────────────────────────────
  const existingCols = db.prepare('PRAGMA table_info(news)').all().map(c => c.name);
  const migrations = [
    ['detail',               "ALTER TABLE news ADD COLUMN detail TEXT DEFAULT ''"],
    ['impact',               "ALTER TABLE news ADD COLUMN impact TEXT DEFAULT ''"],
    ['bitv_action',          "ALTER TABLE news ADD COLUMN bitv_action TEXT DEFAULT ''"],
    ['business_category',    "ALTER TABLE news ADD COLUMN business_category TEXT DEFAULT ''"],
    ['competitor_category',  "ALTER TABLE news ADD COLUMN competitor_category TEXT DEFAULT ''"],
    ['sent_to_wecom',        'ALTER TABLE news ADD COLUMN sent_to_wecom INTEGER DEFAULT 0'],
    ['alpha_score',          'ALTER TABLE news ADD COLUMN alpha_score INTEGER DEFAULT 0'],
    ['normalized_title',     "ALTER TABLE news ADD COLUMN normalized_title TEXT DEFAULT ''; CREATE INDEX IF NOT EXISTS idx_normalized_title ON news(normalized_title)"],
  ];
  migrations.forEach(([col, sql]) => {
    if (!existingCols.includes(col)) { 
      try { db.exec(sql); console.log(`[DB] Migrated: +${col}`); } catch(e) { console.error(`[DB] Migration failed for ${col}:`, e.message); }
    }
  });

  // ── 预编译 SQL（性能优化）────────────────────────────────────────────────────
  STMT = {
    insert: db.prepare(`
      INSERT INTO news
        (title, normalized_title, content, detail, impact, bitv_action, source, url, category,
         business_category, competitor_category, timestamp, is_important, alpha_score, sent_to_wecom)
      VALUES
        (@title, @normalized_title, @content, @detail, @impact, @bitv_action, @source, @url, @category,
         @business_category, @competitor_category, @timestamp, @is_important, @alpha_score, @sent_to_wecom)
      ON CONFLICT(title, source) DO UPDATE SET
        url                 = CASE WHEN excluded.url != '' THEN excluded.url ELSE news.url END,
        normalized_title    = excluded.normalized_title,
        is_important        = MAX(news.is_important, excluded.is_important),
        alpha_score         = MAX(news.alpha_score, excluded.alpha_score),
        sent_to_wecom       = MAX(news.sent_to_wecom, excluded.sent_to_wecom),
        business_category   = CASE WHEN excluded.business_category != '' THEN excluded.business_category ELSE news.business_category END,
        competitor_category = CASE WHEN excluded.competitor_category != '' THEN excluded.competitor_category ELSE news.competitor_category END,
        detail              = CASE WHEN excluded.detail != ''              THEN excluded.detail             ELSE news.detail END,
        impact              = CASE WHEN excluded.impact != ''              THEN excluded.impact             ELSE news.impact END,
        bitv_action         = CASE WHEN excluded.bitv_action != ''          THEN excluded.bitv_action        ELSE news.bitv_action END,
        timestamp           = news.timestamp,   -- 保留首次入库时间
        created_at          = news.created_at
    `),

    updateByUrl:   db.prepare('UPDATE news SET sent_to_wecom=1 WHERE url=?'),
    updateByTitle: db.prepare('UPDATE news SET sent_to_wecom=1 WHERE title=? AND source=?'),
    updateByNorm:  db.prepare('UPDATE news SET sent_to_wecom=1 WHERE normalized_title=?'),

    getByUrls:     (placeholders) => db.prepare(
      `SELECT url, title, normalized_title, source, business_category, sent_to_wecom, timestamp FROM news WHERE url IN (${placeholders})`
    ),
    getByNorm:     db.prepare(
      'SELECT url, sent_to_wecom, business_category, timestamp FROM news WHERE normalized_title=? ORDER BY sent_to_wecom DESC, timestamp DESC LIMIT 1'
    ),
    checkSent:     db.prepare(
      'SELECT sent_to_wecom FROM news WHERE (url=? OR normalized_title=?) AND sent_to_wecom=1 LIMIT 1'
    ),

    // 统计
    countAll:      db.prepare('SELECT COUNT(*) as n FROM news'),
    countImportant:db.prepare('SELECT COUNT(*) as n FROM news WHERE is_important=1'),
    countByCat:    db.prepare('SELECT business_category, COUNT(*) as n FROM news WHERE timestamp > ? AND business_category != \'\' GROUP BY business_category ORDER BY n DESC'),
    countBySrc:    db.prepare('SELECT source, COUNT(*) as n FROM news GROUP BY source ORDER BY n DESC LIMIT 30'),
  };
}

// ── saveNews ──────────────────────────────────────────────────────────────────
async function saveNews(items) {
  if (!USE_SUPABASE) {
    // 1. SQLite 事务批量写入
    const tx = db.transaction((rows) => {
      for (const item of rows) {
        const nTitle = normalizeKey(item.title, '').split('|')[0];
        const row    = {
          ...item,
          normalized_title:    nTitle,
          detail:              item.detail              || '',
          business_category:   item.business_category   || '',
          competitor_category: item.competitor_category || '',
          sent_to_wecom:       item.sent_to_wecom        || 0,
          content:             (item.content || '').substring(0, 500),
        };
        try {
          STMT.insert.run(row);
        } catch (err) {
          if (err.message.includes('UNIQUE constraint failed: news.url')) {
            // URL 冲突单独处理（更新除时间戳外的字段）
            db.prepare(`
              UPDATE news SET
                title               = @title,
                normalized_title    = @normalized_title,
                is_important        = MAX(is_important, @is_important),
                sent_to_wecom       = MAX(sent_to_wecom, @sent_to_wecom),
                business_category   = CASE WHEN @business_category!='' THEN @business_category ELSE business_category END,
                competitor_category = CASE WHEN @competitor_category!='' THEN @competitor_category ELSE competitor_category END,
                detail              = CASE WHEN @detail!='' THEN @detail ELSE detail END
              WHERE url = @url
            `).run(row);
          } else {
            console.warn('[DB insert]', err.message?.substring(0, 80), '|', item.title?.substring(0, 40));
          }
        }
      }
    });

    try { tx(items); } catch (e) { console.error('[DB saveNews fatal]', e.message); }
  }

  // 2. Supabase 同步（批量 upsert）
  if (USE_SUPABASE && supabase && items.length > 0) {
    const seen      = new Set();
    const cleanRows = items
      .filter(i => i.url && !seen.has(i.url) && seen.add(i.url))
      .map(i => {
        const nTitle = normalizeKey(i.title, '').split('|')[0];
        return {
          title:               i.title,
          normalized_title:    nTitle,
          content:             (i.content || '').substring(0, 500),
          detail:              i.detail              || '',
          source:              i.source,
          url:                 i.url,
          category:            i.category            || 'Signals',
          business_category:   i.business_category   || '',
          competitor_category: i.competitor_category || '',
          timestamp:           Math.round(i.timestamp || 0),
          is_important:        i.is_important         || 0,
          sent_to_wecom:       i.sent_to_wecom        || 0,
        };
      });

    // 分批 upsert（Supabase 单次上限 ~500 行）
    for (let i = 0; i < cleanRows.length; i += DB.SUPABASE_CHUNK_SIZE) {
      const chunk = cleanRows.slice(i, i + DB.SUPABASE_CHUNK_SIZE);
      const { error } = await supabase.from('news').upsert(chunk, { onConflict: 'url' });
      if (error) console.error('[Supabase upsert]', error.message);
    }
  }
}

// ── getNews（增加搜索参数）───────────────────────────────────────────────────
async function getNews(limit = 100, source = null, important = 0, search = '') {
  if (USE_SUPABASE && supabase) {
    return await getNewsFromSupabase(limit, source, important, search);
  }
  
  let sql    = 'SELECT * FROM news WHERE 1=1 ';
  const params = [];

  if (important === 1) {
    sql += 'AND is_important=1 ';
  } else if (source && source !== 'All') {
    sql += 'AND source=? ';
    params.push(source);
  }

  if (search) {
    sql += "AND (title LIKE ? OR content LIKE ? OR detail LIKE ?) ";
    const like = `%${search}%`;
    params.push(like, like, like);
  }

  sql += 'ORDER BY timestamp DESC LIMIT ?';
  params.push(limit);

  return db.prepare(sql).all(...params);
}

async function getNewsFromSupabase(limit = 100, source = null, important = 0, search = '') {
  if (!supabase) {
    return [];
  }
  
  let query = supabase.from('news').select('*').order('timestamp', { ascending: false }).limit(limit);
  
  if (important === 1) {
    query = query.eq('is_important', 1);
  } else if (source && source !== 'All') {
    query = query.eq('source', source);
  }
  
  if (search) {
    query = query.or(`title.ilike.%${search}%,content.ilike.%${search}%,detail.ilike.%${search}%`);
  }
  
  const { data, error } = await query;
  if (error) {
    console.error('[Supabase getNews]', error.message);
    return [];
  }
  return data || [];
}

// ── getStats（供健康检查 + 前端图表使用）──────────────────────────────────────
async function getStats(since = 0) {
  if (USE_SUPABASE && supabase) {
    return await getStatsFromSupabase(since);
  }
  
  const sinceTs = since || (Date.now() - 7 * 24 * 3600 * 1000);
  return {
    total:      STMT.countAll.get().n,
    important:  STMT.countImportant.get().n,
    categories: STMT.countByCat.all(sinceTs),
    sources:    STMT.countBySrc.all(),
  };
}

async function getStatsFromSupabase(since = 0) {
  console.log('[getStatsFromSupabase] Called, supabase:', !!supabase, 'USE_SUPABASE:', USE_SUPABASE);
  if (!supabase) {
    console.log('[getStatsFromSupabase] No supabase client');
    return { total: 0, important: 0, categories: [], sources: [] };
  }
  
  const sinceTs = since || (Date.now() - 7 * 24 * 3600 * 1000);
  
  try {
    const [{ count: total }, { count: important }, { data: categories }, { data: sources }] = await Promise.all([
      supabase.from('news').select('*', { count: 'exact', head: true }),
      supabase.from('news').select('*', { count: 'exact', head: true }).eq('is_important', 1),
      supabase.from('news').select('business_category, count').gte('timestamp', sinceTs).neq('business_category', ''),
      supabase.from('news').select('source, count').limit(30)
    ]);
    
    return {
      total: total || 0,
      important: important || 0,
      categories: (categories || []).map(c => ({ business_category: c.business_category, n: c.count })),
      sources: (sources || []).map(s => ({ source: s.source, n: s.count }))
    };
  } catch (e) {
    console.error('[getStatsFromSupabase]', e.message);
    return { total: 0, important: 0, categories: [], sources: [] };
  }
}

// ── getAlreadyProcessed（批量查询，性能优化版）────────────────────────────────
async function getAlreadyProcessed(items) {
  const processed        = new Set();
  const sentToWeCom      = new Set();
  const existingTimestamps = new Map();
  if (!items?.length) return { processed, sentToWeCom, existingTimestamps };

  const urls = items.map(i => i.url).filter(Boolean);

  if (USE_SUPABASE && supabase) {
    // Supabase: 分批批量查询
    for (let i = 0; i < items.length; i += DB.SUPABASE_CHUNK_SIZE) {
      const chunk      = items.slice(i, i + DB.SUPABASE_CHUNK_SIZE);
      const chunkUrls  = chunk.map(c => c.url).filter(Boolean);

      const { data }   = await supabase.from('news')
        .select('url, title, source, business_category, sent_to_wecom, timestamp')
        .in('url', chunkUrls);

      const foundUrls  = new Set();
      (data || []).forEach(r => {
        foundUrls.add(r.url);
        const nKey = normalizeKey(r.title, r.source);
        if (r.business_category)  { processed.add(r.url);   processed.add(nKey); }
        if (r.sent_to_wecom)      { sentToWeCom.add(r.url); sentToWeCom.add(nKey); }
        if (r.timestamp)          { existingTimestamps.set(r.url, r.timestamp); existingTimestamps.set(nKey, r.timestamp); }
      });

      // 二轮：URL未命中的用 title 查
      const notFound = chunk.filter(c => c.url && !foundUrls.has(c.url));
      if (notFound.length > 0) {
        const { data: td } = await supabase.from('news')
          .select('url, title, source, sent_to_wecom, business_category, timestamp')
          .in('title', notFound.map(c => c.title));
        (td || []).forEach(r => {
          const nKey = normalizeKey(r.title, r.source);
          const m    = notFound.find(i => normalizeKey(i.title, i.source) === nKey);
          if (!m) return;
          if (r.business_category)  { processed.add(m.url);   processed.add(nKey); }
          if (r.sent_to_wecom)      { sentToWeCom.add(m.url); sentToWeCom.add(nKey); }
          if (r.timestamp)          { existingTimestamps.set(m.url, r.timestamp); existingTimestamps.set(nKey, r.timestamp); }
        });
      }
    }
  } else {
    // SQLite：批量 IN 查询（避免逐条查询）
    if (urls.length > 0) {
      const ph = urls.map(() => '?').join(',');
      STMT.getByUrls(ph).all(...urls).forEach(r => {
        const nKey   = r.normalized_title + '|' + (r.source || '').toLowerCase();
        const nTitle = r.normalized_title;
        if (r.business_category)  { processed.add(r.url);   processed.add(nKey); processed.add(nTitle); }
        if (r.sent_to_wecom === 1){ sentToWeCom.add(r.url); sentToWeCom.add(nKey); sentToWeCom.add(nTitle); }
        if (r.timestamp)          { existingTimestamps.set(r.url, r.timestamp); existingTimestamps.set(nKey, r.timestamp); }
      });
    }

    // 补充：通过 normalized_title 匹配（URL 可能已变）
    for (const item of items) {
      const nTitle = normalizeKey(item.title, '').split('|')[0];
      const nKey   = `${nTitle}|${(item.source || '').toLowerCase()}`;
      if (processed.has(nTitle) && sentToWeCom.has(nTitle)) continue;

      const row = STMT.getByNorm.get(nTitle);
      if (row) {
        if (row.business_category)  { processed.add(nKey);   processed.add(nTitle); }
        if (row.sent_to_wecom === 1){ sentToWeCom.add(nKey); sentToWeCom.add(nTitle); if (item.url) sentToWeCom.add(item.url); }
        if (row.timestamp)          { existingTimestamps.set(nKey, row.timestamp); if (item.url) existingTimestamps.set(item.url, row.timestamp); }
      }
    }
  }

  return { processed, sentToWeCom, existingTimestamps };
}

// ── updateSentStatus ──────────────────────────────────────────────────────────
async function updateSentStatus(item) {
  const nTitle = normalizeKey(item.title, '').split('|')[0];
  
  if (!USE_SUPABASE) {
    try {
      db.transaction(() => {
        if (item.url) STMT.updateByUrl.run(item.url);
        STMT.updateByTitle.run(item.title, item.source);
        STMT.updateByNorm.run(nTitle);
      })();
    } catch (e) {
      console.warn('[updateSentStatus SQLite]', e.message?.substring(0, 60));
    }
  }

  if (USE_SUPABASE && supabase) {
    try {
      await supabase.from('news').upsert({
        title:               item.title,
        source:              item.source,
        url:                 item.url   || '',
        content:             (item.content || '').substring(0, 500),
        category:            item.category            || '',
        business_category:   item.business_category   || '',
        competitor_category: item.competitor_category || '',
        detail:              item.detail              || '',
        timestamp:           item.timestamp           || Date.now(),
        is_important:        item.is_important         || 1,
        sent_to_wecom:       1,
      }, { onConflict: 'title,source' });
    } catch (e) {
      console.warn('[updateSentStatus Supabase]', e.message?.substring(0, 60));
    }
  }
}

// ── 内容指纹（用于增强去重）────────────────────────────────────────────────────
/**
 * 生成内容指纹（简化版 hash，用于快速比较）
 */
function contentFingerprint(content) {
  if (!content) return '';
  // 移除 HTML 标签、空白、标点，只保留核心文本
  const clean = content
    .replace(/<[^>]*>/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
  
  // 简单 hash：取前 200 字符的 CRC32 风格校验和
  let hash = 0;
  const str = clean.substring(0, 200);
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32bit integer
  }
  return hash.toString(36);
}

// ── 消息源追踪 ────────────────────────────────────────────────────────────────
let sourceTrackingStmts = null;
if (!USE_SUPABASE) {
  sourceTrackingStmts = {
    get: db.prepare('SELECT * FROM source_tracking WHERE source = ?'),
    upsert: db.prepare(`
      INSERT INTO source_tracking (source, last_pushed_timestamp, last_pushed_title)
      VALUES (?, ?, ?)
      ON CONFLICT(source) DO UPDATE SET
        last_pushed_timestamp = excluded.last_pushed_timestamp,
        last_pushed_title = excluded.last_pushed_title,
        last_updated = CURRENT_TIMESTAMP
    `),
    getAll: db.prepare('SELECT * FROM source_tracking ORDER BY source'),
  };
}

/**
 * 获取某消息源的最后推送时间戳
 */
async function getSourceLastPush(source) {
  if (USE_SUPABASE && supabase) {
    try {
      const { data, error } = await supabase
        .from('source_tracking')
        .select('last_pushed_timestamp')
        .eq('source', source)
        .maybeSingle();
      if (error) throw error;
      return data ? data.last_pushed_timestamp : 0;
    } catch (e) {
      console.warn('[getSourceLastPush Supabase]', e.message);
      return 0;
    }
  }
  const row = sourceTrackingStmts.get.get(source);
  return row ? row.last_pushed_timestamp : 0;
}

/**
 * 更新某消息源的最后推送时间戳
 */
async function updateSourcePush(source, timestamp, title) {
  if (USE_SUPABASE && supabase) {
    try {
      const { error } = await supabase
        .from('source_tracking')
        .upsert({
          source,
          last_pushed_timestamp: timestamp,
          last_pushed_title: title,
          last_updated: new Date().toISOString()
        }, { onConflict: 'source' });
      if (error) throw error;
    } catch (e) {
      console.warn('[updateSourcePush Supabase]', e.message);
    }
    return;
  }
  
  try {
    sourceTrackingStmts.upsert.run(source, timestamp, title);
  } catch (e) {
    console.warn('[updateSourcePush SQLite]', e.message?.substring(0, 60));
  }
}

/**
 * 获取所有消息源的追踪信息
 */
async function getAllSourceTracking() {
  if (USE_SUPABASE && supabase) {
    try {
      const { data, error } = await supabase
        .from('source_tracking')
        .select('*')
        .order('source');
      if (error) throw error;
      return data || [];
    } catch (e) {
      console.warn('[getAllSourceTracking Supabase]', e.message);
      return [];
    }
  }
  return sourceTrackingStmts.getAll.all();
}

/**
 * 检查消息是否应该被推送（基于来源冷却时间）
 * @param {string} source - 消息来源
 * @param {string} title - 消息标题
 * @param {number} timestamp - 消息时间戳
 * @param {number} cooldownHours - 冷却时间（小时）
 * @returns {Promise<boolean>} - 是否可以推送
 */
async function canPushMessage(source, title, timestamp, cooldownHours = 24) {
  const lastPush = await getSourceLastPush(source);
  if (!lastPush) return true; // 从未推送过，允许推送
  
  // 检查距离上次推送是否已过冷却期
  const cooldownMs = cooldownHours * 60 * 60 * 1000;
  if (Date.now() - lastPush < cooldownMs) {
    // 还在冷却期内，检查是否是相似标题
    let lastPushedTitle = '';
    if (USE_SUPABASE && supabase) {
      try {
        const { data } = await supabase.from('source_tracking').select('last_pushed_title').eq('source', source).maybeSingle();
        lastPushedTitle = data?.last_pushed_title || '';
      } catch (_) {}
    } else {
      const row = sourceTrackingStmts.get.get(source);
      lastPushedTitle = row?.last_pushed_title || '';
    }

    if (lastPushedTitle) {
      const normalizedNew = normalizeKey(title, '').split('|')[0];
      const normalizedLast = normalizeKey(lastPushedTitle, '').split('|')[0];
      if (normalizedNew === normalizedLast) {
        return false; // 相似标题，跳过
      }
    }
  }
  return true;
}

/**
 * 统一检查消息是否已发送
 */
async function checkIfSent(url, nTitle) {
  if (USE_SUPABASE && supabase) {
    try {
      const { data, error } = await supabase
        .from('news')
        .select('sent_to_wecom')
        .or(`url.eq."${url}",normalized_title.eq."${nTitle}"`)
        .eq('sent_to_wecom', 1)
        .limit(1)
        .maybeSingle();
      return !!data;
    } catch (e) {
      return false;
    }
  }
  try {
    return !!STMT.checkSent.get(url, nTitle);
  } catch (e) {
    return false;
  }
}

module.exports = { 
  db, 
  saveNews, 
  getNews, 
  getStats, 
  getAlreadyProcessed, 
  updateSentStatus, 
  normalizeKey,
  contentFingerprint,
  getSourceLastPush,
  updateSourcePush,
  getAllSourceTracking,
  canPushMessage,
  checkIfSent,
};
