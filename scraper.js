const axios = require('axios');
const cheerio = require('cheerio');
const puppeteer = require('puppeteer');
const puppeteerExtra = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteerExtra.use(StealthPlugin());
const { saveNews, db } = require('./db');

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
    
    $('.card, .row').each((i, el) => {
      const link = $(el).find('a[href*="/news-releases/"]').first();
      const title = link.text().trim();
      const href = link.attr('href');
      if (!title || !href) return;

      const fullUrl = href.startsWith('http') ? href : `https://www.prnewswire.com${href}`;
      const timeStr = $(el).find('small').text().trim();
      
      items.push({
        title,
        content: '',
        source: 'PRNewswire',
        url: fullUrl,
        category: 'PR',
        timestamp: timeStr ? new Date(timeStr).getTime() : Date.now() - (i * 1000 * 60 * 15),
        is_important: 0
      });
    });
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
        // 跳过垃圾条目（Weibo分享链接、空标题、锚点链接）
        if (text.length > 5 && itemUrl && !itemUrl.includes('weibo.com') && !itemUrl.includes('share.php')) {
          results.push({
            title: text.substring(0, 150) + (text.length > 150 ? '...' : ''),
            content: contentEl ? contentEl.innerText.trim() : text,
            source: 'BlockBeats',
            url: itemUrl,
            category: 'Newsflash',
            timestamp: Date.now() - (i * 60000),
            is_important: isImportant ? 1 : 0
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
            is_important: (cleanTitle.includes('BREAKING') || cleanTitle.includes('重要')) ? 1 : 0
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
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    
    // OSL is highly dynamic, needs more wait
    await new Promise(resolve => setTimeout(resolve, 20000));
    
    const items = await page.evaluate(() => {
      const results = [];
      // Search for any element containing "OSL HK" which is common in their announcements
      const elements = Array.from(document.querySelectorAll('div, li')).filter(el => 
        (el.innerText.includes('OSL HK') || el.innerText.includes('鏂板梗涓婄窔')) && 
        (el.innerText.includes('2025') || el.innerText.includes('2026')) &&
        el.innerText.length < 200 // Avoid large containers
      );
      
      elements.forEach((el, i) => {
        // Split by newline to get title (first line)
        const lines = el.innerText.trim().split('\n');
        const title = lines[0].trim();
        const dateStr = lines.length > 1 ? lines[1].trim() : '';
        
        // Find the closest link
        let href = 'https://www.osl.com/hk/announcement';
        const link = el.querySelector('a') || el.closest('a') || el.parentElement.querySelector('a');
        if (link) href = link.href;

        if (title.length > 5 && !results.find(r => r.title === title)) {
          results.push({
            title,
            content: '',
            source: 'OSL',
            url: href,
            category: 'Announcement',
            timestamp: Date.now() - (i * 1000 * 60 * 60 * 5), // Artificial separation
            is_important: (title.includes('Listing') || title.includes('上架') || title.includes('暂停')) ? 1 : 0
          });
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
      url: `https://www.techub.news/articleDetail/${item.id}`,
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
      is_important: (item.title.includes('Launchpad') || item.title.includes('Listing') || item.title.includes('暂停')) ? 1 : 0
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
        is_important: (title.includes('上线') || title.includes('暂停') || title.includes('维护')) ? 1 : 0
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
  // Direct URL to avoid 301 redirect with non-ASCII Location header (causes axios loop)
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
        is_important: importantKeywords.some(k => title.includes(k)) ? 1 : 0
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
        if (href.includes('a=show') && title.length > 10) {
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
        is_important: (title.includes('Listing') || title.includes('HSK') || title.includes('RWA')) ? 1 : 0
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

      // Extract date if present (e.g., 2026/02/27)
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
        is_important: (text.includes('Listing') || text.includes('涓婄嚎') || text.includes('鍗囩礆')) ? 1 : 0
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
      is_important: (article.title.includes('List') || article.title.includes('Suspend') || article.title.includes('Maintenance')) ? 1 : 0
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
  // Catalog 48 is "New Crypto Listing", 49 is "Latest Service Updates"
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
          is_important: (cid === 48 || item.title.includes('Binance Will Launch') || item.title.includes('Maintenance')) ? 1 : 0
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
              is_important: (text.includes('上线') || text.includes('下架') || text.includes('维护')) ? 1 : 0
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
  // Bitget WAF blocks plain axios; use stealth Puppeteer to navigate category pages
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
                is_important: kws.some(k => text.includes(k)) ? 1 : 0
              });
            }
          });
          return results;
        }, importantKeywords);

        found.forEach(item => {
          if (!allItems.find(i => i.url === item.url)) allItems.push(item);
        });
        console.log(`  Bitget [${cat.label}]: +${found.length} items`);
      } catch (err) {
        console.warn(`  Bitget [${cat.label}] error:`, err.message);
      }
    }
  } catch (err) {
    console.error('Bitget launch error:', err.message);
  } finally {
    if (browser) await browser.close();
  }

  console.log(`Bitget: Found ${allItems.length} items total`);
  return allItems;
}

