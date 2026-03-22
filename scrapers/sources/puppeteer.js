'use strict';
/**
 * scrapers/sources/puppeteer.js — 需要浏览器渲染的爬虫
 * 包含：BlockBeats, OSL, WuBlock, Bybit, Bitget, MEXC, Gate,
 *        Polymarket (Breaking + China)
 *
 * 关键改进：所有函数复用 getBrowser() 共享实例，只开/关 tab，不重复 launch/close
 */

'use strict';

const { newPage, releaseBrowser } = require('../browser');
const { SCRAPER }                 = require('../../config');
const { makeItem, parseTimestamp, extractTimestamp, parseRelativeTime, sleep } = require('../utils');
const { cleanChineseText }        = require('../../db'); // 导入中文清理函数

/**
 * 清理项目中的文本字段（标题、内容）
 */
function cleanItemText(item) {
  if (!item) return item;
  const cleaned = {...item};
  if (cleaned.title) cleaned.title = cleanChineseText(cleaned.title);
  if (cleaned.content) cleaned.content = cleanChineseText(cleaned.content);
  return cleaned;
}

// ── BlockBeats ────────────────────────────────────────────────────────────────
async function scrapeBlockBeats() {
  console.log('[Scraper] BlockBeats...');
  const url  = 'https://www.theblockbeats.info/newsflash';
  const page = await newPage();
  try {
    await page.setViewport({ width: 1280, height: 1000 });
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await sleep(8000);

    const items = await page.evaluate(() => {
      const results = [];
      document.querySelectorAll('.news-flash-wrapper').forEach((el) => {
        const titleLnk = el.querySelector('a.news-flash-title');
        if (!titleLnk) return;
        const text = titleLnk.title || titleLnk.innerText.trim();
        const contentEl = el.querySelector('.news-flash-item-content');
        const itemUrl = titleLnk.href || '';

        if (!text || text.length < 5) return;
        if (!itemUrl || itemUrl.includes('weibo.com') || itemUrl.includes('share.php')) return;

        let timestamp = 0;
        const timeMatch = titleLnk.innerText.match(/\d{2}:\d{2}/);
        if (timeMatch) {
          const parts = timeMatch[0].split(':');
          if (parts.length === 2) {
            const d = new Date();
            d.setHours(parseInt(parts[0]), parseInt(parts[1]), 0, 0);
            timestamp = d.getTime();
            if (timestamp > Date.now()) timestamp -= 86400000;
          }
        }
        if (!timestamp) return;

        results.push({
          title:   text.replace(/^\d{2}:\d{2}\s*/, '').substring(0, 150),
          content: contentEl ? contentEl.innerText.trim() : text,
          source:  'BlockBeats',
          url:     itemUrl,
          category:    'Newsflash',
          timestamp,
          is_important: 0,
        });
      });
      return results;
    });

    console.log(`[Scraper] BlockBeats: ${items.length}`);
    return items;
  } catch (err) {
    console.error('[BlockBeats]', err.message);
    return [];
  } finally {
    await page.close();
    releaseBrowser();
  }
}

// ── OSL ───────────────────────────────────────────────────────────────────────
async function scrapeOSL() {
  console.log('[Scraper] OSL...');
  const url  = 'https://www.osl.com/hk/press-release';
  const page = await newPage();
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 90000 });
    await page.waitForSelector('a[href*="/press-release/"]', { timeout: 30000 }).catch(() => {});
    await sleep(5000);

    const items = await page.evaluate(() => {
      const results = [];
      const seen    = new Set();
      document.querySelectorAll('a[href*="/press-release/"]').forEach(link => {
        const href  = link.href;
        // 排除列表页自身
        if (href.endsWith('/press-release') || href.endsWith('/press-release/')) return;
        const rawText = (link.innerText || '').trim();
        // 标题取第一行（日期在第二行），忽略纯日期行
        const lines   = rawText.split('\n').map(s => s.trim()).filter(Boolean);
        const title   = lines[0] || '';
        if (!title || title.length < 8 || seen.has(href)) return;
        seen.add(href);
        // 尝试从链接文本或容器中找日期
        // OSL格式示例："2月 26, 2026" / "Feb 26, 2026" / "2026-02-26"
        const fullText = (link.closest('li,article,[class*="item"],[class*="card"]') || link.parentElement || link).innerText || rawText;
        let ts = 0;
        // 中文月份：1月-12月 DD, YYYY
        const cnMatch = fullText.match(/(\d{1,2})\s*月\s*(\d{1,2}),?\s*(\d{4})/);
        if (cnMatch) {
          ts = new Date(parseInt(cnMatch[3]), parseInt(cnMatch[1]) - 1, parseInt(cnMatch[2])).getTime();
        }
        // 英文月份：Feb 26, 2026
        if (!ts) {
          const enMatch = fullText.match(/([A-Za-z]{3,})\s+(\d{1,2}),?\s+(\d{4})/);
          if (enMatch) { const d = new Date(enMatch[0]); if (!isNaN(d.getTime())) ts = d.getTime(); }
        }
        // ISO格式：2026-02-26
        if (!ts) {
          const isoMatch = fullText.match(/(\d{4})[-\/](\d{1,2})[-\/](\d{1,2})/);
          if (isoMatch) ts = new Date(isoMatch[0]).getTime();
        }
        if (!ts || isNaN(ts)) return; // 无日期跳过
        results.push({ title, source: 'OSL', url: href, category: 'Announcement', timestamp: ts, is_important: 0, content: '' });
      });
      return results.slice(0, 20);
    });
    console.log(`[Scraper] OSL: ${items.length}`);
    return items;
  } catch (err) {
    console.error('[OSL]', err.message);
    return [];
  } finally {
    await page.close();
    releaseBrowser();
  }
}

