'use strict';
/**
 * scrapers/utils.js — 爬虫公共工具函数
 */

const { SCRAPER } = require('../config');

/**
 * 睡眠
 */
const sleep = ms => new Promise(r => setTimeout(r, ms));

/**
 * 构建标准新闻条目骨架
 */
function makeItem({ title, content = '', source, url, category = 'Announcement', timestamp = 0 }) {
  return {
    title:       (title || '').trim().substring(0, SCRAPER.TITLE_MAX_LEN),
    content:     (content || '').substring(0, SCRAPER.CONTENT_MAX_LEN),
    source,
    url:         (url || '').trim(),
    category,
    timestamp,
    is_important: 0,
  };
}

/**
 * 严格时间戳解析。
 * 解决问题：多处 Date.now() fallback 导致旧新闻被标记为"刚刚发布"。
 *
 * 规则：
 *   - 返回有效的毫秒时间戳（> 2020-01-01）
 *   - 无法解析时返回 0（调用方自行决定是否丢弃或赋值 Date.now()）
 *
 * @param {string|number} raw  原始时间值
 * @returns {number}  毫秒时间戳，0 = 无效
 */
function parseTimestamp(raw) {
  if (!raw) return 0;

  const YEAR_2020 = 1577836800000; // 2020-01-01 的毫秒时间戳

  let ms = 0;

  if (typeof raw === 'number') {
    // 秒级时间戳（10位）转毫秒
    ms = raw < 10_000_000_000 ? raw * 1000 : raw;
  } else if (typeof raw === 'string') {
    // ISO 字符串
    if (raw.includes('T') || raw.includes('-')) {
      ms = new Date(raw).getTime();
    } else {
      // 纯数字字符串
      const n = Number(raw);
      if (!isNaN(n)) {
        ms = n < 10_000_000_000 ? n * 1000 : n;
      }
    }
  }

  return (ms > YEAR_2020 && !isNaN(ms)) ? ms : 0;
}

/**
 * 从文本中提取日期时间戳（多种格式）
 * 返回 0 = 未能解析
 *
 * @param {string} text  包含时间信息的文本
 * @param {boolean} allowTimeOnly  是否允许仅 HH:MM 格式（默认 false）。
 *   仅对实时快讯源（如 BlockBeats）传 true，SSR/API 源应保持 false
 *   以避免将旧文章误标记为"今天"
 */
function extractTimestamp(text, allowTimeOnly = false) {
  if (!text) return 0;

  // 1. 优先尝试完整的日期格式 (YYYY-MM-DD 或 YYYY/MM/DD 或 DD.MM.YYYY)
  const datePatterns = [
    /(\d{4}[-/]\d{1,2}[-/]\d{1,2})/,
    /(\d{1,2})\.(\d{1,2})\.(\d{4})/,  // DD.MM.YYYY
    /([A-Za-z]{3,9}\.?\s+\d{1,2},?\s+\d{4})/,  // Jan 1, 2025
  ];
  for (const re of datePatterns) {
    const m = text.match(re);
    if (m) {
      let dStr = m[0];
      // DD.MM.YYYY → YYYY-MM-DD
      if (/^\d{1,2}\.\d{1,2}\.\d{4}$/.test(dStr)) {
        const parts = dStr.split('.');
        dStr = `${parts[2]}-${parts[1]}-${parts[0]}`;
      }
      const ts = new Date(dStr).getTime();
      if (ts > 1_577_836_800_000) return ts;
    }
  }

  // 2. 相对时间（如 "3 hours ago"、"2 days ago"、"更新于 5 小时前"）
  const relTs = parseRelativeTime(text);
  if (relTs > 0) return relTs;

  // 3. HH:MM（当天时间）— 仅在 allowTimeOnly=true 时启用
  //    避免 SSR 页面旧文章因提取到 HH:MM 被误标为"今天"
  if (allowTimeOnly) {
    const timeMatch = text.match(/(\d{1,2}):(\d{2})/);
    if (timeMatch) {
      const now = new Date();
      const d   = new Date(
        now.getFullYear(), now.getMonth(), now.getDate(),
        parseInt(timeMatch[1]), parseInt(timeMatch[2])
      );
      let ts = d.getTime();
      // 未来时间说明是昨天
      if (ts > Date.now() + 3_600_000) ts -= 86_400_000;
      return ts;
    }
  }

  return 0;
}

/**
 * "相对时间" → 时间戳
 * 支持英文 "3 hours ago" 和中文 "3小时前"、"更新于 2 天前"
 */
function parseRelativeTime(text) {
  if (!text) return 0;
  const now = Date.now();

  // 英文: "3 hours ago", "1 day ago", "30 minutes ago"
  const enMatch = text.match(/(\d+)\s*(hour|minute|day|week|month)s?\s*ago/i);
  if (enMatch) {
    const num  = parseInt(enMatch[1]);
    const unit = enMatch[2].toLowerCase();
    if (unit.startsWith('minute')) return now - num * 60_000;
    if (unit.startsWith('hour'))   return now - num * 3_600_000;
    if (unit.startsWith('day'))    return now - num * 86_400_000;
    if (unit.startsWith('week'))   return now - num * 7 * 86_400_000;
    if (unit.startsWith('month'))  return now - num * 30 * 86_400_000;
  }

  // 中文: "3小时前"、"2天前"、"30分钟前"、"1周前"
  const cnMatch = text.match(/(\d+)\s*(分钟|小时|天|日|周|个月)\s*前/);
  if (cnMatch) {
    const num  = parseInt(cnMatch[1]);
    const unit = cnMatch[2];
    if (unit === '分钟')     return now - num * 60_000;
    if (unit === '小时')     return now - num * 3_600_000;
    if (unit === '天' || unit === '日') return now - num * 86_400_000;
    if (unit === '周')       return now - num * 7 * 86_400_000;
    if (unit === '个月')     return now - num * 30 * 86_400_000;
  }

  return 0;
}

module.exports = { sleep, makeItem, parseTimestamp, extractTimestamp, parseRelativeTime };
