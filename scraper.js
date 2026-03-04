const axios = require('axios');
const cheerio = require('cheerio');
const puppeteer = require('puppeteer');
const puppeteerExtra = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteerExtra.use(StealthPlugin());
const { saveNews, db, getAlreadyProcessed, updateSentStatus } = require('./db');
const { processWithAI } = require('./ai');
const { sendToWeCom } = require('./wecom');

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36';

// Launch a browser that respects CI environment (executable path and flags)
async function launchBrowser() {
  const options = {
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--disable-blink-features=AutomationControlled']
  };

  // Respect GitHub Actions path
  if (process.env.PUPPETEER_EXECUTABLE_PATH) {
    options.executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;
  }

  return puppeteerExtra.launch(options);
}

// Keep a version of stealth for Cloudflare specifically
async function launchStealth() {
  return launchBrowser();
}

async function scrapeTechFlow() {
  console.log('Scraping TechFlow...');
  const url = 'https://www.techflowpost.com/zh-CN/article?pageType=allArticle';
  try {
    const { data } = await axios.get(url, { headers: { 'User-Agent': USER_AGENT } });
    const $ = cheerio.load(data);
    const items = [];

    $('a[href*="/article/"]').each((i, el) => {
      const href = $(el).attr('href');
      const fullUrl = href.startsWith('http') ? href : `https://www.techflowpost.com${href}`;
      const title = $(el).find('h3, .title, p').first().text().trim() || $(el).text().trim();

      if (title && title.length > 5) {
        items.push({
          title,
          content: '',
          source: 'TechFlow',
          url: fullUrl,
          category: 'Deep',
          timestamp: Date.now() - (i * 1000 * 60 * 10),
          is_important: 0
        });
      }
    });
    return items;
  } catch (err) {
    console.error('TechFlow error:', err.message);
    return [];
  }
}

async function scrapePRNewswire() {
  console.log('Scraping PR Newswire (Cryptocurrency)...');
  const url = 'https://www.prnewswire.com/apac/news-releases/consumer-technology-latest-news/cryptocurrency-list/?page=1&pagesize=25';
  try {
    const { data } = await axios.get(url, { headers: { 'User-Agent': USER_AGENT } });
    const $ = cheerio.load(data);
    const items = [];
    const seenUrls = new Set();

    // 仅匹配实际新闻稿 URL（含 .html 的文章页，排除分类/导航页）
    $('a[href*="/news-releases/"][href$=".html"]').each((i, el) => {
      const href = $(el).attr('href');
      if (!href) return;
      const fullUrl = href.startsWith('http') ? href : `https://www.prnewswire.com${href}`;
      if (seenUrls.has(fullUrl)) return;
      seenUrls.add(fullUrl);

      // 提取标题：优先用子元素中的标题标签，否则用链接文本并去掉日期前缀
      const titleEl = $(el).find('h3, h2, .title, [class*="title"], [class*="headline"]').first();
      let title = (titleEl.length ? titleEl.text() : $(el).text()).trim();
      // 去掉可能混入的日期前缀（如 "02 Mar, 2026, 22:00 CST "）
      title = title.replace(/^\d{1,2}\s+\w{3},\s+\d{4},?\s+[\d:]+\s*[A-Z]+\s*/i, '').trim();
      if (!title || title.length < 15) return;

      // 从父容器找时间戳
      const timeStr = $(el).closest('.card, .row, article, li').find('small, time, [class*="date"], [class*="time"]').first().text().trim();
      const ts = timeStr ? new Date(timeStr).getTime() : 0;
      const timestamp = (ts && !isNaN(ts)) ? ts : Date.now() - (items.length * 1000 * 60 * 60);

      items.push({
        title: title.substring(0, 200),
        content: '',
        source: 'PRNewswire',
        url: fullUrl,
        category: 'PR',
        timestamp,
        is_important: 0
      });
    });

    console.log(`PRNewswire: Found ${items.length} items`);
    return items;
  } catch (err) {
    console.error('PRNewswire error:', err.message);
    return [];
  }
}

