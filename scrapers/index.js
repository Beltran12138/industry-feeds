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
  checkIfSent,
} = require('../db');
const { processWithAI }    = require('../ai');
const { sendToWeCom }      = require('../wecom');
const { filterNewsItems, getSourceConfig } = require('../filter');
const { closeBrowser }     = require('./browser');
const { delayWithJitter }  = require('./middleware');

// ── Monitoring integration ──────────────────────────────────────────────────
let alertManager = null;
try {
  alertManager = require('../monitoring/alert-manager').alertManager;
} catch (_) {}

// ── Memory system: load recent insights for AI context ──────────────────────
let insightDAO = null;
try {
  insightDAO = require('../dao').insightDAO;
} catch (_) {}

// ── Data quality integration ────────────────────────────────────────────────
let qualityChecker = null;
try {
  qualityChecker = require('../quality').qualityChecker;
} catch (_) {}

const {
  SCRAPER,
  AI_SOURCES,
  WECOM_BLOCK_SOURCES,
  HK_SOURCES,
  PR_HK_COMPANIES,
  PR_TOP_EXCHANGES,
  EXCHANGE_EXCLUDE_KEYWORDS,
  EXCHANGE_MAJOR_KEYWORDS,
  HK_KEYWORDS,
  HIGH_FREQ_SOURCES,
  LOW_FREQ_SOURCES,
  MAINSTREAM_EXCHANGES,
  SOURCE_CONFIGS,
  CRITICAL_SCORE_THRESHOLD,
} = require('../config');

const { monitor }       = require('../monitoring/monitor');

// ── 爬虫函数注册表 ─────────────────────────────────────────────────────────────
const {
  scrapeOKX, scrapeBinance, scrapeHashKeyExchange,
  scrapeTechubNews, scrapeMatrixport, scrapeHashKeyGroup,
  scrapePRNewswire, scrapeTechFlow, scrapeKuCoin, scrapeExio, scrapeHtx,
  scrapeSFC,
} = require('./sources/apis');

const {
  scrapeBlockBeats, scrapeOSL, scrapeWuBlock,
  scrapeBybit, scrapeBitget, scrapeMexc, scrapeGate,
  scrapePolymarketBreaking, scrapePolymarketChina,
  scrapeTwitterKOLs,
} = require('./sources/puppeteer');

const SCRAPERS_MAP = {
  SFC: scrapeSFC, TechFlow: scrapeTechFlow, PRNewswire: scrapePRNewswire, BlockBeats: scrapeBlockBeats,
  TwitterKOLs: scrapeTwitterKOLs, OSL: scrapeOSL, TechubNews: scrapeTechubNews, OKX: scrapeOKX,
  Exio: scrapeExio, Matrixport: scrapeMatrixport, WuBlock: scrapeWuBlock, HashKeyGroup: scrapeHashKeyGroup,
  KuCoin: scrapeKuCoin, HashKeyExchange: scrapeHashKeyExchange, Binance: scrapeBinance, Bybit: scrapeBybit,
  Bitget: scrapeBitget, Mexc: scrapeMexc, PolymarketBreaking: scrapePolymarketBreaking,
  PolymarketChina: scrapePolymarketChina, Gate: scrapeGate, Htx: scrapeHtx
};

// 检查源是否被禁用
function isSourceDisabled(sourceName) {
  const config = SOURCE_CONFIGS[sourceName];
  return config && config.disabled === true;
}

// 获取启用的爬虫列表
function getEnabledScrapers(scrapersMap) {
  const enabled = {};
  for (const [name, fn] of Object.entries(scrapersMap)) {
    if (!isSourceDisabled(name)) {
      enabled[name] = fn;
    } else {
      console.log(`[Scrape] Source "${name}" is disabled, skipping...`);
    }
  }
  return enabled;
}

const ALL_SCRAPERS = Object.values(SCRAPERS_MAP);

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

// ── 规则预筛（AI 前置过滤器，减少约 40-60% 的无效 API 调用）─────────────
/**
 * 基于规则判断条目是否可跳过 AI 分类（低价值噪音）
 * 返回 true 表示跳过 AI，false 表示需要 AI 处理
 * 
 * 优化流程：抓取 → 规则预筛(去掉噪音) → AI分类(精选) → 推送
 */