// ── WuBlock ───────────────────────────────────────────────────────────────────
async function scrapeWuBlock() {
  console.log('[Scraper] WuBlock...');
  const url  = 'https://www.wublock123.com/html/search/index.html?key=%u9999%u6E2F';
  const page = await newPage();
  try {
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 45000 });
    const items = await page.evaluate(() => {
      const results = [];
      const seenUrls = new Set();
      const seenTitles = new Set();

      document.querySelectorAll('a').forEach(a => {
        const href  = a.href;
        const title = a.innerText.trim();
        if (href.includes('a=show') && title.length > 10 && title.includes('香港')) {
          // 仅保留 id 参数作为唯一标识，去除 keyword 等可变参数
          let normalizedUrl;
          try {
            const u = new URL(href);
            const id = u.searchParams.get('id');
            normalizedUrl = id ? `${u.origin}${u.pathname}?a=show&id=${id}` : href.split('#')[0].replace(/\/$/, '');
          } catch(e) {
            normalizedUrl = href.split('#')[0].replace(/\/$/, '');
          }
          const normalizedTitle = title.toLowerCase().replace(/\s+/g, ' ').trim();

          if (seenUrls.has(normalizedUrl) || seenTitles.has(normalizedTitle)) return;
          seenUrls.add(normalizedUrl);
          seenTitles.add(normalizedTitle);

          // 尝试从页面提取时间戳
          let timestamp = 0;
          const container = a.closest('.article-item, .news-item, li, div');
          if (container) {
            const timeText = container.querySelector('.time, .date, span')?.innerText || '';
            const dateMatch = timeText.match(/(\d{4}[-/.]\d{1,2}[-/.]\d{1,2})|(\d{1,2}:\d{2})/);
            if (dateMatch) {
              const d = new Date(dateMatch[0].replace(/\./g, '-'));
              if (!isNaN(d.getTime())) timestamp = d.getTime();
            }
          }

          results.push({
            title,
            content: '',
            source: 'WuBlock',
            url: normalizedUrl,
            category: 'HK',
            timestamp: timestamp || 0,
            is_important: 0,
          });
        }
      });
      return results;
    });
    console.log(`[Scraper] WuBlock: ${items.length}`);
    return items;
  } catch (err) {
    console.error('[WuBlock]', err.message);
    return [];
  } finally {
    await page.close();
    releaseBrowser();
  }
}

// ── Bybit ─────────────────────────────────────────────────────────────────────
async function scrapeBybit() {
  console.log('[Scraper] Bybit...');
  const url  = 'https://announcements.bybit.com/zh-MY/';
  const page = await newPage();
  try {
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });
    const items = await page.evaluate(() => {
      const results = [];
      document.querySelectorAll('a').forEach(a => {
        const href  = a.href;
        const text  = a.innerText.trim();
        if (href.includes('/article/') && text.length > 10) {
          if (!results.find(r => r.url === href)) {
            results.push({ title: text.split('\n')[0], content: text, source: 'Bybit', url: href, category: 'Announcement', timestamp: 0, is_important: 0 });
          }
        }
      });
      return results;
    });
    console.log(`[Scraper] Bybit: ${items.length}`);
    return items;
  } catch (err) {
    console.error('[Bybit]', err.message);
    return [];
  } finally {
    await page.close();
    releaseBrowser();
  }
}