async function scrapeMexc() {
  // MEXC uses Cloudflare — stealth Puppeteer required
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
              is_important: importantKw.some(k => text.includes(k)) ? 1 : 0
            });
          }
        }
      });
      return results;
    });
    console.log(`MEXC: Found ${items.length} items`);
    return items;
  } catch (err) {
    console.error('MEXC error:', err.message);
    return [];
  } finally {
    if (browser) await browser.close();
  }
}

async function scrapeHtx() {
  // HTX internal JSON API — uses Tor proxy in CI (GitHub Actions IPs are blocked by Cloudflare WAF)
  const inCI = process.env.GITHUB_ACTIONS === 'true';
  console.log(`Scraping HTX Announcements (internal API${inCI ? ' via Tor' : ''})...`);
  const BASE = 'https://www.htx.com/-/x/support/public/getList/v2';
  const importantKeywords = ['上线', '下线', '下架', '暂停', '维护', '新币', 'Listing', 'Delist', 'Suspend', 'Maintenance'];
  // Key categories: 最新热点=360000039481, 新币上线=360000039942, 充提/暂停=360000039982, 下架=64971881385864
  const categories = [
    { id: '360000039481', label: '最新热点' },
    { id: '360000039942', label: '新币上线' },
    { id: '360000039982', label: '充提/暂停' },
    { id: '64971881385864', label: '下架资讯' }
  ];
  const ONE_LEVEL_ID = '360000031902'; // 重要公告 parent category
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
          is_important: importantKeywords.some(k => item.title.includes(k)) ? 1 : 0
        });
      });
      console.log(`  HTX [${cat.label}]: +${list.length} items`);
    } catch (err) {
      console.warn(`  HTX [${cat.label}] error:`, err.message);
    }
  }

  console.log(`HTX: Found ${allItems.length} items total`);
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

    // Intercept the underlying JSON API call Gate's SPA makes
    let apiData = null;
    page.on('response', async (response) => {
      const resUrl = response.url();
      if (resUrl.includes('/api/') && resUrl.includes('announcement') && response.status() === 200) {
        try {
          const json = await response.json();
          if (!apiData) apiData = json;
        } catch (_) {}
      }
    });

    await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });
    await new Promise(resolve => setTimeout(resolve, 10000));

    // Try DOM scraping - look for article links rendered after hydration
    const items = await page.evaluate(() => {
      const results = [];
      const importantKeywords = ['上线', '新币', '下架', '暂停', '维护', '开放', 'Listing', 'Launch', 'Suspend', 'Delist', 'Launchpad'];

      document.querySelectorAll('a[href]').forEach((a) => {
        const href = a.href;
        const text = (a.innerText || a.textContent || '').trim();
        // Gate announcement articles match these URL patterns
        if (
          text.length > 10 &&
          (
            href.includes('/announcements/') ||
            href.includes('/article/') ||
            href.includes('/notice/')
          ) &&
          !href.endsWith('/zh/announcements') &&
          !href.endsWith('/announcements')
        ) {
          if (!results.find(r => r.url === href)) {
            const isImportant = importantKeywords.some(k => text.includes(k));
            results.push({
              title: text.split('\n')[0].trim().substring(0, 200),
              content: '',
              source: 'Gate',
              url: href,
              category: 'Announcement',
              timestamp: Date.now() - (results.length * 1000 * 60 * 30),
              is_important: isImportant ? 1 : 0
            });
          }
        }
      });
      return results;
    });

    console.log(`Gate: Found ${items.length} items`);
    return items;
  } catch (err) {
    console.error('Gate error:', err.message);
    return [];
  } finally {
    if (browser) await browser.close();
  }
}

async function scrapePolymarketBreaking() {
  console.log('Scraping Polymarket Breaking...');
  const url = 'https://polymarket.com/breaking/world';
  return scrapePolymarketGeneric(url, 'Poly-Breaking');
}

async function scrapePolymarketChina() {
  console.log('Scraping Polymarket China...');
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
    console.log(`${sourceName}: Found ${items.length} items`);
    return items;
  } catch (err) {
    console.error(`${sourceName} error:`, err.message);
    return [];
  } finally {
    if (browser) await browser.close();
  }
}

const { processWithAI } = require('./ai');
const { sendToWeCom } = require('./wecom');

