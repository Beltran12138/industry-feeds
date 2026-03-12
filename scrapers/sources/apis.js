'use strict';
/**
 * scrapers/sources/apis.js — 直接通过 HTTP API / SSR 抓取的数据源
 * 包含：OKX, Binance, HashKeyExchange, TechubNews, Matrixport, HashKeyGroup,
 *        PRNewswire, TechFlow, KuCoin, Exio, HTX
 */

const axios = require('axios');
const cheerio = require('cheerio');
const { SocksProxyAgent } = require('socks-proxy-agent');
const { SCRAPER } = require('../../config');
const { makeItem, parseTimestamp, extractTimestamp } = require('../utils');

const UA = SCRAPER.USER_AGENT;

// ── OKX ──────────────────────────────────────────────────────────────────────
async function scrapeOKX() {
  console.log('[Scraper] OKX...');
  const url = 'https://www.okx.com/api/v5/support/announcements?page=1&limit=25';
  try {
    const { data } = await axios.get(url, { headers: { 'User-Agent': UA }, timeout: 15000 });
    const details  = data?.data?.[0]?.details || [];
    return details.map(item => makeItem({
      title:     item.title || '',
      source:    'OKX',
      url:       item.url || '',
      category:  'Announcement',
      timestamp: parseTimestamp(item.pTime),
    }));
  } catch (err) {
    console.error('[OKX]', err.message);
    return [];
  }
}

// ── Binance ───────────────────────────────────────────────────────────────────
async function scrapeBinance() {
  console.log('[Scraper] Binance...');
  const catalogs = [48, 49];
  const allItems = [];
  for (const cid of catalogs) {
    const url = `https://www.binance.com/bapi/composite/v1/public/cms/article/list/query?type=1&catalogId=${cid}&pageNo=1&pageSize=20`;
    try {
      const { data }    = await axios.get(url, { headers: { 'User-Agent': UA } });
      const articles    = data?.data?.catalogs?.[0]?.articles || [];
      articles.forEach(item => allItems.push(makeItem({
        title:     item.title || '',
        source:    'Binance',
        url:       `https://www.binance.com/zh-CN/support/announcement/${item.code}`,
        category:  cid === 48 ? 'Listing' : 'Announcement',
        timestamp: parseTimestamp(item.releaseDate),
      })));
    } catch (err) {
      console.error(`[Binance cat=${cid}]`, err.message);
    }
  }
  console.log(`[Scraper] Binance: ${allItems.length}`);
  return allItems;
}

// ── HashKey Exchange (Zendesk API) ────────────────────────────────────────────
async function scrapeHashKeyExchange() {
  console.log('[Scraper] HashKeyExchange...');
  const apiUrl = 'https://support.hashkey.com/api/v2/help_center/en-gb/categories/900001209743/articles.json';
  try {
    const { data }    = await axios.get(apiUrl, { headers: { 'User-Agent': UA }, timeout: 15000 });
    const articles    = data.articles || [];
    const items = articles.map(a => makeItem({
      title:     a.title || '',
      content:   a.body ? a.body.replace(/<[^>]*>/g, '').substring(0, 200) : '',
      source:    'HashKeyExchange',
      url:       a.html_url || '',
      category:  'Announcement',
      timestamp: parseTimestamp(a.created_at),
    }));
    console.log(`[Scraper] HashKeyExchange: ${items.length}`);
    return items;
  } catch (err) {
    console.error('[HashKeyExchange]', err.message);
    return [];
  }
}

// ── TechubNews (API) ──────────────────────────────────────────────────────────
async function scrapeTechubNews() {
  console.log('[Scraper] TechubNews...');
  const apiUrl = 'https://www.techub.news/server/api/v1/featured?pageIndex=1&pageSize=20&isHongKong=true';
  try {
    const { data }    = await axios.get(apiUrl, {
      headers: { 'User-Agent': UA, 'Referer': 'https://www.techub.news/hongkong' },
    });
    const articles = data?.data?.list || [];
    const items    = [];
    articles.forEach(item => {
      const timestamp = parseTimestamp(item.created_at || item.publish_time);
      if (!timestamp) return; // 严格模式：无时间戳直接跳过
      items.push(makeItem({
        title:     item.title || '',
        content:   `Original Link: ${item.original_link || 'N/A'}\n${item.brief || ''}`,
        source:    'TechubNews',
        url:       `https://www.techub.news/articleDetail/${item.uid || item.id}`,
        category:  'HK',
        timestamp,
      }));
    });
    console.log(`[Scraper] TechubNews: ${items.length}`);
    return items;
  } catch (err) {
    console.error('[TechubNews]', err.message);
    return [];
  }
}

