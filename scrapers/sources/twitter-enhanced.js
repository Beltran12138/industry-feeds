'use strict';
/**
 * twitter-enhanced.js — Twitter KOL 多源冗余抓取
 *
 * 实现三级抓取策略：
 * L1: Nitter 实例（免费，不稳定）
 * L2: RSSHub 镜像（免费，需维护）
 * L3: 第三方 API 服务（付费，稳定）
 * L4: 本地缓存（兜底）
 */

const axios = require('axios');
const cheerio = require('cheerio');
const { KOL_LIST, RSS_BASE_URLS } = require('../../config');

// ── 配置 ─────────────────────────────────────────────────────────────────────
const TWITTER_CONFIG = {
  // Nitter 实例列表（按优先级排序）
  NITTER_INSTANCES: [
    'https://nitter.net',
    'https://nitter.it',
    'https://nitter.cz',
    'https://nitter.privacydev.net',
    'https://nitter.poast.org',
  ],

  // RSSHub 镜像
  RSSHUB_INSTANCES: [
    'https://rsshub.rssforever.com',
    'https://hub.slarker.me',
    'https://rsshub.liumingye.cn',
    'https://rsshub.pseudoyu.com',
    'https://rsshub-instance.zeabur.app',
    'https://rsshub.app',
  ],

  // 第三方 API 服务（备用）
  THIRD_PARTY_APIS: {
    twitterapi: {
      enabled: !!process.env.TWITTERAPI_KEY,
      url: 'https://api.twitterapi.io/twitter/user/last_tweets',
      key: process.env.TWITTERAPI_KEY,
    },
    scrapfly: {
      enabled: !!process.env.SCRAPFLY_KEY,
      url: 'https://api.scrapfly.io/scrape',
      key: process.env.SCRAPFLY_KEY,
    },
  },

  // 请求配置
  REQUEST_TIMEOUT: 15000,
  MAX_RETRIES: 2,
  RETRY_DELAY: 2000,

  // 缓存配置
  CACHE_MAX_AGE: 30 * 60 * 1000, // 30分钟
};

// ── 本地缓存 ─────────────────────────────────────────────────────────────────
class TwitterCache {
  constructor() {
    this.cache = new Map();
    this.lastFetch = new Map();
  }

  get(key) {
    const item = this.cache.get(key);
    if (!item) return null;

    const age = Date.now() - item.timestamp;
    if (age > TWITTER_CONFIG.CACHE_MAX_AGE) {
      this.cache.delete(key);
      return null;
    }

    return item.data;
  }

  set(key, data) {
    this.cache.set(key, {
      data,
      timestamp: Date.now(),
    });
    this.lastFetch.set(key, Date.now());
  }

  getLastFetch(key) {
    return this.lastFetch.get(key) || 0;
  }

  // 获取缓存统计
  getStats() {
    return {
      size: this.cache.size,
      keys: Array.from(this.cache.keys()),
    };
  }
}

const cache = new TwitterCache();

// ── 工具函数 ─────────────────────────────────────────────────────────────────
function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function parseTwitterDate(dateStr) {
  if (!dateStr) return Date.now();

  // 处理各种日期格式
  const formats = [
    // "Mar 13, 2026 · 10:30 AM UTC"
    /(\w{3})\s+(\d{1,2}),\s+(\d{4})/,
    // ISO 格式
    /^\d{4}-\d{2}-\d{2}/,
  ];

  for (const format of formats) {
    if (format.test(dateStr)) {
      const parsed = new Date(dateStr);
      if (!isNaN(parsed.getTime())) {
        return parsed.getTime();
      }
    }
  }

  return Date.now();
}

function normalizeTweetId(id) {
  // 提取推文 ID
  if (!id) return null;
  const match = id.match(/(\d+)/);
  return match ? match[1] : id;
}

// ── 抓取器基类 ───────────────────────────────────────────────────────────────
class TwitterScraper {
  constructor(name) {
    this.name = name;
    this.successCount = 0;
    this.failCount = 0;
  }

