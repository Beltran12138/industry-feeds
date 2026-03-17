'use strict';

const { createClient } = require('@supabase/supabase-js');
const path         = require('path');
require('dotenv').config();

// ── UTF-8 文本清理工具（修复中文乱码）──────────────────────────────────────────
/**
 * 清理和规范化中文字符串，移除乱码字符
 * @param {string} text - 输入文本
 * @returns {string} - 清理后的文本
 */
function cleanChineseText(text) {
  if (!text || typeof text !== 'string') return '';
  
  // 1. 移除常见的乱码字符（Unicode 替换字符、控制字符等）
  let cleaned = text
    .replace(/\uFFFD/g, '')           // 移除 Unicode 替换字符 ()
    .replace(/[\u0000-\u001F\u007F-\u009F]/g, '') // 移除控制字符
    .replace(/\s+/g, ' ')             // 合并多余空白
    .trim();
  
  // 2. 检测并修复重复编码的中文（如 "鏁" 这种典型的双 UTF-8 编码问题）
  // 这些字符通常是 GBK 被误认为 UTF-8 再次编码产生的
  const mojibakePatterns = [
    [/[\u0080-\u00FF]{2,}/g, ''],     // 连续的高位拉丁字母（可能是双编码）
    [/[\u0100-\u017F]{2,}/g, ''],     // 带音调的拉丁字母
  ];
  
  for (const [pattern, replacement] of mojibakePatterns) {
    // 只在检测到明显乱码时才应用
    const testMatch = cleaned.match(pattern);
    if (testMatch && testMatch.length > 2) {
      cleaned = cleaned.replace(pattern, replacement);
    }
  }
  
  // 3. 确保至少包含一些有效字符（防止清理后为空）
  const hasValidChars = /[\u4e00-\u9fa5a-zA-Z0-9]/.test(cleaned);
  if (!hasValidChars && text.length > 0) {
    // 如果清理后没有任何有效字符，返回原文本（保守策略）
    return text.trim();
  }
  
  return cleaned;
}

/**
 * 深度清理对象中的所有字符串字段
 * @param {Object} obj - 输入对象
 * @returns {Object} - 清理后的对象
 */
function cleanObjectStrings(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  
  const cleaned = {};
  for (const [key, value] of Object.entries(obj)) {
    if (typeof value === 'string') {
      cleaned[key] = cleanChineseText(value);
    } else {
      cleaned[key] = value;
    }
  }
  return cleaned;
}

let DB;
try {
  DB = require('./config').DB;
} catch (e) {
  DB = { SUPABASE_CHUNK_SIZE: 100, NEWS_FETCH_LIMIT: 500 };
}

const USE_SUPABASE = (process.env.USE_SUPABASE || '').trim() === 'true';
const IS_VERCEL = process.env.VERCEL === 'true';