async function scrapeBlockBeats() {
  console.log('Scraping BlockBeats Newsflash...');
  const url = 'https://www.theblockbeats.info/newsflash';
  let browser;
  try {
    browser = await launchBrowser();
    const page = await browser.newPage();
    await page.setUserAgent(USER_AGENT);
    await page.setViewport({ width: 1280, height: 1000 });
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });

    await new Promise(resolve => setTimeout(resolve, 8000));

    const items = await page.evaluate(() => {
      const results = [];
      const containers = document.querySelectorAll('.news-flash-item, .newsflash_item, .newsflash-item, [class*="flash-item"]');

      containers.forEach((el, i) => {
        const titleEl = el.querySelector('h3, .title, [class*="title"], .news-flash-item-title');
        const contentEl = el.querySelector('.content, [class*="content"], .news-flash-item-content, p');
        const text = (titleEl ? titleEl.innerText : (contentEl ? contentEl.innerText : '')).trim();
        const importantKeywords = ['Launchpad', 'SEC', '重要', 'Listing', 'ETF', 'Binance', 'OKX', '暂停', '下架', 'Alert', '紧急', '快报', '利好', '利空', '爆仓', '消息', '快讯', '美媒', '哈梅内伊'];

        const isImportant = el.querySelector('.important, .hot, [class*="important"], [class*="hot"], .news-flash-item-important') !== null ||
          importantKeywords.some(k => text.includes(k));

        const itemUrl = el.querySelector('a[href*="/flash/"], a[href*="/news/"]')?.href ||
          el.querySelector('a[href*="theblockbeats.info"]')?.href || '';

        // Extract time (e.g., "15:20")
        const timeEl = el.querySelector('.time, [class*="time"]');
        let timestamp = Date.now() - (i * 60000);
        if (timeEl) {
          const timeParts = timeEl.innerText.trim().split(':');
          if (timeParts.length === 2) {
            const d = new Date();
            d.setHours(parseInt(timeParts[0]), parseInt(timeParts[1]), 0, 0);
            timestamp = d.getTime();
            // If the time is later than now, it's likely from yesterday
            if (timestamp > Date.now()) {
              timestamp -= 24 * 60 * 60 * 1000;
            }
          }
        }

        // 跳过垃圾条目（Weibo分享链接、空标题、锚点链接）
        if (text.length > 5 && itemUrl && !itemUrl.includes('weibo.com') && !itemUrl.includes('share.php')) {
          results.push({
            title: text.substring(0, 150) + (text.length > 150 ? '...' : ''),
            content: contentEl ? contentEl.innerText.trim() : text,
            source: 'BlockBeats',
            url: itemUrl,
            category: 'Newsflash',
            timestamp,
            is_important: 0
          });
        }
      });
      return results;
    });

    console.log(`BlockBeats: Found ${items.length} items`);
    return items;
  } catch (err) {
    console.error('BlockBeats error:', err.message);
    return [];
  } finally {
    if (browser) await browser.close();
  }
}

async function scrapeTwitterKOLs() {
  console.log('Scraping Twitter KOLs via RSSHub/Nitter...');
  const kols = [
    { name: 'TwitterAB', username: '_FORAB' },
    { name: 'WuShuo', username: 'colinwu' },
    { name: 'Phyrex', username: 'PhyrexNi' },
    { name: 'XieJiayin', username: 'xiejiayinBitget' },
    { name: 'JustinSun', username: 'justinsuntron' }
  ];

  let allTweets = [];
  const rssBaseUrls = [
    'https://nitter.net',
    'https://rsshub.app/twitter/user',
    'https://rsshub.rssforever.com/twitter/user'
  ];

  for (const kol of kols) {
    console.log(`- Scraping ${kol.name} (${kol.username})...`);
    let success = false;
    for (const baseUrl of rssBaseUrls) {
      if (success) break;
      try {
        const url = baseUrl.includes('nitter') ? `${baseUrl}/${kol.username}/rss` : `${baseUrl}/${kol.username}`;
        const { data } = await axios.get(url, { headers: { 'User-Agent': USER_AGENT }, timeout: 10000 });
        const $ = cheerio.load(data, { xmlMode: true });

        $('item').each((i, el) => {
          if (i >= 15) return;
          const title = $(el).find('title').text().trim();
          const description = $(el).find('description').text().trim();
          const link = $(el).find('link').text().trim();
          const pubDate = $(el).find('pubDate').text().trim();

          let cleanTitle = title.replace(/^RT by @\w+: /, '').replace(/^R to @\w+: /, '');
          if (cleanTitle.length > 200) cleanTitle = cleanTitle.substring(0, 197) + '...';

          allTweets.push({
            title: cleanTitle || `Tweet from ${kol.name}`,
            content: description.replace(/<[^>]*>/g, '').substring(0, 500),
            source: kol.name,
            url: link || `https://x.com/${kol.username}`,
            category: 'KOL',
            timestamp: pubDate ? new Date(pubDate).getTime() : Date.now() - (i * 1000 * 60 * 30),
            is_important: 0
          });
        });
        console.log(`  Success from ${baseUrl}`);
        success = true;
      } catch (err) {
        // Silently try next source
      }
    }
  }
  return allTweets;
}

