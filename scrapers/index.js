'use strict';
/**
 * scrapers/index.js — 全局爬虫调度器
 *
 * 职责：
 *   1. 按批次并发运行所有爬虫
 *   2. 统一过滤 + 去重
 *   3. AI 分类（增量，未处理过的才调用）
 *   4. 重要性判定 + 企业微信推送
 *   5. 存入数据库
 *
 * 改进点（对比原 scraper.js）：
 *   - 浏览器池复用，整个批次只启动一个 Chrome 进程
 *   - 配置全部来自 config.js，无散落魔数
 *   - Date.now() fallback 统一在 utils.parseTimestamp() 处理
 *   - checkImportance() 独立模块
 */

const {
  saveNews,
  db,
  getAlreadyProcessed,
  updateSentStatus,
  normalizeKey,
  canPushMessage,
  updateSourcePush,
} = require('../db');
const { processWithAI }    = require('../ai');
const { sendToWeCom }      = require('../wecom');
const { filterNewsItems, getSourceConfig } = require('../filter');
const { closeBrowser }     = require('./browser');

const {
  SCRAPER,
  AI_SOURCES,
  WECOM_BLOCK_SOURCES,
  HK_SOURCES,
  PR_HK_COMPANIES,
  PR_TOP_EXCHANGES,
  MAINSTREAM_EXCHANGES,
  EXCHANGE_EXCLUDE_KEYWORDS,
  EXCHANGE_MAJOR_KEYWORDS,
  HK_KEYWORDS,
} = require('../config');

// ── 爬虫函数注册表 ─────────────────────────────────────────────────────────────
const {
  scrapeOKX, scrapeBinance, scrapeHashKeyExchange,
  scrapeTechubNews, scrapeMatrixport, scrapeHashKeyGroup,
  scrapePRNewswire, scrapeTechFlow, scrapeKuCoin, scrapeExio, scrapeHtx,
} = require('./sources/apis');

const {
  scrapeBlockBeats, scrapeOSL, scrapeWuBlock,
  scrapeBybit, scrapeBitget, scrapeMexc, scrapeGate,
  scrapePolymarketBreaking, scrapePolymarketChina,
  scrapeTwitterKOLs,
} = require('./sources/puppeteer');

const ALL_SCRAPERS = [
  scrapeTechFlow, scrapePRNewswire, scrapeBlockBeats, scrapeTwitterKOLs,
  scrapeOSL, scrapeTechubNews, scrapeOKX, scrapeExio, scrapeMatrixport,
  scrapeWuBlock, scrapeHashKeyGroup, scrapeKuCoin, scrapeHashKeyExchange,
  scrapeBinance, scrapeBybit, scrapeBitget, scrapeMexc,
  scrapePolymarketBreaking, scrapePolymarketChina, scrapeGate, scrapeHtx,
];

// ── 重要性判定（原 checkImportance，现从 config 读配置）─────────────────────────
function checkImportance(item) {
  const titleLower = (item.title || '').toLowerCase();
  const titleUpper = (item.title || '').toUpperCase();
  const source     = item.source || '';

  if (WECOM_BLOCK_SOURCES.has(source)) return 0;
  if (HK_SOURCES.has(source)) return 1;

  if (source === 'PRNewswire') {
    const isHK  = PR_HK_COMPANIES.some(c => titleLower.includes(c));
    const isTop = PR_TOP_EXCHANGES.some(e => titleLower.includes(e));
    return (isHK || isTop) ? 1 : 0;
  }

  if (MAINSTREAM_EXCHANGES.has(source)) {
    if (EXCHANGE_EXCLUDE_KEYWORDS.some(kw => titleLower.includes(kw))) return 0;
    if (EXCHANGE_MAJOR_KEYWORDS.some(kw => titleUpper.includes(kw))) return 1;
    if ((item.title.includes('维护') || item.title.includes('升级')) &&
        (item.title.includes('全站') || item.title.includes('系统') || !item.title.includes('-'))) return 1;
    return 0;
  }

  if (item.category === 'HK' || HK_KEYWORDS.some(k => item.title.includes(k))) return 1;

  return item.is_important || 0;
}