  async scrape(username) {
    throw new Error('Subclasses must implement scrape()');
  }

  getStats() {
    return {
      name: this.name,
      success: this.successCount,
      fail: this.failCount,
      rate: this.successCount + this.failCount > 0
        ? (this.successCount / (this.successCount + this.failCount) * 100).toFixed(1)
        : 0,
    };
  }
}

// ── Nitter 抓取器 ────────────────────────────────────────────────────────────
class NitterScraper extends TwitterScraper {
  constructor() {
    super('Nitter');
    this.instanceIndex = 0;
  }

  getCurrentInstance() {
    return TWITTER_CONFIG.NITTER_INSTANCES[this.instanceIndex];
  }

  rotateInstance() {
    this.instanceIndex = (this.instanceIndex + 1) % TWITTER_CONFIG.NITTER_INSTANCES.length;
    console.log(`[Twitter] Rotated to Nitter instance: ${this.getCurrentInstance()}`);
  }

  async scrape(username) {
    const cacheKey = `nitter_${username}`;
    const cached = cache.get(cacheKey);
    if (cached) {
      console.log(`[Twitter] Using cached data for ${username}`);
      return cached;
    }

    for (let attempt = 0; attempt < TWITTER_CONFIG.NITTER_INSTANCES.length; attempt++) {
      const instance = this.getCurrentInstance();
      const url = `${instance}/${username}`;

      try {
        console.log(`[Twitter] Fetching ${username} from ${instance}`);

        const res = await axios.get(url, {
          timeout: TWITTER_CONFIG.REQUEST_TIMEOUT,
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.0',
          },
        });

        const $ = cheerio.load(res.data);
        const tweets = [];

        $('.timeline-item').each((_, elem) => {
          const $item = $(elem);

          // 跳过广告/推荐
          if ($item.hasClass('show-more')) return;

          const content = $item.find('.tweet-content').text().trim();
          if (!content || content.includes('Promoted')) return;

          const link = $item.find('.tweet-link').attr('href');
          const id = normalizeTweetId(link);

          const dateText = $item.find('.tweet-date a').attr('title');
          const timestamp = parseTwitterDate(dateText);

          const stats = {
            replies: $item.find('.icon-comment').parent().text().trim() || '0',
            retweets: $item.find('.icon-retweet').parent().text().trim() || '0',
            likes: $item.find('.icon-heart').parent().text().trim() || '0',
          };

          tweets.push({
            id,
            content,
            timestamp,
            url: link ? `https://twitter.com${link}` : `https://twitter.com/${username}/status/${id}`,
            stats,
            source: 'Twitter',
            author: username,
          });
        });

        if (tweets.length > 0) {
          this.successCount++;
          cache.set(cacheKey, tweets);
          return tweets;
        }

        throw new Error('No tweets found');

      } catch (err) {
        console.warn(`[Twitter] Nitter ${instance} failed:`, err.message);
        this.rotateInstance();

        if (attempt < TWITTER_CONFIG.NITTER_INSTANCES.length - 1) {
          await delay(TWITTER_CONFIG.RETRY_DELAY);
        }
      }
    }

    this.failCount++;
    return null;
  }
}

// ── RSSHub 抓取器 ────────────────────────────────────────────────────────────
class RSSHubScraper extends TwitterScraper {
  constructor() {
    super('RSSHub');
    this.instanceIndex = 0;
  }

  getCurrentInstance() {
    return TWITTER_CONFIG.RSSHUB_INSTANCES[this.instanceIndex];
  }

  rotateInstance() {
    this.instanceIndex = (this.instanceIndex + 1) % TWITTER_CONFIG.RSSHUB_INSTANCES.length;
  }