async function scrapeOSL() {
  console.log('Scraping OSL Announcements...');
  const url = 'https://www.osl.com/hk/announcement?channel=7rm1br';
  let browser;
  try {
    browser = await launchBrowser();
    const page = await browser.newPage();
    await page.setUserAgent(USER_AGENT);
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });

    // Wait for content to load
    await page.waitForSelector('.ant-list-item, .announcement-item, a[href*="/announcement/"]', { timeout: 30000 }).catch(() => { });
    await new Promise(resolve => setTimeout(resolve, 5000));

    const items = await page.evaluate(() => {
      const results = [];
      // Try to find list items first
      const listItems = document.querySelectorAll('.ant-list-item, .announcement-item, li');

      listItems.forEach((el, i) => {
        const link = el.querySelector('a');
        if (!link) return;

        const title = link.innerText.trim() || el.innerText.split('\n')[0].trim();
        const href = link.href;

        if (title && title.length > 5 && href.includes('/announcement')) {
          if (!results.find(r => r.url === href)) {
            results.push({
              title,
              content: '',
              source: 'OSL',
              url: href,
              category: 'Announcement',
              timestamp: Date.now() - (i * 1000 * 60 * 60 * 5),
              is_important: 0
            });
          }
        }
      });
      return results;
    });
    console.log(`OSL: Found ${items.length} items`);
    return items;
  } catch (err) {
    console.error('OSL error:', err.message);
    return [];
  } finally {
    if (browser) await browser.close();
  }
}

async function scrapeTechubNews() {
  console.log('Scraping Techub News (Hong Kong) via API...');
  const apiUrl = 'https://www.techub.news/server/api/v1/featured?pageIndex=1&pageSize=20&isHongKong=true';
  try {
    const { data } = await axios.get(apiUrl, {
      headers: {
        'User-Agent': USER_AGENT,
        'Referer': 'https://www.techub.news/hongkong'
      }
    });

    const articles = data?.data?.list || [];
    const items = articles.map((item, i) => ({
      title: item.title || '',
      content: item.brief || '',
      source: 'TechubNews',
      // Fix: Use original_link if available, fallback to internal detail page
      url: item.original_link || `https://www.techub.news/articleDetail/${item.id}`,
      category: 'HK',
      timestamp: item.publish_time ? new Date(item.publish_time).getTime() : Date.now() - (i * 1000 * 60 * 30),
      is_important: 0
    }));

    console.log(`TechubNews: Found ${items.length} items from API`);
    return items;
  } catch (err) {
    console.warn('TechubNews API failed:', err.message);
    return [];
  }
}

async function scrapeOKX() {
  console.log('Scraping OKX Announcements...');
  const url = 'https://www.okx.com/api/v5/support/announcements?page=1&limit=25';
  try {
    const { data } = await axios.get(url, { headers: { 'User-Agent': USER_AGENT } });
    const details = data?.data?.[0]?.details || [];
    return details.map((item, i) => ({
      title: item.title || '',
      content: '',
      source: 'OKX',
      url: item.url || '',
      category: 'Announcement',
      timestamp: item.pTime ? Number(item.pTime) : Date.now() - (i * 1000 * 60 * 15),
      is_important: 0
    }));
  } catch (err) {
    console.error('OKX error:', err.message);
    return [];
  }
}

async function scrapeExio() {
  console.log('Scraping Exio Announcements...');
  const url = 'https://www.ex.io/zh/support/announcements';
  try {
    const { data } = await axios.get(url, { headers: { 'User-Agent': USER_AGENT }, timeout: 15000 });
    const $ = cheerio.load(data);
    const items = [];

    $('a[href*="/support/announcements/"]').each((i, el) => {
      const title = $(el).text().trim();
      const href = $(el).attr('href');
      if (!title || title.length < 5) return;

      const fullUrl = href.startsWith('http') ? href : `https://www.ex.io${href}`;
      if (items.find(item => item.url === fullUrl)) return;

      items.push({
        title,
        content: '',
        source: 'Exio',
        url: fullUrl,
        category: 'Announcement',
        timestamp: Date.now() - (i * 1000 * 60 * 60),
        is_important: 0
      });
    });
    console.log(`Exio: Found ${items.length} items`);
    return items;
  } catch (err) {
    console.error('Exio error:', err.message);
    return [];
  }
}

async function scrapeMatrixport() {
  // Matrixport Intercom Help Center is SSR — direct axios works with the collection URL
  console.log('Scraping Matrixport Announcements (SSR)...');
  const url = 'https://helpcenter.matrixport.com/zh-CN/collections/10411294-%E5%AE%98%E6%96%B9%E5%85%AC%E5%91%8A';
  const importantKeywords = ['上线', '下架', '维护', '通知', '暂停', '提币', '升级', 'Listing', 'Maintenance'];
  try {
    const { data } = await axios.get(url, {
      headers: {
        'User-Agent': USER_AGENT,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9',
        'Referer': 'https://helpcenter.matrixport.com/'
      },
      timeout: 40000
    });
    const $ = cheerio.load(data);
    const items = [];

    $('a[href*="/zh-CN/articles/"]').each((i, el) => {
      const href = $(el).attr('href') || '';
      const title = $(el).text().trim();
      if (!title || title.length < 5) return;
      const fullUrl = href.startsWith('http') ? href : `https://helpcenter.matrixport.com${href}`;
      if (items.find(item => item.url === fullUrl)) return;

      items.push({
        title: title.substring(0, 200),
        content: '',
        source: 'Matrixport',
        url: fullUrl,
        category: 'Announcement',
        timestamp: Date.now() - (i * 1000 * 60 * 45),
        is_important: 0
      });
    });

    console.log(`Matrixport: Found ${items.length} items`);
    return items;
  } catch (err) {
    console.error('Matrixport error:', err.message);
    return [];
  }
}

