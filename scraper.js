const axios = require('axios');
const cheerio = require('cheerio');
const puppeteer = require('puppeteer');
const puppeteerExtra = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteerExtra.use(StealthPlugin());
const { saveNews, db, getAlreadyProcessed, updateSentStatus, normalizeKey, updateSourcePush, canPushMessage, checkIfSent } = require('./db');
const { processWithAI } = require('./ai');
const { sendToWeCom } = require('./wecom');
const { filterNewsItems, getSourceConfig } = require('./filter');
const { SOURCE_CONFIGS, DEFAULT_SOURCE_CONFIG } = require('./config');

const MAX_RETRIES = 3;
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
          timestamp: 0, // Placeholder, will be set to discovery time in main loop if new
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
  const seenTitles = new Set(); // 新增：标题去重

    // 仅匹配实际新闻稿 URL（含 .html 的文章页，排除分类/导航页）
    $('a[href*="/news-releases/"][href$=".html"]').each((i, el) => {
      const href = $(el).attr('href');
      if (!href) return;
            // URL 规范化：移除查询参数和尾部斜杠，防止同一文章不同 URL 变体
   let fullUrl = href.startsWith('http') ? href : `https://www.prnewswire.com${href}`;
   const normalizedUrl = fullUrl.split('?')[0].replace(/\/$/, ''); // 移除？后的参数和尾部/
      if (seenUrls.has(normalizedUrl)) return;
      seenUrls.add(normalizedUrl);

      // 提取标题：优先用子元素中的标题标签，否则用链接文本并去掉日期前缀
      const titleEl = $(el).find('h3, h2, .title, [class*="title"], [class*="headline"]').first();
      let title = (titleEl.length ? titleEl.text() : $(el).text()).trim();
      // 去掉可能混入的日期前缀（如 "02 Mar, 2026, 22:00 CST "）
      title = title.replace(/^\d{1,2}\s+\w{3},\s+\d{4},?\s+[\d:]+\s*[A-Z]+\s*/i, '').trim();
        // 归一化标题用于去重：转小写、移除多余空格
   const normalizedTitle = title.toLowerCase().replace(/\s+/g, ' ').trim();
     
     // 标题去重：防止同一新闻的不同 URL 版本
   if (!title || title.length < 15 || seenTitles.has(normalizedTitle)) return;
     seenTitles.add(normalizedTitle);

      const timeStr = $(el).closest('.card, .row, article, li, .col-sm-12').find('small, time, [class*="date"], [class*="time"], h3 + p').first().text().trim();
      
      // PRNewswire specific date parsing
      let timestamp = 0;
      if (timeStr) {
        // Remove timezone abbreviations
        let cleanTime = timeStr.replace(/\s+(HKT|CST|EST|PST|GMT)/i, '').trim();
        
        // Match time pattern (HH:MM) anywhere in the string
        const timeMatch = cleanTime.match(/(\d{1,2}:\d{2})/);
        
        if (timeMatch) {
            // Found a time string, assume it's TODAY
            const now = new Date();
            const [hours, minutes] = timeMatch[1].split(':').map(Number);
            const d = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hours, minutes);
            timestamp = d.getTime();
            
            // Adjust if time is slightly in future (e.g. server timezone diff)
            if (timestamp > Date.now() + 1000 * 60 * 60) {
                timestamp -= 24 * 60 * 60 * 1000;
            }
        } else {
            // Try standard date parsing
            const d = new Date(cleanTime);
            if (!isNaN(d.getTime())) {
              timestamp = d.getTime();
            }
        }
      }
      
      // Strict Mode: If no valid timestamp found, DROP the item.
      // Do NOT fallback to Date.now() to avoid pushing old news as new.
      if (!timestamp || isNaN(timestamp)) {
        return;
      }

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

    const validItems = items.filter(item => item.timestamp && !isNaN(item.timestamp));
    console.log(`PRNewswire: Found ${validItems.length} items`);
    return validItems;
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
        let timestamp = 0;
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
        
        // ⚠️ REMOVED: Fallback timestamp (Date.now() - i * 60000)
        // Skip items without valid timestamp (strict mode for BlockBeats)
        if (!timestamp) {
          return;
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
            timestamp: pubDate ? new Date(pubDate).getTime() : 0,
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

    // Wait for any news-like element to appear
    await page.waitForSelector(
      'a[href*="/announcement/"], .ant-list-item, [class*="news"], [class*="article"], [class*="post"]',
      { timeout: 30000 }
    ).catch(() => {});
    await new Promise(resolve => setTimeout(resolve, 5000));

    const items = await page.evaluate(() => {
      const results = [];
      const seen = new Set();

      // Strategy 1: links that contain /announcement/ in href
      document.querySelectorAll('a[href*="/announcement/"]').forEach(link => {
        const title = (link.innerText || link.textContent || '').trim().split('\n')[0].trim();
        const href = link.href;
        if (!title || title.length < 8 || seen.has(href)) return;
        seen.add(href);

        // Look for a date near this link
        const container = link.closest('li, article, div[class*="item"], div[class*="card"], div[class*="news"]') || link.parentElement;
        const containerText = container ? container.innerText : '';
        const dateMatch = containerText.match(/\d{4}[.\/-]\d{1,2}[.\/-]\d{1,2}/);
        const ts = dateMatch ? new Date(dateMatch[0].replace(/\./g, '-')).getTime() : Date.now();

        results.push({
          title,
          content: '',
          source: 'OSL',
          url: href,
          category: 'Announcement',
          timestamp: isNaN(ts) ? Date.now() : ts,
          is_important: 0
        });
      });

      // Strategy 2: if still empty, try list items with any OSL link inside
      if (results.length === 0) {
        document.querySelectorAll('.ant-list-item, li, [class*="item"]').forEach(el => {
          const link = el.querySelector('a');
          if (!link) return;
          const href = link.href || '';
          const title = (link.innerText || link.textContent || el.innerText || '').trim().split('\n')[0].trim();
          if (!title || title.length < 8 || seen.has(href)) return;
          if (!href.includes('osl.com')) return;
          seen.add(href);
          results.push({
            title,
            content: '',
            source: 'OSL',
            url: href,
            category: 'Announcement',
            timestamp: Date.now(),
            is_important: 0
          });
        });
      }

      return results.slice(0, 20);
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
    const items = [];
    
    articles.forEach((item, i) => {
      // 1. Strict Timestamp Parsing
      let timestamp = 0;
      // TechubNews API returns 'created_at' (ISO string) or 'publish_time'
      const timeSource = item.created_at || item.publish_time;
      if (timeSource) {
        // Handle ISO string or timestamp
        if (typeof timeSource === 'string' && timeSource.includes('T')) {
            timestamp = new Date(timeSource).getTime();
        } else {
            const pt = Number(timeSource);
            // If it's in seconds (less than year 3000 in ms), convert to ms
            timestamp = pt < 10000000000 ? pt * 1000 : pt;
        }
      }

      // If no valid time, skip it (don't fake it with Date.now())
      if (!timestamp || isNaN(timestamp)) return;

      // 2. Stable URL Construction
      // Always use the internal ID-based URL to prevent duplicates from external link variations
      // TechubNews API may return 'link' or 'url' field that contains the actual article URL
    const actualUrl = item.link || item.url || `https://www.techub.news/article/${item.uid || item.id}`;
    const normalizedUrl = actualUrl.split('?')[0].replace(/#.*$/, ''); // 移除参数和锚点

      items.push({
        title: item.title || '',
        content: `Original Link: ${item.original_link || 'N/A'}\n${item.brief || ''}`,
        source: 'TechubNews',
        url: actualUrl, // 使用实际 URL，确保链接可访问
        category: 'HK',
        timestamp,
        is_important: 0
      });
    });

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
      timestamp: item.pTime ? Number(item.pTime) : 0,
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

      // EX.IO typically has date in a span or small tag near the link
      let timestamp = 0;
      const container = $(el).closest('li, div, article');
      // Try to find exact date element
      let dateText = container.find('span, small, .date, time').text().trim();
      
      // If not found or empty, search in container text
      if (!dateText) {
          dateText = container.text();
      }

      // Try multiple formats
      const dateMatch = dateText.match(/(\d{2}\.\d{2}\.\d{4})|(\w{3}\s\d{1,2},?\s+\d{4})|(\d{4}-\d{2}-\d{2})/);
      if (dateMatch) {
         // Fix DD.MM.YYYY format for Date.parse (needs YYYY-MM-DD or MM/DD/YYYY)
         let dStr = dateMatch[0];
         if (dStr.includes('.')) {
             const parts = dStr.split('.');
             if (parts.length === 3) dStr = `${parts[2]}-${parts[1]}-${parts[0]}`;
         }
         const d = new Date(dStr);
         if (!isNaN(d.getTime())) timestamp = d.getTime();
      }

      // If no valid timestamp, skip to avoid pushing old news as new
      if (!timestamp) return;

      items.push({
        title,
        content: '',
        source: 'Exio',
        url: fullUrl,
        category: 'Announcement',
        timestamp,
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
 const seenUrls = new Set();
 const seenTitles = new Set();

    $('a[href*="/zh-CN/articles/"]').each((i, el) => {
      const href = $(el).attr('href') || '';
      const title = $(el).text().trim();
      if (!title || title.length < 5) return;
      const fullUrl = href.startsWith('http') ? href : `https://helpcenter.matrixport.com${href}`;
    const normalizedUrl = fullUrl.split('?')[0];
    const normalizedTitle = title.toLowerCase().replace(/\s+/g, ' ');
     
      // 双重去重
    if (seenUrls.has(normalizedUrl) || seenTitles.has(normalizedTitle)) return;
    seenUrls.add(normalizedUrl);
    seenTitles.add(normalizedTitle);

      items.push({
        title: title.substring(0, 200),
        content: '',
        source: 'Matrixport',
        url: fullUrl,
        category: 'Announcement',
        timestamp: Date.now(), // 使用当前时间作为 fallback
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
  const seenUrls = new Set();
  const seenTitles = new Set();
      document.querySelectorAll('a').forEach((a, i) => {
        const href = a.href;
        const title = a.innerText.trim();
        if (href.includes('a=show') && title.length > 10 && title.includes('香港')) {
          // URL 和标题双重去重
         const normalizedUrl = href.split('#')[0];
         const normalizedTitle = title.toLowerCase().replace(/\s+/g, ' ');
         
         if (seenUrls.has(normalizedUrl) || seenTitles.has(normalizedTitle)) {
          return;
         }
         
         seenUrls.add(normalizedUrl);
          seenTitles.add(normalizedTitle);
           results.push({
             title,
             content: '',
             source: 'WuBlock',
             url: href,
             category: 'HK',
             timestamp: Date.now(),
             is_important: 0
           });
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

      // Attempt to find date in the parent container
      let timestamp = 0;
      const container = $(el).closest('div, li, tr, section, article');
      const textContent = container.text();

      // Match YYYY-MM-DD, "Jan. 20, 2025", "Jan 20, 2025", "January 20, 2025"
      const dateMatch = textContent.match(
        /(\d{4}-\d{2}-\d{2})|([A-Za-z]{3,9}\.?\s+\d{1,2},?\s+\d{4})/
      );

      if (dateMatch) {
         const d = new Date(dateMatch[0].replace('.', ''));
         if (!isNaN(d.getTime())) timestamp = d.getTime();
      }

      // ⚠️ REMOVED: Fallback timestamp that could cause old news to appear new
      // If no valid timestamp found, skip this item (strict mode for HashKeyGroup)
      if (!timestamp) {
        console.log(`  [SKIP] HashKeyGroup: No valid timestamp for "${title.substring(0, 40)}"`);
        return;
      }

      items.push({
        title,
        content: '',
        source: 'HashKeyGroup',
        url: fullUrl,
        category: 'Announcement',
        timestamp,
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
      let timestamp = 0;
      if (dateMatch) {
        timestamp = new Date(dateMatch[0]).getTime();
        text = text.replace(dateMatch[0], '').trim();
      } else {
        // ⚠️ REMOVED: Fallback timestamp that could cause old news to appear new
        // Skip items without valid timestamp
        console.log(`  [SKIP] KuCoin: No valid timestamp for "${text.substring(0, 40)}"`);
        return;
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
      timestamp: article.created_at ? new Date(article.created_at).getTime() : 0,
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
          timestamp: item.releaseDate ? Number(item.releaseDate) : 0,
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
              timestamp: 0,
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
              
              // Try to find date in parent or siblings
              let timestamp = 0;
              const container = a.closest('.article-item, li, tr, div[class*="item"]');
              if (container) {
                 // Try finding explicit time elements
                 const timeEl = container.querySelector('time, span[class*="date"], .time');
                 const timeText = timeEl ? timeEl.innerText.trim() : container.innerText;
                 
                 // Bitget often uses relative time (e.g., "3 hours ago") or date (YYYY-MM-DD)
                 if (timeText.match(/(\d+)\s*(hour|minute|day)s?\s*ago/i)) {
                     const match = timeText.match(/(\d+)\s*(hour|minute|day)s?\s*ago/i);
                     const num = parseInt(match[1]);
                     const unit = match[2];
                     const now = Date.now();
                     if (unit.startsWith('minute')) timestamp = now - num * 60 * 1000;
                     else if (unit.startsWith('hour')) timestamp = now - num * 60 * 60 * 1000;
                     else if (unit.startsWith('day')) timestamp = now - num * 24 * 60 * 60 * 1000;
                 } else {
                     const d = new Date(timeText);
                     if (!isNaN(d.getTime())) timestamp = d.getTime();
                     else {
                         // Try to extract date
                         const dateMatch = timeText.match(/(\d{4}-\d{2}-\d{2})/);
                         if (dateMatch) {
                             const d2 = new Date(dateMatch[0]);
                             if (!isNaN(d2.getTime())) timestamp = d2.getTime();
                         }
                     }
                 }
              }
              
              // If no date found, skip item (strict timestamp policy for Bitget)
              if (!timestamp) {
                console.log(`  [SKIP] Bitget: No valid timestamp for "${text.substring(0, 40)}"`);
                return;
              }

              results.push({
                title: text.split('\n')[0].trim().substring(0, 200),
                content: '',
                source: 'Bitget',
                url: href,
                category: 'Announcement',
                timestamp,
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
              timestamp: 0,
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
          timestamp: item.showTime || 0,
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

      // Gate has a navigation sidebar that matches these selectors. We need to avoid it.
      // Usually the main list is in a specific container or has specific classes.
      // Let's look for "article-item" or list-like structures.
      const candidates = document.querySelectorAll('.article-item, .entry-item, .item');
      
      // If candidates found, iterate them. If not, fallback to broad search but try to filter out nav links.
      const elements = candidates.length > 0 ? candidates : document.querySelectorAll('a[href*="/announcements/"], a[href*="/article/"]');

      elements.forEach((el) => {
        // If el is a container, find the link inside
        const a = el.tagName === 'A' ? el : el.querySelector('a');
        if (!a) return;

        const href = a.href;
        const text = (a.innerText || a.textContent || '').trim();
        
        // Filter out obvious nav links (short, generic)
        if (text.length < 10 || text === '近期公告' || text === '更多') return;

        if (
          (href.includes('/announcements/') || href.includes('/article/') || href.includes('/notice/')) &&
          !href.endsWith('/zh/announcements') && !href.endsWith('/announcements')
        ) {
          if (!results.find(r => r.url === href)) {
            // Attempt to find date
            let timestamp = 0;
            // 1. Try inside the container first
            let container = el.tagName === 'A' ? el.closest('.item, .article-item, li, tr') : el;
            
            // If no container found, use parent
            if (!container) container = el.parentElement;

            if (container) {
                // Try finding explicit time elements
                const timeEl = container.querySelector('.time, .date, .create-time, span[class*="time"]');
                if (timeEl) {
                    const d = new Date(timeEl.innerText.trim());
                    if (!isNaN(d.getTime())) timestamp = d.getTime();
                } else {
                    // Try finding date pattern in text content
                    const dateMatch = container.innerText.match(/(\d{4}-\d{2}-\d{2}(\s\d{2}:\d{2})?)|(\w{3}\s\d{1,2},\s\d{4})/);
                    if (dateMatch) {
                        const d = new Date(dateMatch[0]);
                        if (!isNaN(d.getTime())) timestamp = d.getTime();
                    }
                }
            }

            // Strict Mode: No timestamp = No push
            if (!timestamp) return;

            results.push({
              title: text.split('\n')[0].trim().substring(0, 200),
              content: '',
              source: 'Gate',
              url: href,
              category: 'Announcement',
              timestamp,
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
              timestamp: 0,
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

const { WECOM_BLOCK_SOURCES, HK_SOURCES, PR_HK_COMPANIES, PR_TOP_EXCHANGES, 
        MAINSTREAM_EXCHANGES, EXCHANGE_EXCLUDE_KEYWORDS, EXCHANGE_MAJOR_KEYWORDS,
        HK_KEYWORDS } = require('./config');

/**
 * 严格按规则判定重要性 (使用 config.js 中的配置)
 * 规则：
 * - BLOCK_LIST: 不推送
 * - HK_SOURCES: 全部推送
 * - PRNewswire: 仅香港相关或头部离岸所
 * - MAINSTREAM_EXCHANGES: 排除上币/链上类后推送
 */
function checkImportance(item) {
  const title = item.title;
  const source = item.source;
  const titleLower = title.toLowerCase();
  const sourceUpper = source.toUpperCase();

  // 🚫 BLOCK_LIST: 不推送 (from config)
  if (WECOM_BLOCK_SOURCES.has(source)) {
    return 0;
  }

  // ✅ HK_SOURCES: 香港板块全部推送 (from config)
  if (HK_SOURCES.has(sourceUpper)) {
    return 1;
  }

  // ⚠️ PRNewswire: 仅香港相关或头部离岸所 (from config)
  if (sourceUpper === 'PRNEWswire') {
    const isHKRelated = PR_HK_COMPANIES.some(c => titleLower.includes(c));
    const isTopExchange = PR_TOP_EXCHANGES.some(e => titleLower.includes(e));
    
    if (isHKRelated || isTopExchange) {
      return 1;
    }
    return 0;
  }

  // ⚠️ MAINSTREAM_EXCHANGES: 排除上币/链上类后推送 (from config)
  if (MAINSTREAM_EXCHANGES.has(sourceUpper)) {
    // 排除关键词 (from config)
    const shouldExclude = EXCHANGE_EXCLUDE_KEYWORDS.some(kw => titleLower.includes(kw));
    if (shouldExclude) {
      return 0;
    }
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

  // 1. 内存去重与过滤 (Filter + Deduplication)
  const allNews = filterNewsItems(rawNews);

  console.log(`--- Finished Scrape. Found ${allNews.length} items (after filtering & deduplication). ---`);

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

  // ===== 核心逻辑：基于状态的增量推送 (State-based Incremental Push) =====
  // 不再设置硬性的时间限制（如24h内），而是完全依赖数据库的“已发送”状态。
  // 只要是数据库中没记录的新标题，或者是记录了但从未发送成功的，都允许进入推送判定。

  const sentThisRun = new Set();
  const pushLock = new Set(); // 防止并发推送同一条消息

  for (const item of allNews) {
    const nTitle = normalizeKey(item.title, '').split('|')[0];
    const cacheKey = nTitle + '|' + (item.source || '').trim().toLowerCase();

    // 检查是否已经发送或处理过
    const isAlreadySent = alreadySentToWeCom.has(item.url) || alreadySentToWeCom.has(cacheKey) || alreadySentToWeCom.has(nTitle);
    const isAlreadyProcessed = alreadyProcessed.has(item.url) || alreadyProcessed.has(cacheKey) || alreadyProcessed.has(nTitle);
    const dbTimestamp = existingTimestamps.get(item.url) || existingTimestamps.get(cacheKey) || existingTimestamps.get(nTitle);

    // 稳定时间戳：保持首次发现的时间
    let finalTimestamp = dbTimestamp || item.timestamp;
    if (!finalTimestamp || finalTimestamp === 0) {
        finalTimestamp = Date.now();
        item.timestamp = finalTimestamp;
    } else {
        item.timestamp = finalTimestamp;
    }

    // 3. 启发式预判重要性
    item.is_important = checkImportance(item);

    // 4. AI 处理 (如果尚未处理过该内容)
    if (AI_SOURCES.has(item.source) && !isAlreadyProcessed && aiCallCount < MAX_AI_PER_RUN) {
      // 过滤掉明显不重要的上币信息，节省 AI 额度
      const isListing = /Listing|上线|上架|New Pair/i.test(item.title);
      if (!isListing || item.source.includes('HashKey') || item.source.includes('OSL')) {
        console.log(`  [AI Check] ${item.source}: ${item.title.substring(0, 50)}...`);
        if (aiCallCount > 0) await new Promise(r => setTimeout(r, 2000));
        const aiResult = await processWithAI(item.title, item.content);
        aiCallCount++;
        if (aiResult) {
          Object.assign(item, aiResult);
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

    // 5. 企业微信推送 — 只要没发过且判定为重要，就允许发送
    if (item.is_important === 1 && !isAlreadySent) {
      // 获取源配置
      const sourceConfig = getSourceConfig(item.source);
      
      // 检查源级别冷却时间
      if (!(await canPushMessage(item.source, item.title, item.timestamp, sourceConfig.pushCooldownHours))) {
        console.log(`  [SKIP COOLDOWN] ${item.source}: 冷却期内 (${sourceConfig.pushCooldownHours}h): ${item.title.substring(0, 40)}`);
        item.sent_to_wecom = 1;
        await saveNews([item]).catch(e => console.warn('[Save skip cooldown]', e.message));
        processedNews.push(item);
        continue;
      }
    
      // 本次运行内的内存去重
      if (sentThisRun.has(nTitle)) {
        console.log(`  [SKIP] 本次运行已发送过相似内容: ${item.title.substring(0, 40)}`);
        item.sent_to_wecom = 1;
        await saveNews([item]).catch(e => console.warn('[Save sent this run]', e.message));
        processedNews.push(item);
        continue;
      }

      // 并发锁检查 - 防止同一批次中重复推送相似内容
      const lockKey = nTitle;
      if (pushLock.has(lockKey)) {
        console.log(`  [SKIP] 当前批次正在处理相似内容: ${item.title.substring(0, 40)}`);
        item.sent_to_wecom = 1;
        await saveNews([item]).catch(e => console.warn('[Save pushLock]', e.message));
        processedNews.push(item);
        continue;
      }
      pushLock.add(lockKey);

      // 发送前最后一次实时数据库校验
      const isActuallySent = await checkIfSent(item.url, nTitle);

      if (isActuallySent) {
        console.log(`  [SKIP] 数据库记录显示已发送: ${item.title.substring(0, 40)}`);
        item.sent_to_wecom = 1;
        await saveNews([item]).catch(e => console.warn('[Save dbCheck]', e.message));
        processedNews.push(item);
        pushLock.delete(lockKey);
        continue;
      }

      console.log(`  [PUSHING] ${item.source}: ${item.title.substring(0, 50)}`);
      try {
        // 先更新数据库状态为"已发送"，再实际发送
        // 这样即使发送失败，也不会导致重复发送
        item.sent_to_wecom = 1;
        sentThisRun.add(nTitle);

        // 如果是 SQLite 模式，本地更新状态
        if (db) {
          try {
            const updateTx = db.transaction(() => {
              if (item.url) {
                db.prepare(`UPDATE news SET sent_to_wecom = 1 WHERE url = ?`).run(item.url);
              }
              db.prepare(`UPDATE news SET sent_to_wecom = 1 WHERE title = ? AND source = ?`).run(item.title, item.source);
              db.prepare(`UPDATE news SET sent_to_wecom = 1 WHERE normalized_title = ? AND source = ?`).run(nTitle, item.source);
            });
            updateTx();
          } catch (_) {}
        }

        // 数据库状态更新后再发送消息
        await sendToWeCom(item);

        // ✅ 新增：更新源追踪信息（记录最后推送的消息 and 时间）
        await updateSourcePush(item.source, item.timestamp, item.title);


        // 异步更新 Supabase（如果启用）
        updateSentStatus(item).catch(err => {
          console.warn(`  [Supabase Update Error] ${item.title.substring(0, 40)}:`, err.message);
        });
      } catch (err) {
        console.error(`  [PUSH ERROR] ${item.source}:`, err.message);
        // 发送失败时，不删除 pushLock，防止立即重试导致重复
        // 但标记为未发送，下次可以重试
        item.sent_to_wecom = 0;
      } finally {
        pushLock.delete(lockKey);
      }
    } else if (item.is_important === 1 && isAlreadySent) {
      // 虽然是重要消息但已发过，保持标记
      item.sent_to_wecom = 1;
    }

    processedNews.push(item);
  }

  await saveNews(processedNews);
  console.log(`--- Finished All. Saved ${processedNews.length} items. ---`);
  return processedNews;
}

module.exports = { runAllScrapers };