// ── Bitget ────────────────────────────────────────────────────────────────────
async function scrapeBitget() {
  console.log('[Scraper] Bitget...');
  const categories = [
    { id: '11865590960081', label: '新币上线' },
    { id: '11865590960458', label: '下架资讯' },
    { id: '11865590960106', label: '维护/系统升级' },
  ];
  const allItems = [];
  const page     = await newPage();
  try {
    await page.setViewport({ width: 1280, height: 900 });
    for (const cat of categories) {
      try {
        await page.goto(`https://www.bitget.com/zh-CN/support/categories/${cat.id}`, { waitUntil: 'domcontentloaded', timeout: 45000 });
        await sleep(4000);

        const found = await page.evaluate(() => {
          const results = [];
          document.querySelectorAll('a[href*="/zh-CN/support/articles/"]').forEach(a => {
            const href  = a.href;
            const text  = (a.innerText || a.textContent || '').trim();
            if (!text || text.length < 5 || results.find(r => r.url === href)) return;

            let timestamp = 0;
            const container = a.closest('.article-item, li, tr, [class*="item"]');
            if (container) {
              const timeEl   = container.querySelector('time, [class*="date"], .time');
              const timeText = timeEl ? timeEl.innerText.trim() : container.innerText;
              const relMatch = timeText.match(/(\d+)\s*(hour|minute|day)s?\s*ago/i);
              if (relMatch) {
                const num = parseInt(relMatch[1]);
                const unit = relMatch[2].toLowerCase();
                const now  = Date.now();
                if (unit.startsWith('m')) timestamp = now - num * 60000;
                else if (unit.startsWith('h')) timestamp = now - num * 3600000;
                else if (unit.startsWith('d')) timestamp = now - num * 86400000;
              } else {
                const dm = timeText.match(/\d{4}-\d{2}-\d{2}/);
                if (dm) timestamp = new Date(dm[0]).getTime();
              }
            }
            // 严格模式：无时间戳直接跳过
            if (!timestamp) return;

            results.push({ title: text.split('\n')[0].trim().substring(0, 200), content: '', source: 'Bitget', url: href, category: 'Announcement', timestamp, is_important: 0 });
          });
          return results;
        });
        found.forEach(item => { if (!allItems.find(i => i.url === item.url)) allItems.push(item); });
      } catch (err) {
        console.warn(`[Bitget cat=${cat.label}]`, err.message);
      }
    }
  } catch (err) {
    console.error('[Bitget launch]', err.message);
  } finally {
    await page.close();
    releaseBrowser();
  }
  console.log(`[Scraper] Bitget: ${allItems.length}`);
  return allItems;
}

// ── MEXC ──────────────────────────────────────────────────────────────────────
async function scrapeMexc() {
  console.log('[Scraper] MEXC...');
  const url  = 'https://www.mexc.com/zh-CN/announcements/new-listings';
  const page = await newPage();
  try {
    await page.setViewport({ width: 1280, height: 900 });
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 90000 });
    await sleep(12000);

    const items = await page.evaluate(() => {
      const results = [];
      document.querySelectorAll('a[href]').forEach(a => {
        const href  = a.href;
        const text  = (a.innerText || a.textContent || '').trim();
        if (text.length > 10 && (href.includes('/announcements/article/') || href.includes('/announcements/new-listings/'))) {
          if (!results.find(r => r.url === href)) {
            results.push({ title: text.split('\n')[0].trim().substring(0, 200), content: '', source: 'MEXC', url: href, category: 'Announcement', timestamp: 0, is_important: 0 });
          }
        }
      });
      return results;
    });
    console.log(`[Scraper] MEXC: ${items.length}`);
    return items;
  } catch (err) {
    console.error('[MEXC]', err.message);
    return [];
  } finally {
    await page.close();
    releaseBrowser();
  }
}

// ── Gate ──────────────────────────────────────────────────────────────────────
async function scrapeGate() {
  console.log('[Scraper] Gate...');
  const url  = 'https://www.gate.com/zh/announcements';
  const page = await newPage();
  try {
    await page.setViewport({ width: 1280, height: 900 });
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });
    await sleep(10000);

    const items = await page.evaluate(() => {
      const results = [];
      const candidates = document.querySelectorAll('.article-item, .entry-item, .item');
      const elements   = candidates.length > 0 ? candidates : document.querySelectorAll('a[href*="/announcements/"],a[href*="/article/"]');

      elements.forEach(el => {
        const a    = el.tagName === 'A' ? el : el.querySelector('a');
        if (!a) return;
        const href = a.href;
        const text = (a.innerText || a.textContent || '').trim();
        if (text.length < 10 || text === '近期公告' || text === '更多') return;
        if (!href.includes('/announcements/') && !href.includes('/article/') && !href.includes('/notice/')) return;
        if (href.endsWith('/announcements') || href.endsWith('/zh/announcements')) return;
        if (results.find(r => r.url === href)) return;

        let timestamp = 0;
        const container = (el.tagName === 'A' ? el.closest('.item,.article-item,li,tr') : el) || el.parentElement;
        if (container) {
          const timeEl = container.querySelector('.time,.date,.create-time,[class*="time"]');
          if (timeEl) {
            const d = new Date(timeEl.innerText.trim());
            if (!isNaN(d.getTime())) timestamp = d.getTime();
          } else {
            const dm = (container.innerText || '').match(/(\d{4}-\d{2}-\d{2}(\s\d{2}:\d{2})?)/);
            if (dm) { const d = new Date(dm[0]); if (!isNaN(d.getTime())) timestamp = d.getTime(); }
          }
        }
        if (!timestamp) return; // Strict: no timestamp = skip

        results.push({ title: text.split('\n')[0].trim().substring(0, 200), content: '', source: 'Gate', url: href, category: 'Announcement', timestamp, is_important: 0 });
      });
      return results;
    });
    console.log(`[Scraper] Gate: ${items.length}`);
    return items;
  } catch (err) {
    console.error('[Gate]', err.message);
    return [];
  } finally {
    await page.close();
    releaseBrowser();
  }
}