async function scrapeWuBlock() {
  console.log('Scraping WuBlock Hong Kong Section...');
  const url = 'https://www.wublock123.com/html/search/index.html?key=%u9999%u6E2F';
  let browser;
  try {
    browser = await launchBrowser();
    const page = await browser.newPage();
    await page.setUserAgent(USER_AGENT);
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 45000 });

    const items = await page.evaluate(() => {
      const results = [];
      document.querySelectorAll('a').forEach((a, i) => {
        const href = a.href;
        const title = a.innerText.trim();
        if (href.includes('a=show') && title.length > 10 && title.includes('香港')) {
          if (!results.find(r => r.url === href)) {
            results.push({
              title,
              content: '',
              source: 'WuBlock',
              url: href,
              category: 'HK',
              timestamp: Date.now() - (i * 1000 * 60 * 30),
              is_important: 0
            });
          }
        }
      });
      return results;
    });
    console.log(`WuBlock: Found ${items.length} items`);
    return items;
  } catch (err) {
    console.error('WuBlock error:', err.message);
    return [];
  } finally {
    if (browser) await browser.close();
  }
}

async function scrapeHashKeyGroup() {
  console.log('Scraping HashKey Group Announcements...');
  const url = 'https://group.hashkey.com/en/news/categories/announcement-1';
  try {
    const { data } = await axios.get(url, { headers: { 'User-Agent': USER_AGENT }, timeout: 15000 });
    const $ = cheerio.load(data);
    const items = [];

    $('a[href*="/newsroom/"]').each((i, el) => {
      const title = $(el).text().trim();
      const href = $(el).attr('href');
      if (!title || title.length < 10) return;

      const fullUrl = href.startsWith('http') ? href : `https://group.hashkey.com${href}`;
      if (items.find(item => item.url === fullUrl)) return;

      items.push({
        title,
        content: '',
        source: 'HashKeyGroup',
        url: fullUrl,
        category: 'Announcement',
        timestamp: Date.now() - (i * 1000 * 60 * 60 * 2),
        is_important: 0
      });
    });
    console.log(`HashKeyGroup: Found ${items.length} items`);
    return items;
  } catch (err) {
    console.error('HashKeyGroup error:', err.message);
    return [];
  }
}

async function scrapeKuCoin() {
  console.log('Scraping KuCoin Announcements...');
  const url = 'https://www.kucoin.com/zh-hant/announcement/latest-announcements';
  try {
    const { data } = await axios.get(url, { headers: { 'User-Agent': USER_AGENT }, timeout: 15000 });
    const $ = cheerio.load(data);
    const items = [];

    $('a[href*="/announcement/"]').each((i, el) => {
      let text = $(el).text().trim();
      const href = $(el).attr('href');
      if (!text || text.length < 10 || !href.includes('hk-')) return;

      const fullUrl = href.startsWith('http') ? href : `https://www.kucoin.com${href}`;
      if (items.find(item => item.url === fullUrl)) return;

      const dateMatch = text.match(/\d{4}\/\d{2}\/\d{2}/);
      let timestamp = Date.now() - (i * 1000 * 60 * 30);
      if (dateMatch) {
        timestamp = new Date(dateMatch[0]).getTime();
        text = text.replace(dateMatch[0], '').trim();
      }

      items.push({
        title: text,
        content: '',
        source: 'KuCoin',
        url: fullUrl,
        category: 'Announcement',
        timestamp,
        is_important: 0
      });
    });
    console.log(`KuCoin: Found ${items.length} items`);
    return items;
  } catch (err) {
    console.error('KuCoin error:', err.message);
    return [];
  }
}

async function scrapeHashKeyExchange() {
  console.log('Scraping HashKey Exchange Announcements via API...');
  const apiUrl = 'https://support.hashkey.com/api/v2/help_center/en-gb/categories/900001209743/articles.json';
  try {
    const { data } = await axios.get(apiUrl, { headers: { 'User-Agent': USER_AGENT }, timeout: 15000 });
    const articles = data.articles || [];

    const items = articles.map((article, i) => ({
      title: article.title || '',
      content: article.body ? article.body.replace(/<[^>]*>/g, '').substring(0, 200) : '',
      source: 'HashKeyExchange',
      url: article.html_url || '',
      category: 'Announcement',
      timestamp: article.created_at ? new Date(article.created_at).getTime() : Date.now() - (i * 1000 * 60 * 60),
      is_important: 0
    }));

    console.log(`HashKeyExchange: Found ${items.length} items from API`);
    return items;
  } catch (err) {
    console.error('HashKeyExchange API error:', err.message);
    return [];
  }
}