  async scrape(username) {
    const cacheKey = `rsshub_${username}`;
    const cached = cache.get(cacheKey);
    if (cached) return cached;

    for (let attempt = 0; attempt < TWITTER_CONFIG.RSSHUB_INSTANCES.length; attempt++) {
      const instance = this.getCurrentInstance();
      const url = `${instance}/twitter/user/${username}`;

      try {
        console.log(`[Twitter] Fetching ${username} from RSSHub ${instance}`);

        const res = await axios.get(url, {
          timeout: TWITTER_CONFIG.REQUEST_TIMEOUT,
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.0',
          },
        });

        const $ = cheerio.load(res.data, { xmlMode: true });
        const tweets = [];

        $('item').each((_, elem) => {
          const $item = $(elem);

          const title = $item.find('title').text().trim();
          const content = $item.find('description').text().trim();
          const link = $item.find('link').text().trim();
          const pubDate = $item.find('pubDate').text().trim();

          // 提取 ID
          const id = normalizeTweetId(link);

          tweets.push({
            id,
            content: title || content,
            timestamp: new Date(pubDate).getTime() || Date.now(),
            url: link,
            source: 'Twitter',
            author: username,
          });
        });

        if (tweets.length > 0) {
          this.successCount++;
          cache.set(cacheKey, tweets);
          return tweets;
        }

        throw new Error('No tweets found in RSS');

      } catch (err) {
        console.warn(`[Twitter] RSSHub ${instance} failed:`, err.message);
        this.rotateInstance();

        if (attempt < TWITTER_CONFIG.RSSHUB_INSTANCES.length - 1) {
          await delay(TWITTER_CONFIG.RETRY_DELAY);
        }
      }
    }

    this.failCount++;
    return null;
  }
}

// ── 第三方 API 抓取器 ────────────────────────────────────────────────────────
class ThirdPartyScraper extends TwitterScraper {
  constructor() {
    super('ThirdPartyAPI');
  }

  async scrape(username) {
    const cacheKey = `api_${username}`;
    const cached = cache.get(cacheKey);
    if (cached) return cached;

    // 尝试 twitterapi.io
    const apiConfig = TWITTER_CONFIG.THIRD_PARTY_APIS.twitterapi;
    if (apiConfig.enabled) {
      try {
        console.log(`[Twitter] Fetching ${username} from TwitterAPI.io`);

        const res = await axios.get(apiConfig.url, {
          params: { username },
          headers: {
            'X-API-Key': apiConfig.key,
          },
          timeout: TWITTER_CONFIG.REQUEST_TIMEOUT,
        });

        if (res.data?.tweets) {
          const tweets = res.data.tweets.map(t => ({
            id: t.id,
            content: t.text,
            timestamp: new Date(t.created_at).getTime(),
            url: `https://twitter.com/${username}/status/${t.id}`,
            stats: {
              replies: t.reply_count,
              retweets: t.retweet_count,
              likes: t.like_count,
            },
            source: 'Twitter',
            author: username,
          }));

          this.successCount++;
          cache.set(cacheKey, tweets);
          return tweets;
        }
      } catch (err) {
        console.warn(`[Twitter] TwitterAPI.io failed:`, err.message);
      }
    }

    // 尝试 Scrapfly
    const scrapflyConfig = TWITTER_CONFIG.THIRD_PARTY_APIS.scrapfly;
    if (scrapflyConfig.enabled) {
      try {
        console.log(`[Twitter] Fetching ${username} from Scrapfly`);

        const targetUrl = `https://twitter.com/${username}`;
        const res = await axios.get(scrapflyConfig.url, {
          params: {
            key: scrapflyConfig.key,
            url: targetUrl,
            render_js: true,
          },
          timeout: 30000, // Scrapfly 需要更长时间
        });

        // 解析 Scrapfly 返回的 HTML
        const $ = cheerio.load(res.data.result?.content || res.data);
        const tweets = [];

        // 这里需要根据实际返回的 HTML 结构调整选择器
        // 这是一个简化的示例
        $('[data-testid="tweet"]').each((_, elem) => {
          const $item = $(elem);
          const content = $item.find('[data-testid="tweetText"]').text().trim();
          if (content) {
            tweets.push({
              id: null,
              content,
              timestamp: Date.now(),
              url: targetUrl,
              source: 'Twitter',
              author: username,
            });
          }
        });

        if (tweets.length > 0) {
          this.successCount++;
          cache.set(cacheKey, tweets);
          return tweets;
        }
      } catch (err) {
        console.warn(`[Twitter] Scrapfly failed:`, err.message);
      }
    }

    this.failCount++;
    return null;
  }
}