// ── Polymarket ────────────────────────────────────────────────────────────────
async function scrapePolymarketGeneric(url, sourceName, options = {}) {
  const { gotoTimeout = 60000, sleepMs = 10000 } = options;
  const page = await newPage();
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: gotoTimeout });
    await sleep(sleepMs);
    const items = await page.evaluate((src) => {
      const results = [];
      document.querySelectorAll('a').forEach(a => {
        const href = a.href;
        const text = a.innerText.trim();
        if (href.includes('/event/') && text.length > 15 && !results.find(r => r.url === href)) {
          results.push({
            title: text.replace(/^\d+\s+/, '').replace(/\n/g, ' ').trim(),
            content: 'Prediction Market',
            source: src, url: href, category: 'Market', timestamp: 0, is_important: 0,
          });
        }
      });
      return results;
    }, sourceName);
    console.log(`[Scraper] ${sourceName}: ${items.length}`);
    return items;
  } catch (err) {
    console.error(`[${sourceName}]`, err.message);
    return [];
  } finally {
    await page.close();
    releaseBrowser();
  }
}

const scrapePolymarketBreaking = () => scrapePolymarketGeneric('https://polymarket.com/breaking/world',      'Poly-Breaking', { gotoTimeout: 60000, sleepMs: 10000 });
const scrapePolymarketChina    = () => scrapePolymarketGeneric('https://polymarket.com/predictions/china', 'Poly-China',    { gotoTimeout: 30000, sleepMs: 6000 });

// ── Twitter KOLs (多级降级：Nitter → RSSHub → TwitterAPI.io → Scrapfly) ────────
const { KOL_LIST } = require('../../config');
const { scrapeKOLs } = require('./twitter-enhanced');

async function scrapeTwitterKOLs() {
  console.log('[Scraper] Twitter KOLs...');
  const results = await scrapeKOLs(KOL_LIST);
  const allTweets = [];

  for (const [kolName, data] of Object.entries(results)) {
    if (!data.success || !data.tweets.length) continue;
    for (const tweet of data.tweets.slice(0, 15)) {
      const title = (tweet.content || `Tweet from ${kolName}`)
        .replace(/^RT by @\w+:\s*/i, '')
        .replace(/^R to @\w+:\s*/i, '')
        .substring(0, 200);
      allTweets.push(makeItem({
        title,
        content:   (tweet.content || '').substring(0, 500),
        source:    kolName,
        url:       tweet.url || `https://x.com/${data.username}`,
        category:  'KOL',
        timestamp: tweet.timestamp || Date.now(),
      }));
    }
  }

  console.log(`[Scraper] KOLs total: ${allTweets.length}`);
  // 清理编码问题
  return allTweets.map(cleanItemText);
}

// ── 导出爬虫函数（自动添加编码清理包装）──────────────────────────────────────
function wrapClean(fn) {
  return async function(...args) {
    try {
      const results = await fn.apply(this, args);
      return Array.isArray(results) ? results.map(cleanItemText) : results;
    } catch (err) {
      throw err;
    }
  };
}

module.exports = {
  scrapeBlockBeats: wrapClean(scrapeBlockBeats),
  scrapeOSL: wrapClean(scrapeOSL),
  scrapeWuBlock: wrapClean(scrapeWuBlock),
  scrapeBybit: wrapClean(scrapeBybit),
  scrapeBitget: wrapClean(scrapeBitget),
  scrapeMexc: wrapClean(scrapeMexc),
  scrapeGate: wrapClean(scrapeGate),
  scrapePolymarketBreaking: wrapClean(scrapePolymarketBreaking),
  scrapePolymarketChina: wrapClean(scrapePolymarketChina),
  scrapeTwitterKOLs: wrapClean(scrapeTwitterKOLs),
};