async function scrapeBinance() {
  console.log('Scraping Binance Announcements...');
  const catalogs = [48, 49];
  let allItems = [];

  for (const cid of catalogs) {
    const url = `https://www.binance.com/bapi/composite/v1/public/cms/article/list/query?type=1&catalogId=${cid}&pageNo=1&pageSize=20`;
    try {
      const { data } = await axios.get(url, { headers: { 'User-Agent': USER_AGENT } });
      const articles = data?.data?.catalogs?.[0]?.articles || [];
      articles.forEach((item, i) => {
        allItems.push({
          title: item.title || '',
          content: '',
          source: 'Binance',
          url: `https://www.binance.com/zh-CN/support/announcement/${item.code}`,
          category: cid === 48 ? 'Listing' : 'Announcement',
          timestamp: item.releaseDate ? Number(item.releaseDate) : Date.now() - (i * 1000 * 60 * 30),
          is_important: 0
        });
      });
    } catch (err) {
      console.error(`Binance catalog ${cid} error:`, err.message);
    }
  }
  console.log(`Binance: Found ${allItems.length} items`);
  return allItems;
}

async function scrapeBybit() {
  console.log('Scraping Bybit Announcements...');
  const url = 'https://announcements.bybit.com/zh-MY/';
  let browser;
  try {
    browser = await launchBrowser();
    const page = await browser.newPage();
    await page.setUserAgent(USER_AGENT);
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });

    const items = await page.evaluate(() => {
      const results = [];
      document.querySelectorAll('a').forEach((a, i) => {
        const href = a.href;
        const text = a.innerText.trim();
        if (href.includes('/article/') && text.length > 10) {
          if (!results.find(r => r.url === href)) {
            results.push({
              title: text.split('\n')[0],
              content: text,
              source: 'Bybit',
              url: href,
              category: 'Announcement',
              timestamp: Date.now() - (i * 1000 * 60 * 60),
              is_important: 0
            });
          }
        }
      });
      return results;
    });
    console.log(`Bybit: Found ${items.length} items`);
    return items;
  } catch (err) {
    console.error('Bybit error:', err.message);
    return [];
  } finally {
    if (browser) await browser.close();
  }
}

async function scrapeBitget() {
  console.log('Scraping Bitget Announcements (stealth)...');
  const categories = [
    { id: '11865590960081', label: '新币上线' },
    { id: '11865590960458', label: '下架资讯' },
    { id: '11865590960106', label: '维护/系统升级' }
  ];
  const importantKeywords = ['上线', '新币', '下架', '暂停', '维护', 'Listing', 'Delist', 'Suspend'];
  const allItems = [];
  let browser;

  try {
    browser = await launchStealth();
    const page = await browser.newPage();
    await page.setUserAgent(USER_AGENT);
    await page.setViewport({ width: 1280, height: 900 });

    for (const cat of categories) {
      try {
        const url = `https://www.bitget.com/zh-CN/support/categories/${cat.id}`;
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
        await new Promise(r => setTimeout(r, 4000));

        const found = await page.evaluate((kws) => {
          const results = [];
          document.querySelectorAll('a[href*="/zh-CN/support/articles/"]').forEach((a) => {
            const href = a.href;
            const text = (a.innerText || a.textContent || '').trim();
            if (!text || text.length < 5) return;
            if (!results.find(r => r.url === href)) {
              results.push({
                title: text.split('\n')[0].trim().substring(0, 200),
                content: '',
                source: 'Bitget',
                url: href,
                category: 'Announcement',
                timestamp: Date.now() - (results.length * 1000 * 60 * 30),
                is_important: 0
              });
            }
          });
          return results;
        }, importantKeywords);

        found.forEach(item => {
          if (!allItems.find(i => i.url === item.url)) allItems.push(item);
        });
      } catch (err) {
        console.warn(`  Bitget [${cat.label}] error:`, err.message);
      }
    }
  } catch (err) {
    console.error('Bitget launch error:', err.message);
  } finally {
    if (browser) await browser.close();
  }
  return allItems;
}