let supabase = null;
if ((USE_SUPABASE || IS_VERCEL) && process.env.SUPABASE_URL && process.env.SUPABASE_KEY) {
  supabase = createClient(process.env.SUPABASE_URL.trim(), process.env.SUPABASE_KEY.trim());
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

// Always initialize SQLite as a local cache/secondary storage
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
  CREATE TABLE IF NOT EXISTS insights (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    trend_key TEXT UNIQUE,
    summary TEXT,
    evidence_count INTEGER DEFAULT 1,
    first_seen INTEGER,
    last_updated INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  -- 核心查询索引
  CREATE INDEX IF NOT EXISTS idx_timestamp       ON news(timestamp DESC);
  CREATE INDEX IF NOT EXISTS idx_source          ON news(source);
  CREATE INDEX IF NOT EXISTS idx_is_important    ON news(is_important);
  CREATE INDEX IF NOT EXISTS idx_alpha_score     ON news(alpha_score DESC);
  CREATE INDEX IF NOT EXISTS idx_business_cat    ON news(business_category);
  CREATE INDEX IF NOT EXISTS idx_sent_wecom      ON news(sent_to_wecom);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_title_source ON news(title, source);
  CREATE INDEX IF NOT EXISTS idx_normalized_title ON news(normalized_title);

  -- 复合索引（优化常见查询模式）
  CREATE INDEX IF NOT EXISTS idx_source_timestamp ON news(source, timestamp DESC);
  CREATE INDEX IF NOT EXISTS idx_business_timestamp ON news(business_category, timestamp DESC);
  CREATE INDEX IF NOT EXISTS idx_important_timestamp ON news(is_important, timestamp DESC);
  CREATE INDEX IF NOT EXISTS idx_alpha_timestamp ON news(alpha_score DESC, timestamp DESC);

  -- 趋势查询优化（按日期聚合）
  CREATE INDEX IF NOT EXISTS idx_timestamp_business ON news(timestamp, business_category);

  -- 搜索优化（全文搜索前置）
  CREATE INDEX IF NOT EXISTS idx_title_search ON news(title COLLATE NOCASE);

  -- 其他表索引
  CREATE INDEX IF NOT EXISTS idx_source_tracking ON source_tracking(source);
  CREATE INDEX IF NOT EXISTS idx_insight_key     ON insights(trend_key);
  CREATE INDEX IF NOT EXISTS idx_insight_updated ON insights(last_updated DESC);
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
    `SELECT url, title, normalized_title, source, business_category, sent_to_wecom, timestamp FROM news WHERE url IN (${placeholders})`,
  ),
  getByNorm:     db.prepare(
    'SELECT url, sent_to_wecom, business_category, timestamp FROM news WHERE normalized_title=? ORDER BY sent_to_wecom DESC, timestamp DESC LIMIT 1',
  ),
  checkSent:     db.prepare(
    'SELECT sent_to_wecom FROM news WHERE (url=? OR normalized_title=?) AND sent_to_wecom=1 LIMIT 1',
  ),

  // Insights
  insertInsight: db.prepare(`
    INSERT INTO insights (trend_key, summary, evidence_count, first_seen, last_updated)
    VALUES (@trend_key, @summary, @evidence_count, @first_seen, @last_updated)
    ON CONFLICT(trend_key) DO UPDATE SET
      summary = excluded.summary,
      evidence_count = insights.evidence_count + 1,
      last_updated = excluded.last_updated
  `),
  getInsights: db.prepare('SELECT * FROM insights ORDER BY last_updated DESC LIMIT ?'),

  // 统计
  countAll:      db.prepare('SELECT COUNT(*) as n FROM news'),
  countImportant:db.prepare('SELECT COUNT(*) as n FROM news WHERE is_important=1'),
  countByCat:    db.prepare("SELECT business_category, COUNT(*) as n FROM news WHERE timestamp > ? AND business_category != '' GROUP BY business_category ORDER BY n DESC"),
  countBySrc:    db.prepare('SELECT source, COUNT(*) as n FROM news GROUP BY source ORDER BY n DESC LIMIT 30'),
};