// ── 主抓取器（带降级策略）────────────────────────────────────────────────────
class TwitterScraperManager {
  constructor() {
    this.scrapers = [
      new NitterScraper(),
      new RSSHubScraper(),
      new ThirdPartyScraper(),
    ];
    this.currentIndex = 0;
  }

  async scrape(username, options = {}) {
    const cacheKey = `combined_${username}`;

    // 检查缓存
    if (!options.forceRefresh) {
      const cached = cache.get(cacheKey);
      if (cached) {
        console.log(`[Twitter] Using combined cache for ${username}`);
        return cached;
      }
    }

    const errors = [];

    // 依次尝试所有抓取器
    for (let i = 0; i < this.scrapers.length; i++) {
      const scraper = this.scrapers[(this.currentIndex + i) % this.scrapers.length];

      try {
        const tweets = await scraper.scrape(username);

        if (tweets && tweets.length > 0) {
          console.log(`[Twitter] Successfully scraped ${tweets.length} tweets for ${username} using ${scraper.name}`);

          // 缓存结果
          cache.set(cacheKey, tweets);

          // 轮换起始位置（负载均衡）
          this.currentIndex = (this.currentIndex + 1) % this.scrapers.length;

          return tweets;
        }
      } catch (err) {
        console.warn(`[Twitter] ${scraper.name} error for ${username}:`, err.message);
        errors.push(`${scraper.name}: ${err.message}`);
      }

      // 短暂延迟后尝试下一个
      if (i < this.scrapers.length - 1) {
        await delay(1000);
      }
    }

    console.error(`[Twitter] All scrapers failed for ${username}:`, errors);
    return null;
  }

  async scrapeAll(kolList = KOL_LIST, options = {}) {
    const results = {};
    const errors = [];

    for (const kol of kolList) {
      try {
        const tweets = await this.scrape(kol.username, options);
        results[kol.name] = {
          username: kol.username,
          tweets: tweets || [],
          success: !!tweets,
        };

        if (!tweets) {
          errors.push(kol.name);
        }
      } catch (err) {
        console.error(`[Twitter] Failed to scrape ${kol.name}:`, err.message);
        results[kol.name] = {
          username: kol.username,
          tweets: [],
          success: false,
          error: err.message,
        };
        errors.push(kol.name);
      }

      // 间隔请求，避免触发限流
      await delay(2000);
    }

    console.log(`[Twitter] Scraped ${Object.values(results).filter(r => r.success).length}/${kolList.length} KOLs`);

    if (errors.length > 0) {
      console.warn(`[Twitter] Failed to scrape: ${errors.join(', ')}`);
    }

    return results;
  }

  getStats() {
    return {
      scrapers: this.scrapers.map(s => s.getStats()),
      cache: cache.getStats(),
    };
  }

  clearCache() {
    cache.cache.clear();
    cache.lastFetch.clear();
    console.log('[Twitter] Cache cleared');
  }
}

// ── 导出 ─────────────────────────────────────────────────────────────────────
const scraperManager = new TwitterScraperManager();

module.exports = {
  TwitterScraperManager,
  NitterScraper,
  RSSHubScraper,
  ThirdPartyScraper,
  TwitterCache,
  scraperManager,
  scrapeKOLs: (list, opts) => scraperManager.scrapeAll(list, opts),
  getStats: () => scraperManager.getStats(),
  clearCache: () => scraperManager.clearCache(),
};