async function scrapeMexc() {
  console.log('Scraping MEXC Announcements (stealth)...');
  const url = 'https://www.mexc.com/zh-CN/announcements/new-listings';
  let browser;
  try {
    browser = await launchStealth();
    const page = await browser.newPage();
    await page.setUserAgent(USER_AGENT);
    await page.setViewport({ width: 1280, height: 900 });
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 90000 });
    await new Promise(r => setTimeout(r, 12000));

    const items = await page.evaluate(() => {
      const results = [];
      const importantKw = ['上线', '新币', '暂停', '下架', 'Listing', 'New', 'Launch'];
      document.querySelectorAll('a[href]').forEach((a) => {
        const href = a.href;
        const text = (a.innerText || a.textContent || '').trim();
        if (
          text.length > 10 &&
          (href.includes('/announcements/article/') || href.includes('/announcements/new-listings/'))
        ) {
          if (!results.find(r => r.url === href)) {
            results.push({
              title: text.split('\n')[0].trim().substring(0, 200),
              content: '',
              source: 'MEXC',
              url: href,
              category: 'Announcement',
              timestamp: Date.now() - (results.length * 1000 * 60 * 30),
              is_important: 0
            });
          }
        }
      });
      return results;
    });
    return items;
  } catch (err) {
    console.error('MEXC error:', err.message);
    return [];
  } finally {
    if (browser) await browser.close();
  }
}

async function scrapeHtx() {
  const inCI = process.env.GITHUB_ACTIONS === 'true';
  console.log(`Scraping HTX Announcements (internal API${inCI ? ' via Tor' : ''})...`);
  const BASE = 'https://www.htx.com/-/x/support/public/getList/v2';
  const importantKeywords = ['上线', '下线', '下架', '暂停', '维护', '新币', 'Listing', 'Delist', 'Suspend', 'Maintenance'];
  const categories = [
    { id: '360000039481', label: '最新热点' },
    { id: '360000039942', label: '新币上线' },
    { id: '360000039982', label: '充提/暂停' },
    { id: '64971881385864', label: '下架资讯' }
  ];
  const ONE_LEVEL_ID = '360000031902';
  const allItems = [];
  const seenUrls = new Set();

  let httpsAgent;
  if (inCI) {
    try {
      const { SocksProxyAgent } = require('socks-proxy-agent');
      httpsAgent = new SocksProxyAgent('socks5://127.0.0.1:9050');
    } catch (e) {
      console.warn('  Tor proxy unavailable:', e.message);
    }
  }

  for (const cat of categories) {
    try {
      const url = `${BASE}?language=zh-cn&page=1&limit=20&oneLevelId=${ONE_LEVEL_ID}&twoLevelId=${cat.id}`;
      const { data } = await axios.get(url, {
        httpsAgent,
        headers: {
          'User-Agent': USER_AGENT,
          'Accept': 'application/json',
          'Referer': 'https://www.htx.com/zh-cn/support/'
        },
        timeout: 30000
      });

      const list = data?.data?.list || [];
      list.forEach((item) => {
        const articleUrl = `https://www.htx.com/zh-cn/support/${item.id}`;
        if (!item.title || seenUrls.has(articleUrl)) return;
        seenUrls.add(articleUrl);
        allItems.push({
          title: item.title.trim().substring(0, 200),
          content: item.dealPair ? `Trading pair: ${item.dealPair}` : '',
          source: 'HTX',
          url: articleUrl,
          category: 'Announcement',
          timestamp: item.showTime || (Date.now() - (allItems.length * 1000 * 60 * 30)),
          is_important: 0
        });
      });
    } catch (err) {
      console.warn(`  HTX [${cat.label}] error:`, err.message);
    }
  }
  return allItems;
}

async function scrapeGate() {
  console.log('Scraping Gate.io Announcements...');
  const url = 'https://www.gate.com/zh/announcements';
  let browser;
  try {
    browser = await launchBrowser();
    const page = await browser.newPage();
    await page.setUserAgent(USER_AGENT);
    await page.setViewport({ width: 1280, height: 900 });
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });
    await new Promise(resolve => setTimeout(resolve, 10000));

    const items = await page.evaluate(() => {
      const results = [];
      const importantKeywords = ['上线', '新币', '下架', '暂停', '维护', '开放', 'Listing', 'Launch', 'Suspend', 'Delist', 'Launchpad'];

      document.querySelectorAll('a[href]').forEach((a) => {
        const href = a.href;
        const text = (a.innerText || a.textContent || '').trim();
        if (
          text.length > 10 &&
          (href.includes('/announcements/') || href.includes('/article/') || href.includes('/notice/')) &&
          !href.endsWith('/zh/announcements') && !href.endsWith('/announcements')
        ) {
          if (!results.find(r => r.url === href)) {
            results.push({
              title: text.split('\n')[0].trim().substring(0, 200),
              content: '',
              source: 'Gate',
              url: href,
              category: 'Announcement',
              timestamp: Date.now() - (results.length * 1000 * 60 * 30),
              is_important: 0
            });
          }
        }
      });
      return results;
    });
    return items;
  } catch (err) {
    console.error('Gate error:', err.message);
    return [];
  } finally {
    if (browser) await browser.close();
  }
}

async function scrapePolymarketBreaking() {
  const url = 'https://polymarket.com/breaking/world';
  return scrapePolymarketGeneric(url, 'Poly-Breaking');
}