// ── saveNews ──────────────────────────────────────────────────────────────────
async function saveNews(items) {
  // 预处理：清理所有文本字段的编码问题
  const cleanedItems = items.map(item => cleanObjectStrings(item));
  
  // 1. SQLite 事务批量写入 (Always run as primary or backup storage)
  const tx = db.transaction((rows) => {
    for (const item of rows) {
      const nTitle = normalizeKey(item.title, '').split('|')[0];
      const row    = {
        title:               item.title               || '',
        source:              item.source              || '',
        url:                 item.url                 || '',
        category:            item.category            || 'Announcement',
        timestamp:           item.timestamp           || Date.now(),
        is_important:        item.is_important        || 0,
        alpha_score:         item.alpha_score         || 0,
        ...item,
        normalized_title:    nTitle,
        detail:              item.detail              || '',
        impact:              item.impact              || '中性',
        bitv_action:         item.bitv_action         || '关注后续发展',
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

  try { tx(cleanedItems); } catch (e) { console.error('[DB saveNews fatal]', e.message); }


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
          impact:              i.impact              || '',
          bitv_action:         i.bitv_action         || '',
          alpha_score:         i.alpha_score         || 0,
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
  // 在 Vercel 环境下，如果没有明确禁用 Supabase 且凭据存在，优先使用 Supabase
  const shouldTrySupabase = (USE_SUPABASE || IS_VERCEL) && supabase;
  
  if (shouldTrySupabase) {
    const supabaseNews = await getNewsFromSupabase(limit, source, important, search);
    // 如果 Supabase 有数据，直接返回
    if (supabaseNews && supabaseNews.length > 0) {
      return supabaseNews;
    }
    // 如果是 Vercel 且 Supabase 没数据，可能还没同步，继续尝试本地（虽然 Vercel 本地通常为空）
  }
  
  // 生成缓存键
  const cacheKey = `news:${limit}:${source || 'all'}:${important}:${search.substring(0, 20)}`;
  
  // 尝试从 Redis 获取（仅当无搜索条件时）
  if (!search) {
    try {
      const cache = require('./lib/redis-cache');
      if (cache.isEnabled) {
        const cached = await cache.get(cacheKey);
        if (cached) {
          return cached;
        }
      }
    } catch (e) {
      // 忽略缓存错误
    }
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
    sql += 'AND (title LIKE ? OR content LIKE ? OR detail LIKE ?) ';
    const like = `%${search}%`;
    params.push(like, like, like);
  }

  sql += 'ORDER BY timestamp DESC LIMIT ?';
  params.push(limit);

  const result = db.prepare(sql).all(...params);
  
  // 存入 Redis 缓存（2 分钟，新闻更新频繁）
  if (!search) {
    try {
      const cache = require('./lib/redis-cache');
      if (cache.isEnabled && cache.isConnected()) {
        await cache.set(cacheKey, result, 120);
      }
    } catch (e) {
      // 忽略缓存错误
    }
  }
  
  return result;
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
  // 在 Vercel 环境下优先使用 Supabase
  if ((USE_SUPABASE || IS_VERCEL) && supabase) {
    try {
      const { data: countData } = await supabase.from('news').select('is_important', { count: 'exact', head: true });
      const { data: impData } = await supabase.from('news').select('is_important', { count: 'exact', head: true }).eq('is_important', 1);
      
      // 注意：复杂的聚合查询在 Supabase client 中较难直接通过 select 实现
      // 这里可以简单返回计数，或者后续扩展为调用 RPC
      return {
        total: countData?.length || 0,
        important: impData?.length || 0,
        sources: [],
        categories: []
      };
    } catch (e) {
      console.error('[Supabase getStats]', e.message);
    }
  }

  // 尝试从 Redis 缓存获取（如果启用）
  let cacheKey = `stats:${since || 'all'}`;
  let cached = null;
  
  try {
    const cache = require('./lib/redis-cache');
    if (cache.isEnabled) {
      cached = await cache.get(cacheKey);
      if (cached) {
        return cached;
      }
    }
  } catch (e) {
    // Redis 不可用，继续使用 SQLite
  }
  
  // 优先使用本地 SQLite 统计（保证数据一致性）
  // 即使配置了 Supabase，也先返回本地数据（更快、更可靠）
  const total = STMT.countAll.get().n;
  const important = STMT.countImportant.get().n;
  const sources = STMT.countBySrc.all();
  
  // 分类统计支持时间范围过滤（用于趋势分析），默认不过滤
  const sinceTs = since || 0;
  const categories = STMT.countByCat.all(sinceTs);
  
  const result = {
    total,
    important,
    categories,
    sources,
  };
  
  // 存入 Redis 缓存（5 分钟）
  try {
    const cache = require('./lib/redis-cache');
    if (cache.isEnabled && cache.isConnected()) {
      await cache.set(cacheKey, result, 300);
    }
  } catch (e) {
    // 忽略缓存错误
  }
  
  return result;
}

async function getStatsFromSupabase(since = 0) {
  if (!supabase) {
    return { total: 0, important: 0, categories: [], sources: [] };
  }

  const sinceTs = since || (Date.now() - 7 * 24 * 3600 * 1000);

  try {
    // Use server-side aggregation RPCs (see sql/stats-rpc.sql)
    const [
      { count: total },
      { count: important },
      catResult,
      srcResult,
    ] = await Promise.all([
      supabase.from('news').select('*', { count: 'exact', head: true }),
      supabase.from('news').select('*', { count: 'exact', head: true }).eq('is_important', 1),
      supabase.rpc('get_category_stats', { since_ts: sinceTs }),
      supabase.rpc('get_source_stats'),
    ]);

    let categories, sources;

    // RPC succeeded
    if (!catResult.error && catResult.data) {
      categories = catResult.data;
    } else {
      // Fallback: client-side aggregation (before RPC is deployed)
      console.warn('[Stats] RPC get_category_stats not available, falling back to client-side');
      const { data: catRows } = await supabase.from('news').select('business_category').gte('timestamp', sinceTs).neq('business_category', '');
      const catMap = {};
      (catRows || []).forEach(r => { const c = r.business_category; if (c) catMap[c] = (catMap[c] || 0) + 1; });
      categories = Object.entries(catMap).map(([business_category, n]) => ({ business_category, n })).sort((a, b) => b.n - a.n);
    }

    if (!srcResult.error && srcResult.data) {
      sources = srcResult.data;
    } else {
      console.warn('[Stats] RPC get_source_stats not available, falling back to client-side');
      const { data: srcRows } = await supabase.from('news').select('source');
      const srcMap = {};
      (srcRows || []).forEach(r => { const s = r.source; if (s) srcMap[s] = (srcMap[s] || 0) + 1; });
      sources = Object.entries(srcMap).map(([source, n]) => ({ source, n })).sort((a, b) => b.n - a.n).slice(0, 30);
    }

    return {
      total: total || 0,
      important: important || 0,
      categories,
      sources,
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
        const nTitle = normalizeKey(r.title, '').split('|')[0];
        if (r.business_category)  { processed.add(r.url);   processed.add(nKey); processed.add(nTitle); }
        if (r.sent_to_wecom)      { sentToWeCom.add(r.url); sentToWeCom.add(nKey); sentToWeCom.add(nTitle); }
        if (r.timestamp)          { existingTimestamps.set(r.url, r.timestamp); existingTimestamps.set(nKey, r.timestamp); existingTimestamps.set(nTitle, r.timestamp); }
      });

      // 二轮：URL未命中的用 title 查
      const notFound = chunk.filter(c => c.url && !foundUrls.has(c.url));
      if (notFound.length > 0) {
        const { data: td } = await supabase.from('news')
          .select('url, title, source, sent_to_wecom, business_category, timestamp')
          .in('title', notFound.map(c => c.title));
        (td || []).forEach(r => {
          const nKey = normalizeKey(r.title, r.source);
          const nTitle = normalizeKey(r.title, '').split('|')[0];
          const m    = notFound.find(i => normalizeKey(i.title, i.source) === nKey);
          if (!m) return;
          if (r.business_category)  { processed.add(m.url);   processed.add(nKey); processed.add(nTitle); }
          if (r.sent_to_wecom)      { sentToWeCom.add(m.url); sentToWeCom.add(nKey); sentToWeCom.add(nTitle); }
          if (r.timestamp)          { existingTimestamps.set(m.url, r.timestamp); existingTimestamps.set(nKey, r.timestamp); existingTimestamps.set(nTitle, r.timestamp); }
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
        impact:              item.impact              || '',
        bitv_action:         item.bitv_action         || '',
        alpha_score:         item.alpha_score         || 0,
        normalized_title:    nTitle,
        detail:              item.detail              || '',
        timestamp:           item.timestamp           || Date.now(),
        is_important:        item.is_important         || 1,
        sent_to_wecom:       1,
      }, { onConflict: 'url' });
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
          last_updated: new Date().toISOString(),
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
      } catch (_) {
        // Ignore supabase errors, use fallback
      }
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
      // Use separate .eq() filters combined via Supabase .or() with safe column filters
      // Avoid string interpolation to prevent PostgREST filter injection
      let found = false;
      if (url) {
        const { data } = await supabase
          .from('news')
          .select('sent_to_wecom')
          .eq('url', url)
          .eq('sent_to_wecom', 1)
          .limit(1)
          .maybeSingle();
        if (data) found = true;
      }
      if (!found && nTitle) {
        const { data } = await supabase
          .from('news')
          .select('sent_to_wecom')
          .eq('normalized_title', nTitle)
          .eq('sent_to_wecom', 1)
          .limit(1)
          .maybeSingle();
        if (data) found = true;
      }
      return found;
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
  supabase,
  STMT,
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
  // UTF-8 清理工具
  cleanChineseText,
  cleanObjectStrings,
};

// ── 注册 SQLite 自定义函数（模拟 Supabase RPC）──────────────────────────────
try {
  const { registerFunctions } = require('./sqlite-functions');
  registerFunctions(db);
} catch (e) {
  // SQLite functions module not available
}