// ── 主调度器 ──────────────────────────────────────────────────────────────────
async function runAllScrapers() {
  console.log('=== [Scrape] Start ===');
  const startMs = Date.now();

  // 1. 分批并发执行所有爬虫
  let rawResults = [];
  for (let i = 0; i < ALL_SCRAPERS.length; i += SCRAPER.BATCH_SIZE) {
    const batch   = ALL_SCRAPERS.slice(i, i + SCRAPER.BATCH_SIZE);
    const batchNo = Math.floor(i / SCRAPER.BATCH_SIZE) + 1;
    const total   = Math.ceil(ALL_SCRAPERS.length / SCRAPER.BATCH_SIZE);
    console.log(`[Scrape] Batch ${batchNo}/${total}`);

    const results = await Promise.allSettled(batch.map(fn => fn()));
    results.forEach((r, idx) => {
      if (r.status === 'fulfilled') rawResults.push(...(r.value || []));
      else console.error(`[Scrape] Scraper #${i + idx} error:`, r.reason?.message);
    });

    if (i + SCRAPER.BATCH_SIZE < ALL_SCRAPERS.length) {
      await new Promise(r => setTimeout(r, SCRAPER.BATCH_DELAY_MS));
    }
  }

  // 关闭共享浏览器
  await closeBrowser();

  // 2. 过滤 + 内存去重
  const allNews = filterNewsItems(rawResults);
  console.log(`[Scrape] After filter: ${rawResults.length} → ${allNews.length}`);

  // 3. 批量查询 DB 状态
  const { processed: alreadyProcessed, sentToWeCom: alreadySent, existingTimestamps } =
    await getAlreadyProcessed(allNews);

  // 4. 逐条处理：时间戳修正 → AI → 重要性 → 推送
  const processedNews = [];
  let   aiCallCount   = 0;
  const sentThisRun   = new Set();
  const pushLock      = new Set();

  for (const item of allNews) {
    const nTitle   = normalizeKey(item.title, '').split('|')[0];
    const cacheKey = `${nTitle}|${(item.source || '').toLowerCase()}`;

    const isAlreadySent      = alreadySent.has(item.url) || alreadySent.has(cacheKey) || alreadySent.has(nTitle);
    const isAlreadyProcessed = alreadyProcessed.has(item.url) || alreadyProcessed.has(cacheKey) || alreadyProcessed.has(nTitle);
    const dbTs               = existingTimestamps.get(item.url) || existingTimestamps.get(cacheKey);

    // 如果已在数据库中标记为已发送，直接跳过（不浪费时间戳检查）
    if (isAlreadySent) {
      item.sent_to_wecom = 1;
      processedNews.push(item);
      continue;
    }

    // 稳定时间戳：保留首次入库时间；真正没有时间戳的用 Date.now()（有 log 标记）
    if (dbTs) {
      item.timestamp = dbTs;
    } else if (!item.timestamp) {
      console.warn(`[Scrape] No timestamp, using now: ${item.title?.substring(0, 50)}`);
      item.timestamp = Date.now();
    }

    // 时间戳新鲜度检查：只推送最近 24 小时内的消息（防止旧稿混入）
    const FRESHNESS_THRESHOLD = 24 * 60 * 60 * 1000; // 24 小时（毫秒）
    const messageAge = Date.now() - item.timestamp;
    if (messageAge > FRESHNESS_THRESHOLD) {
      const hoursOld = Math.floor(messageAge / (60 * 60 * 1000));
      console.log(`[SKIP] 消息过旧 (${hoursOld}小时前): ${item.title?.substring(0, 50)}`);
      item.sent_to_wecom = 1;  // 标记为已处理，避免下次还检查
      processedNews.push(item);
      continue;
    }

    // 重要性预判
    item.is_important = checkImportance(item);

    // AI 分类（仅对未处理 + 指定来源 + 配额内）
    if (AI_SOURCES.has(item.source) && !isAlreadyProcessed && aiCallCount < SCRAPER.MAX_AI_PER_RUN) {
      const isListing = /Listing|上线|上架|New Pair/i.test(item.title);
      if (!isListing || item.source.includes('HashKey') || item.source.includes('OSL')) {
        if (aiCallCount > 0) await new Promise(r => setTimeout(r, SCRAPER.AI_DELAY_MS));
        try {
          const aiResult = await processWithAI(item.title, item.content);
          aiCallCount++;
          if (aiResult) {
            Object.assign(item, aiResult);
            item.is_important = (aiResult.is_important === 1 || checkImportance(item) === 1) ? 1 : 0;
          }
        } catch (err) {
          console.error('[AI]', err.message);
        }
      }
    }

    // 企微封锁（覆盖 AI 可能改写的 is_important）
    if (WECOM_BLOCK_SOURCES.has(item.source)) item.is_important = 0;

    // 推送逻辑
    if (item.is_important === 1 && !isAlreadySent) {
      // 获取源配置
      const sourceConfig = getSourceConfig(item.source);
      
      // 检查源级别冷却时间
      if (!canPushMessage(item.source, item.title, item.timestamp, sourceConfig.pushCooldownHours)) {
        console.log(`[SKIP COOLDOWN] ${item.source}: 冷却期内 (${sourceConfig.pushCooldownHours}h): ${item.title.substring(0, 40)}`);
        item.sent_to_wecom = 1;
        await saveNews([item]).catch(e => console.warn('[Save skip cooldown]', e.message));
        processedNews.push(item);
        continue;
      }

      if (sentThisRun.has(nTitle) || pushLock.has(nTitle)) {
        item.sent_to_wecom = 1;
        await saveNews([item]).catch(e => console.warn('[Save sent this run]', e.message));
        processedNews.push(item);
        continue;
      }
      pushLock.add(nTitle);

      // 二次 DB 校验（防并发重复）
      let dbCheck = null;
      try {
        dbCheck = db.prepare(
          'SELECT sent_to_wecom FROM news WHERE (url = ? OR normalized_title = ?) AND sent_to_wecom = 1'
        ).get(item.url, nTitle);
      } catch (_) { /* ignore */ }

      if (dbCheck) {
        item.sent_to_wecom = 1;
        await saveNews([item]).catch(e => console.warn('[Save dbCheck]', e.message));
        processedNews.push(item);
        pushLock.delete(nTitle);
        continue;
      }

      try {
        item.sent_to_wecom = 1;
        sentThisRun.add(nTitle);

        // 先保存到数据库以锁定状态（如果是新纪录则插入，旧纪录则更新）
        // 这样即使 sendToWeCom 失败或耗时较长，并发的下一次运行也不会重复推送
        await saveNews([item]);

        // 实际发送消息
        await sendToWeCom(item);
        
        // 更新源追踪信息
        updateSourcePush(item.source, item.timestamp, item.title);
        
        updateSentStatus(item).catch(e => console.warn('[Supabase update]', e.message));
      } catch (err) {
        console.error('[Push error]', item.source, err.message);
        // 发送失败建议仍保留已发送标记，防止短时间重复重试
        item.sent_to_wecom = 1;
      } finally {
        pushLock.delete(nTitle);
      }
    } else if (item.is_important === 1 && isAlreadySent) {
      item.sent_to_wecom = 1;
    }

    processedNews.push(item);
  }

  await saveNews(processedNews);
  const elapsed = ((Date.now() - startMs) / 1000).toFixed(1);
  console.log(`=== [Scrape] Done. Saved ${processedNews.length} items in ${elapsed}s ===`);
  return processedNews;
}

module.exports = { runAllScrapers, checkImportance };