async function scrapePolymarketChina() {
  const url = 'https://polymarket.com/predictions/china';
  return scrapePolymarketGeneric(url, 'Poly-China');
}

async function scrapePolymarketGeneric(url, sourceName) {
  let browser;
  try {
    browser = await launchBrowser();
    const page = await browser.newPage();
    await page.setUserAgent(USER_AGENT);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 90000 });
    await new Promise(resolve => setTimeout(resolve, 12000));
    const items = await page.evaluate((src) => {
      const results = [];
      document.querySelectorAll('a').forEach((a) => {
        const href = a.href;
        const text = a.innerText.trim();
        if (href.includes('/event/') && text.length > 15) {
          if (!results.find(r => r.url === href)) {
            const cleanTitle = text.replace(/^\d+\s+/, '').replace(/\n/g, ' ').trim();
            results.push({
              title: cleanTitle,
              content: `Prediction Market: ${cleanTitle}`,
              source: src,
              url: href,
              category: 'Market',
              timestamp: Date.now() - Math.random() * 1000000,
              is_important: 0
            });
          }
        }
      });
      return results;
    }, sourceName);
    return items;
  } catch (err) {
    console.error(`${sourceName} error:`, err.message);
    return [];
  } finally {
    if (browser) await browser.close();
  }
}

/**
 * 严格执行准入规则判定重要性
 */
function checkImportance(item) {
  const title = item.title.toUpperCase();
  const source = item.source.toUpperCase();

  // ⛔ 硬封锁：以下平台的任何消息禁止推送到企业微信，不受任何其他规则影响
  const WECOM_BLOCKED = [
    'TECHFLOW', 'BLOCKBEATS',
    'POLY-BREAKING', 'POLY-CHINA',
    'TWITTERAB', 'WUSHUO', 'PHYREX', 'XIEJIAYIN', 'JUSTINSUN'
  ];
  if (WECOM_BLOCKED.includes(source)) return 0;

  // 规则 3: 香港合规交易所 (HashKey, OSL) 的任何消息均为重要
  if (source.includes('HASHKEY') || source.includes('OSL')) {
    return 1;
  }

  // 规则 1: 香港 (HK) 相关政策、牌照、业务进展
  const HK_KEYWORDS = ['香港', 'HK', 'HONG KONG', '牌照', '监管', 'VASP', 'SFC', '证监会'];
  if (item.category === 'HK' || HK_KEYWORDS.some(k => title.includes(k))) {
    return 1;
  }

  // 规则 2: 主流交易所重大动作 (排除普通上币)
  const MAINSTREAM = ['BINANCE', 'OKX', 'BYBIT', 'HTX', 'GATE', 'BITGET', 'KUCOIN', 'MEXC'];
  if (MAINSTREAM.some(m => source.includes(m))) {
    // 排除普通上币、常规维护、小币种活动
    const EXCLUDE = ['LISTING', 'LAUNCHED', '上线', '上架', '新币', 'LAUNCHPOOL', 'LAUNCHPAD', 'DEPOSIT', 'AIRDROP', 'CONVERT', 'GIVEAWAY', 'STAKING'];
    if (EXCLUDE.some(k => title.includes(k))) {
      return 0;
    }
    // 仅针对真正的重大动作：监管、法律、牌照、核心高层、战略级收购/投资
    const MAJOR = ['PENALTY', 'REGULAT', 'LICENSE', 'ACQUISITION', 'UPGRADE', '处罚', '高层', 'CEO', '收购', '牌照', 'STRATEGIC', 'INVEST', '法律', '合规', '法院', '政府'];
    if (MAJOR.some(k => title.includes(k))) {
      return 1;
    }
    // 如果是维护，只推送“全站维护”或“系统升级”类的，排除“某某代币维护”
    if ((title.includes('维护') || title.includes('升级')) && (title.includes('全站') || title.includes('系统') || !title.includes('-'))) {
      return 1;
    }
    return 0; // 其他交易所消息默认不推送，除非 AI 判定为重要
  }

  return item.is_important || 0;
}