// ── Matrixport (SSR HTML) ─────────────────────────────────────────────────────
async function scrapeMatrixport() {
  console.log('[Scraper] Matrixport...');
  const url = 'https://helpcenter.matrixport.com/zh-CN/collections/10411294-%E5%AE%98%E6%96%B9%E5%85%AC%E5%91%8A';
  try {
    const { data } = await axios.get(url, {
      headers: {
        'User-Agent':      UA,
        'Accept':          'text/html,application/xhtml+xml',
        'Accept-Language': 'zh-CN,zh;q=0.9',
        'Referer':         'https://helpcenter.matrixport.com/',
      },
      timeout: 40000,
    });
    const $     = cheerio.load(data);
    const items = [];
    $('a[href*="/zh-CN/articles/"]').each((_, el) => {
      const href  = $(el).attr('href') || '';
      const title = $(el).text().trim();
      if (!title || title.length < 5) return;
      const fullUrl = href.startsWith('http') ? href : `https://helpcenter.matrixport.com${href}`;
      if (items.find(i => i.url === fullUrl)) return;
      items.push(makeItem({ title, source: 'Matrixport', url: fullUrl, category: 'Announcement', timestamp: 0 }));
    });
    console.log(`[Scraper] Matrixport: ${items.length}`);
    return items;
  } catch (err) {
    console.error('[Matrixport]', err.message);
    return [];
  }
}

// ── HashKey Group (SSR HTML) ──────────────────────────────────────────────────
async function scrapeHashKeyGroup() {
  console.log('[Scraper] HashKeyGroup...');
  const url = 'https://group.hashkey.com/en/news/categories/announcement-1';
  try {
    const { data } = await axios.get(url, { headers: { 'User-Agent': UA }, timeout: 15000 });
    const $        = cheerio.load(data);
    const items    = [];
    $('a[href*="/newsroom/"]').each((_, el) => {
      const title = $(el).text().trim();
      const href  = $(el).attr('href');
      if (!title || title.length < 10) return;
      const fullUrl = href.startsWith('http') ? href : `https://group.hashkey.com${href}`;
      if (items.find(i => i.url === fullUrl)) return;

      const container = $(el).closest('div, li, tr, section, article');
      const timestamp = extractTimestamp(container.text());

      // 严格模式：无时间戳直接跳过，避免旧稿混入
      if (!timestamp) return;

      items.push(makeItem({
        title, source: 'HashKeyGroup', url: fullUrl, category: 'Announcement', timestamp,
      }));
    });
    console.log(`[Scraper] HashKeyGroup: ${items.length}`);
    return items;
  } catch (err) {
    console.error('[HashKeyGroup]', err.message);
    return [];
  }
}

// ── PR Newswire (SSR HTML) ────────────────────────────────────────────────────
async function scrapePRNewswire() {
  console.log('[Scraper] PRNewswire...');
  const url = 'https://www.prnewswire.com/apac/news-releases/consumer-technology-latest-news/cryptocurrency-list/?page=1&pagesize=25';
  try {
    const { data }  = await axios.get(url, { headers: { 'User-Agent': UA } });
    const $         = cheerio.load(data);
    const items     = [];
    const seenUrls  = new Set();

    $('a[href*="/news-releases/"][href$=".html"]').each((_, el) => {
      const href = $(el).attr('href');
      if (!href) return;
      const fullUrl = href.startsWith('http') ? href : `https://www.prnewswire.com${href}`;
      if (seenUrls.has(fullUrl)) return;
      seenUrls.add(fullUrl);

      const titleEl = $(el).find('h3, h2, .title, [class*="title"], [class*="headline"]').first();
      let title     = (titleEl.length ? titleEl.text() : $(el).text()).trim();
      title         = title.replace(/^\d{1,2}\s+\w{3},\s+\d{4},?\s+[\d:]+\s*[A-Z]+\s*/i, '').trim();
      if (!title || title.length < 15) return;

      const timeStr = $(el).closest('.card, .row, article, li, .col-sm-12')
        .find('small, time, [class*="date"], [class*="time"], h3 + p').first().text().trim();

      // 严格时间解析 — 无时间戳则丢弃（避免旧稿混入）
      let timestamp = 0;
      if (timeStr) {
        const clean     = timeStr.replace(/\s+(HKT|CST|EST|PST|GMT)/i, '').trim();
        const timeMatch = clean.match(/(\d{1,2}:\d{2})/);
        if (timeMatch) {
          const now = new Date();
          const [h, m] = timeMatch[1].split(':').map(Number);
          timestamp = new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, m).getTime();
          if (timestamp > Date.now() + 3_600_000) timestamp -= 86_400_000;
        } else {
          timestamp = parseTimestamp(clean) || extractTimestamp(clean);
        }
      }
      if (!timestamp) return;

      items.push(makeItem({ title, source: 'PRNewswire', url: fullUrl, category: 'PR', timestamp }));
    });

    console.log(`[Scraper] PRNewswire: ${items.length}`);
    return items;
  } catch (err) {
    console.error('[PRNewswire]', err.message);
    return [];
  }
}