function ruleBasedPreFilter(item) {
  const title = (item.title || '').toLowerCase();
  const source = item.source || '';

  // 1. 常规上币/交易对公告 — 低价值，跳过 AI
  if (/(?:listing|will list|上线|上架|new pair|新增交易|下架|delisting)/i.test(item.title)) {
    // 但 HK 合规所的上币公告仍需 AI 分析
    if (!source.includes('HashKey') && !source.includes('OSL') && !source.includes('Exio')) {
      item.business_category = item.business_category || '交易/量化';
      item.alpha_score = item.alpha_score || 25;
      return true;
    }
  }

  // 2. 资金费率/永续合约类 — 纯量化数据
  if (/(?:资金费率|永续合约资金|funding rate)/i.test(title)) {
    item.business_category = item.business_category || '交易/量化';
    item.alpha_score = item.alpha_score || 15;
    return true;
  }

  // 3. 爆仓/清算/鲸鱼类 — 市场噪声
  if (/(?:爆仓|清算|鲸鱼|whale|liquidat)/i.test(title)) {
    item.business_category = item.business_category || '交易/量化';
    item.alpha_score = item.alpha_score || 20;
    return true;
  }

  // 4. Meme/空投/Launchpool 类 — 营销噪声
  if (/(?:meme|空投|airdrop|launchpool|launchpad)/i.test(title)) {
    item.business_category = item.business_category || '拉新/社媒/社群/pr';
    item.alpha_score = item.alpha_score || 20;
    return true;
  }

  // 5. 极短标题（< 10 字且非 HK 源）— 可能是碎片或无意义的 hashtag
  if (item.title && item.title.length < 10 && !HK_SOURCES.has(source)) {
    return true;
  }

  return false;
}