async function runAllScrapers() {
  console.log('--- Starting Global Scrape ---');
  const scraperFuncs = [
    scrapeTechFlow, scrapePRNewswire, scrapeBlockBeats, scrapeTwitterKOLs,
    scrapeOSL, scrapeTechubNews, scrapeOKX, scrapeExio, scrapeMatrixport,
    scrapeWuBlock, scrapeHashKeyGroup, scrapeKuCoin, scrapeHashKeyExchange,
    scrapeBinance, scrapeBybit, scrapeBitget, scrapeMexc,
    scrapePolymarketBreaking, scrapePolymarketChina, scrapeGate
  ];

  let results = [];
  const BATCH_SIZE = 4; // limit concurrency
  for (let i = 0; i < scraperFuncs.length; i += BATCH_SIZE) {
    console.log(`--- Running batch ${Math.floor(i / BATCH_SIZE) + 1} of ${Math.ceil(scraperFuncs.length / BATCH_SIZE)} ---`);
    const batch = scraperFuncs.slice(i, i + BATCH_SIZE);
    const batchResults = await Promise.all(batch.map(f => f()));
    results = results.concat(...batchResults);
    if (i + BATCH_SIZE < scraperFuncs.length) {
      await new Promise(r => setTimeout(r, 2000)); // Sleep between batches
    }
  }

  const htx = await scrapeHtx();
  const rawNews = [].concat(...results, htx);

  // 1. 内存去重 (Title + Source)
  const seen = new Set();
  const allNews = rawNews.filter(item => {
    const key = `${item.title.trim()}|${item.source.trim()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  console.log(`--- Finished Scrape. Found ${allNews.length} items (after deduplication). ---`);

  // 2. 批量查询数据库状态 (URL + Title/Source)
  const { processed: alreadyProcessed, sentToWeCom: alreadySentToWeCom, existingTimestamps } =
    await getAlreadyProcessed(allNews);

  console.log(`  Total: ${allNews.length} | Processed: ${alreadyProcessed.size} | Sent: ${alreadySentToWeCom.size}`);

  const processedNews = [];
  let aiCallCount = 0;
  // 扩大 AI 覆盖范围，确保主流交易所的“重大动作”能被识别
  const AI_SOURCES = new Set([
    'TechubNews', 'Exio', 'OSL', 'WuBlock', 'PRNewswire', 'HTX', 'MEXC', 'Gate',
    'Binance', 'OKX', 'Bybit', 'Bitget', 'KuCoin', 'HashKeyGroup', 'HashKeyExchange'
  ]);
  const MAX_AI_PER_RUN = 60;

  for (const item of allNews) {
    const isAlreadySent = alreadySentToWeCom.has(item.url) || alreadySentToWeCom.has(item.title + '|' + item.source);
    const isAlreadyProcessed = alreadyProcessed.has(item.url) || alreadyProcessed.has(item.title + '|' + item.source);
    const dbTimestamp = existingTimestamps.get(item.url) || existingTimestamps.get(item.title + '|' + item.source);

    // 强制执行 48h 规则：优先使用数据库记录的首次发现时间
    const finalTimestamp = dbTimestamp || item.timestamp;
    const isRecent = (Date.now() - finalTimestamp) <= 48 * 60 * 60 * 1000;

    // 3. 启发式预判重要性
    item.is_important = checkImportance(item);

    // 4. AI 处理 (如果尚未处理且属于 AI 源)
    if (AI_SOURCES.has(item.source) && !isAlreadyProcessed && aiCallCount < MAX_AI_PER_RUN) {
      // 过滤掉明显不重要的上币信息，节省 AI 额度
      const isListing = /Listing|上线|上架|New Pair/i.test(item.title);
      if (!isListing || item.source.includes('HashKey') || item.source.includes('OSL')) {
        console.log(`  [AI] ${item.source}: ${item.title.substring(0, 50)}...`);
        if (aiCallCount > 0) await new Promise(r => setTimeout(r, 3000));
        const aiResult = await processWithAI(item.title, item.content);
        aiCallCount++;
        if (aiResult) {
          Object.assign(item, aiResult);
          // 再次应用 checkImportance 确保 AI 结果符合准入规则
          item.is_important = (aiResult.is_important === 1 || checkImportance(item) === 1) ? 1 : 0;
        }
      }
    }

    // ⛔ 硬封锁逻辑（严格过滤限制平台）
    const WECOM_BLOCKED = [
      'TECHFLOW', 'BLOCKBEATS',
      'POLY-BREAKING', 'POLY-CHINA', 'MARKET',
      'TWITTERAB', 'WUSHUO', 'PHYREX', 'XIEJIAYIN', 'JUSTINSUN', 'KOL'
    ];
    if (WECOM_BLOCKED.some(s => item.source.toUpperCase().includes(s))) {
      item.is_important = 0;
    }

    // 5. 企业微信推送
    if (item.is_important === 1 && !isAlreadySent && isRecent) {
      console.log(`  [WeCom Push] ${item.source}: ${item.title.substring(0, 50)}`);
      try {
        await sendToWeCom(item);
        item.sent_to_wecom = 1;
        // 关键修复：发送成功后立即更新数据库状态，防止后续逻辑报错导致重复发送
        await updateSentStatus(item);
      } catch (err) {
        console.error(`  [WeCom Error] ${item.source}:`, err.message);
      }
    } else if (item.is_important === 1 && isAlreadySent) {
      item.sent_to_wecom = 1;
    }

    processedNews.push(item);
  }

  await saveNews(processedNews);
  console.log(`--- Finished All. Saved ${processedNews.length} items. ---`);
  return processedNews;
}

module.exports = { runAllScrapers };