// ── TechFlow (SSR HTML) ───────────────────────────────────────────────────────
async function scrapeTechFlow() {
  console.log('[Scraper] TechFlow...');
  const url = 'https://www.techflowpost.com/zh-CN/article?pageType=allArticle';
  try {
    const { data } = await axios.get(url, { headers: { 'User-Agent': UA } });
    const $        = cheerio.load(data);
    const items    = [];
    $('a[href*="/article/"]').each((_, el) => {
      const href    = $(el).attr('href');
      const fullUrl = href.startsWith('http') ? href : `https://www.techflowpost.com${href}`;
      const title   = $(el).find('h3, .title, p').first().text().trim() || $(el).text().trim();
      if (title && title.length > 5) {
        items.push(makeItem({ title, source: 'TechFlow', url: fullUrl, category: 'Deep', timestamp: 0 }));
      }
    });
    return items;
  } catch (err) {
    console.error('[TechFlow]', err.message);
    return [];
  }
}

// ── KuCoin (SSR HTML) ─────────────────────────────────────────────────────────
async function scrapeKuCoin() {
  console.log('[Scraper] KuCoin...');
  const url = 'https://www.kucoin.com/zh-hant/announcement/latest-announcements';
  try {
    const { data } = await axios.get(url, { headers: { 'User-Agent': UA }, timeout: 15000 });
    const $        = cheerio.load(data);
    const items    = [];
    $('a[href*="/announcement/"]').each((i, el) => {
      let text  = $(el).text().trim();
      const href = $(el).attr('href');
      if (!text || text.length < 10 || !href.includes('hk-')) return;
      const fullUrl = href.startsWith('http') ? href : `https://www.kucoin.com${href}`;
      if (items.find(it => it.url === fullUrl)) return;

      const dateMatch = text.match(/\d{4}\/\d{2}\/\d{2}/);
      // 严格模式：无日期直接跳过，不使用 Date.now() fallback
      if (!dateMatch) return;
      let timestamp   = new Date(dateMatch[0]).getTime();
      if (dateMatch) text = text.replace(dateMatch[0], '').trim();

      items.push(makeItem({ title: text, source: 'KuCoin', url: fullUrl, category: 'Announcement', timestamp }));
    });
    console.log(`[Scraper] KuCoin: ${items.length}`);
    return items;
  } catch (err) {
    console.error('[KuCoin]', err.message);
    return [];
  }
}

// ── EX.IO / Exio (SSR HTML) ───────────────────────────────────────────────────
async function scrapeExio() {
  console.log('[Scraper] Exio...');
  const url = 'https://www.ex.io/zh/support/announcements';
  try {
    const { data } = await axios.get(url, { headers: { 'User-Agent': UA }, timeout: 15000 });
    const $        = cheerio.load(data);
    const items    = [];
    $('a[href*="/support/announcements/"]').each((_, el) => {
      const title = $(el).text().trim();
      const href  = $(el).attr('href');
      if (!title || title.length < 5) return;
      const fullUrl = href.startsWith('http') ? href : `https://www.ex.io${href}`;
      if (items.find(it => it.url === fullUrl)) return;

      const container = $(el).closest('li, div, article');
      let dateText    = container.find('span, small, .date, time').text().trim() || container.text();
      const timestamp = extractTimestamp(dateText);
      if (!timestamp) return; // 严格模式

      items.push(makeItem({ title, source: 'Exio', url: fullUrl, category: 'Announcement', timestamp }));
    });
    console.log(`[Scraper] Exio: ${items.length}`);
    return items;
  } catch (err) {
    console.error('[Exio]', err.message);
    return [];
  }
}