async function runAllScrapers() {
  console.log('--- Starting Global Scrape ---');
  // Run all scrapers except HTX in parallel first
  // HTX uses Tor proxy in CI — running it after others complete (~60-90s) lets Tor establish circuits
  const [tech, pr, bb, tw, osl, th, okx, exio, mp, wb, hkg, kuc, hke, bin, byb, bit, mex, polyB, polyC, gate] = await Promise.all([
    scrapeTechFlow(),
    scrapePRNewswire(),
    scrapeBlockBeats(),
    scrapeTwitterKOLs(),
    scrapeOSL(),
    scrapeTechubNews(),
    scrapeOKX(),
    scrapeExio(),
    scrapeMatrixport(),
    scrapeWuBlock(),
    scrapeHashKeyGroup(),
    scrapeKuCoin(),
    scrapeHashKeyExchange(),
    scrapeBinance(),
    scrapeBybit(),
    scrapeBitget(),
    scrapeMexc(),
    scrapePolymarketBreaking(),
    scrapePolymarketChina(),
    scrapeGate()
  ]);
  // Run HTX last — Tor has now been running for the duration of all other scrapers
  const htx = await scrapeHtx();
  const allNews = [
    ...tech, ...pr, ...bb, ...tw, ...osl, ...th, ...okx, ...exio, ...mp, ...wb,
    ...hkg, ...kuc, ...hke, ...bin, ...byb, ...bit, ...mex, ...polyB, ...polyC, ...gate, ...htx
  ];

  console.log(`--- Finished Scrape. Found ${allNews.length} items. ---`);

  // --- AI 处理（仅白名单来源）---
  // 只有这些来源的条目需要经过 AI：加标签、判断重要性、重要则推企微
  const AI_SOURCES = new Set(['TechubNews', 'Exio', 'OSL', 'WuBlock', 'PRNewswire', 'HTX', 'MEXC', 'Gate']);
  const MAX_AI_PER_RUN = 50; // 每轮上限，防止 API 超支

  console.log(`--- AI Processing (sources: ${[...AI_SOURCES].join(', ')}) ---`);

  // 从本轮抓取结果中找出白名单来源且有 URL 的条目
  const aiCandidates = allNews.filter(i => AI_SOURCES.has(i.source) && i.url);

  // 批量查询已 AI 处理过的 URL（有 business_category）→ 跳过，省 API 费用
  const alreadyProcessed = new Set();
  // 批量查询已推送过企微的 URL（is_important=1 且在 DB 中）→ 不重复推送
  const alreadySentToWeCom = new Set();

  if (aiCandidates.length > 0) {
    const placeholders = aiCandidates.map(() => '?').join(',');
    const urls = aiCandidates.map(i => i.url);

    db.prepare(`SELECT url FROM news WHERE url IN (${placeholders}) AND business_category != '' AND business_category IS NOT NULL`)
      .all(...urls).forEach(r => alreadyProcessed.add(r.url));

    db.prepare(`SELECT url FROM news WHERE url IN (${placeholders}) AND is_important = 1`)
      .all(...urls).forEach(r => alreadySentToWeCom.add(r.url));
  }

  console.log(`  Candidates: ${aiCandidates.length} | Already processed: ${alreadyProcessed.size} | Already sent to WeCom: ${alreadySentToWeCom.size}`);

  const processedNews = [];
  let aiCallCount = 0;

  for (const item of allNews) {
    // 白名单来源 + 未曾 AI 处理 + 未超出每轮上限 → 走 AI
    if (AI_SOURCES.has(item.source) && !alreadyProcessed.has(item.url) && aiCallCount < MAX_AI_PER_RUN) {
      console.log(`  [AI] ${item.source}: ${item.title.substring(0, 50)}...`);
      if (aiCallCount > 0) await new Promise(r => setTimeout(r, 4000)); // 4s 节流，避免 429
      const aiResult = await processWithAI(item.title, item.content);
      aiCallCount++;
      if (aiResult) {
        Object.assign(item, aiResult);
        // 企微推送：AI 判定重要 + 未推过 + 内容为当天或前一天（防止旧公告刷屏）
        const isRecent = (Date.now() - item.timestamp) <= 48 * 60 * 60 * 1000;
        if (item.is_important === 1 && !alreadySentToWeCom.has(item.url) && isRecent) {
          await sendToWeCom(item);
        } else if (item.is_important === 1 && !isRecent) {
          console.log(`  [WeCom Skip] Too old: ${item.title.substring(0, 40)}`);
        }
      }
    }
    processedNews.push(item);
  }
  console.log(`  AI processed ${aiCallCount} items (skipped ${alreadyProcessed.size} already done).`);

  await saveNews(processedNews);
  console.log(`--- Finished All. Saved ${processedNews.length} items. ---`);
  return processedNews;
}

module.exports = { runAllScrapers };