// ── 主调度器 ──────────────────────────────────────────────────────────────────
async function runAllScrapers(tier = 'all') {
  console.log(`=== [Scrape] Start (Tier: ${tier}) ===`);
  const startMs = Date.now();

  // 过滤禁用的源
  const enabledScrapersMap = getEnabledScrapers(SCRAPERS_MAP);

  // Build source name mapping for monitoring
  const scraperSourceMap = new Map();
  for (const [name, fn] of Object.entries(enabledScrapersMap)) {
    scraperSourceMap.set(fn, name);
  }

  let targetScrapers = [];
  if (tier === 'high') {
    targetScrapers = HIGH_FREQ_SOURCES.map(key => enabledScrapersMap[key]).filter(Boolean);
  } else if (tier === 'low') {
    targetScrapers = LOW_FREQ_SOURCES.map(key => enabledScrapersMap[key]).filter(Boolean);
  } else {
    targetScrapers = Object.values(enabledScrapersMap);
  }

  // 1. 分批并发执行目标爬虫
  let rawResults = [];
  for (let i = 0; i < targetScrapers.length; i += SCRAPER.BATCH_SIZE) {
    const batch   = targetScrapers.slice(i, i + SCRAPER.BATCH_SIZE);
    const batchNo = Math.floor(i / SCRAPER.BATCH_SIZE) + 1;
    const total   = Math.ceil(targetScrapers.length / SCRAPER.BATCH_SIZE);
    console.log(`[Scrape] Batch ${batchNo}/${total}`);

    const results = await Promise.allSettled(batch.map(fn => fn()));
    results.forEach((r, idx) => {
      const sourceName = scraperSourceMap.get(batch[idx]) || `scraper#${i + idx}`;
      if (r.status === 'fulfilled') {
        const items = r.value || [];
        rawResults.push(...items);
        // Record scraper success in monitoring
        if (alertManager) alertManager.recordScraperResult(sourceName, true, items.length);
        if (alertManager) alertManager.updateSourceHealth(sourceName, items.length);
      } else {
        console.error(`[Scrape] ${sourceName} error:`, r.reason?.message);
        // Record scraper failure in monitoring
        if (alertManager) alertManager.recordScraperResult(sourceName, false, 0, r.reason?.message);
      }
    });

    if (i + SCRAPER.BATCH_SIZE < targetScrapers.length) {
      await delayWithJitter(SCRAPER.BATCH_DELAY_MS, 500);
    }
  }

  // 关闭共享浏览器
  await closeBrowser();

  // 2. 过滤 + 内存去重
  const allNews = filterNewsItems(rawResults);
  console.log(`[Scrape] After filter: ${rawResults.length} → ${allNews.length}`);

  // 2.5 Data quality check (non-blocking, informational)
  if (qualityChecker && allNews.length > 0) {
    const qReport = qualityChecker.validateBatch(allNews);
    console.log(`[Quality] Batch: ${qReport.summary.total} items, pass rate: ${qReport.summary.passRate}, avg score: ${qReport.summary.avgScore}`);
    if (qReport.summary.failed > 0) {
      console.warn(`[Quality] ${qReport.summary.failed} items failed quality check`);
      if (alertManager) {
        alertManager.log('warn', 'quality', `${qReport.summary.failed}/${qReport.summary.total} items failed quality check`);
      }
    }
  }

  // 3. 批量查询 DB 状态
  const { processed: alreadyProcessed, sentToWeCom: alreadySent, existingTimestamps } =
    await getAlreadyProcessed(allNews);

  // 3.5 加载最近的行业记忆，供 AI 分析引用
  let recentInsights = [];
  try {
    if (insightDAO) {
      recentInsights = await insightDAO.getRecent(5);
    }
  } catch (e) {
    console.warn('[Scrape] Failed to load insights:', e.message);
  }

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

    // 时间戳新鲜度检查：根据源配置动态判断（尊重 config.js 中的 maxAgeHours）
    const sourceConfig = getSourceConfig(item.source);
    const maxAgeMs = sourceConfig.maxAgeHours * 60 * 60 * 1000;
    const messageAge = Date.now() - item.timestamp;
    if (messageAge > maxAgeMs) {
      const hoursOld = Math.floor(messageAge / (60 * 60 * 1000));
      console.log(`[SKIP] ${item.source}: 消息过旧 (${hoursOld}h > ${sourceConfig.maxAgeHours}h): ${item.title?.substring(0, 50)}`);
      item.sent_to_wecom = 1;  // 标记为已处理，避免下次还检查
      processedNews.push(item);
      continue;
    }

    // 重要性预判
    item.is_important = checkImportance(item);

    // 规则预筛：跳过明显低价值条目，不浪费 AI 配额
    const shouldSkipAI = ruleBasedPreFilter(item);

    // AI 分类（仅对未处理 + 指定来源 + 配额内 + 通过预筛）
    if (AI_SOURCES.has(item.source) && !isAlreadyProcessed && aiCallCount < SCRAPER.MAX_AI_PER_RUN && !shouldSkipAI) {
      const isListing = /Listing|上线|上架|New Pair/i.test(item.title);
      if (!isListing || item.source.includes('HashKey') || item.source.includes('OSL')) {
        if (aiCallCount > 0) await new Promise(r => setTimeout(r, SCRAPER.AI_DELAY_MS));
        try {
          const aiResult = await processWithAI(item.title, item.content, item.source, recentInsights);
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
      
      // 紧急通道：alpha_score >= CRITICAL_SCORE_THRESHOLD 时跳过冷却期，即时推送
      const isCritical = (item.alpha_score || 0) >= CRITICAL_SCORE_THRESHOLD;
      
      // 检查源级别冷却时间（紧急消息跳过冷却检查）
      if (!isCritical && !(await canPushMessage(item.source, item.title, item.timestamp, sourceConfig.pushCooldownHours))) {
        console.log(`[SKIP COOLDOWN] ${item.source}: 冷却期内 (${sourceConfig.pushCooldownHours}h): ${item.title.substring(0, 40)}`);
        item.sent_to_wecom = 1;
        await saveNews([item]).catch(e => console.warn('[Save skip cooldown]', e.message));
        processedNews.push(item);
        continue;
      }

      if (isCritical) {
        console.log(`[CRITICAL] 紧急推送 (score=${item.alpha_score}): ${item.title.substring(0, 50)}`);
      }

      if (sentThisRun.has(nTitle) || pushLock.has(nTitle)) {
        item.sent_to_wecom = 1;
        await saveNews([item]).catch(e => console.warn('[Save sent this run]', e.message));
        processedNews.push(item);
        continue;
      }
      pushLock.add(nTitle);

      // 二次 DB 校验（防并发重复）
      const isActuallySent = await checkIfSent(item.url, nTitle);

      if (isActuallySent) {
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
        await sendToWeCom(item, { urgent: isCritical });
        
        // 更新源追踪信息
        await updateSourcePush(item.source, item.timestamp, item.title);
        
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

  // 4. 实时情报密度监控 (Proactive Alerting)
  try {
    const { monitor } = require('../monitoring/monitor');
    await monitor.checkDensity();
  } catch (e) {
    console.error('[Monitor] Alert check failed:', e.message);
  }

  // 5. 爬虫失败率汇总告警
  if (alertManager) {
    const totalScrapers = targetScrapers.length;
    let failedCount = 0;
    for (const [, status] of alertManager.scraperStatus) {
      if (status.consecutive > 0) failedCount++;
    }
    const failRate = totalScrapers > 0 ? failedCount / totalScrapers : 0;
    if (failRate >= 0.3) {
      const failedSources = [];
      for (const [source, status] of alertManager.scraperStatus) {
        if (status.consecutive > 0) {
          failedSources.push(`${source} (连续${status.consecutive}次: ${status.lastError || 'unknown'})`);
        }
      }
      alertManager.log('error', 'scraper-summary',
        `本轮爬取失败率 ${(failRate * 100).toFixed(0)}% (${failedCount}/${totalScrapers})`);
      alertManager._sendAlert(
        'Scraper Batch Alert',
        `本轮爬取失败率过高：${(failRate * 100).toFixed(0)}% (${failedCount}/${totalScrapers})\n\n失败来源：\n${failedSources.join('\n')}`,
        { failRate, failedCount, totalScrapers }
      );
    }
  }

  const elapsed = ((Date.now() - startMs) / 1000).toFixed(1);
  console.log(`=== [Scrape] Done. Saved ${processedNews.length} items in ${elapsed}s ===`);
  return processedNews;
}

module.exports = { runAllScrapers, checkImportance, ruleBasedPreFilter };

// Allow direct execution (e.g., from npm run scrape)
if (require.main === module) {
  let tier = 'all';
  if (process.argv.includes('--tier=high')) tier = 'high';
  if (process.argv.includes('--tier=low')) tier = 'low';

  runAllScrapers(tier).then(() => {
    console.log(`[Main] Scraper execution (${tier}) completed successfully.`);
    process.exit(0);
  }).catch(err => {
    console.error(`[Main] Fatal error during scraper execution (${tier}):`, err);
    process.exit(1);
  });
}