// ── HTX (internal API, with optional Tor proxy in CI) ─────────────────────────
async function scrapeHtx() {
  const inCI = process.env.GITHUB_ACTIONS === 'true';
  console.log(`[Scraper] HTX${inCI ? ' (Tor)' : ''}...`);
  const BASE       = 'https://www.htx.com/-/x/support/public/getList/v2';
  const ONE_LEVEL  = '360000031902';
  const categories = [
    { id: '360000039481', label: '最新热点' },
    { id: '360000039942', label: '新币上线' },
    { id: '360000039982', label: '充提/暂停' },
    { id: '64971881385864', label: '下架资讯' },
  ];

  let httpsAgent;
  if (inCI) {
    try {
      httpsAgent = new SocksProxyAgent('socks5://127.0.0.1:9050');
    } catch (e) {
      console.warn('[HTX] Tor proxy unavailable:', e.message);
    }
  }

  const allItems = [];
  const seenUrls = new Set();
  for (const cat of categories) {
    try {
      const url       = `${BASE}?language=zh-cn&page=1&limit=20&oneLevelId=${ONE_LEVEL}&twoLevelId=${cat.id}`;
      const { data }  = await axios.get(url, {
        httpsAgent,
        headers: { 'User-Agent': UA, 'Accept': 'application/json', 'Referer': 'https://www.htx.com/zh-cn/support/' },
        timeout: 30000,
      });
      const list = data?.data?.list || [];
      list.forEach(item => {
        const articleUrl = `https://www.htx.com/zh-cn/support/${item.id}`;
        if (!item.title || seenUrls.has(articleUrl)) return;
        seenUrls.add(articleUrl);
        allItems.push(makeItem({
          title:     item.title.trim(),
          content:   item.dealPair ? `Trading pair: ${item.dealPair}` : '',
          source:    'HTX',
          url:       articleUrl,
          category:  'Announcement',
          timestamp: parseTimestamp(item.showTime),
        }));
      });
    } catch (err) {
      console.warn(`[HTX cat=${cat.label}]`, err.message);
    }
  }
  console.log(`[Scraper] HTX: ${allItems.length}`);
  return allItems;
}

// ── 香港证监会 SFC (Circulars) ────────────────────────────────────────────────
async function scrapeSFC() {
  console.log('[Scraper] SFC Circulars...');
  const url = 'https://www.sfc.hk/tc/Rules-and-standards/Circulars';
  try {
    const { data } = await axios.get(url, { 
      headers: { 'User-Agent': UA, 'Accept-Language': 'zh-CN,zh;q=0.9' },
      timeout: 20000 
    });
    const $ = cheerio.load(data);
    const items = [];
    
    // SFC 的通函列表通常在特定的表格或列表结构中
    $('.table-row, .list-item, tr').each((_, el) => {
      const a = $(el).find('a').first();
      const title = a.text().trim();
      const href = a.attr('href');
      
      if (!title || !href || title.length < 5) return;
      if (!href.includes('/Circulars/')) return;
      
      const fullUrl = href.startsWith('http') ? href : `https://www.sfc.hk${href}`;
      
      // 提取日期：SFC 列表通常有一列是日期
      const dateText = $(el).find('.date, .time, td').first().text().trim();
      const timestamp = extractTimestamp(dateText) || 0;
      
      if (items.find(i => i.url === fullUrl)) return;
      
      items.push(makeItem({
        title: `[SFC通函] ${title}`,
        source: 'SFC',
        url: fullUrl,
        category: 'Regulation',
        timestamp: timestamp
      }));
    });
    
    console.log(`[Scraper] SFC: ${items.length}`);
    return items;
  } catch (err) {
    console.error('[SFC]', err.message);
    return [];
  }
}

module.exports = {
  scrapeOKX,
  scrapeBinance,
  scrapeHashKeyExchange,
  scrapeTechubNews,
  scrapeMatrixport,
  scrapeHashKeyGroup,
  scrapePRNewswire,
  scrapeTechFlow,
  scrapeKuCoin,
  scrapeExio,
  scrapeHtx,
  scrapeSFC,
};
