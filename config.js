/**
 * config.js — 全局配置中心
 * 将所有魔数、硬编码清单、行为开关统一管理，代码中不再散落配置。
 */

'use strict';

// ── 爬虫基础 ──────────────────────────────────────────────────────────────────
const SCRAPER = {
  USER_AGENT: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
  MAX_RETRIES: 3,
  BATCH_SIZE: 4,          // 并发爬虫批次大小
  BATCH_DELAY_MS: 2000,   // 批次间隔(ms)
  AI_DELAY_MS: 2000,      // AI 调用间隔(ms)
  MAX_AI_PER_RUN: 60,     // 单次运行最大 AI 调用次数
  TITLE_MAX_LEN: 200,
  CONTENT_MAX_LEN: 500,

  // Puppeteer 启动参数
  BROWSER_ARGS: [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--disable-gpu',
    '--disable-blink-features=AutomationControlled',
  ],
};

// ── KOL Twitter 账号 ──────────────────────────────────────────────────────────
const KOL_LIST = [
  { name: 'TwitterAB', username: '_FORAB' },
  { name: 'WuShuo',    username: 'colinwu' },
  { name: 'Phyrex',    username: 'PhyrexNi' },
  { name: 'XieJiayin', username: 'xiejiayinBitget' },
  { name: 'JustinSun', username: 'justinsuntron' },
];

// RSS/Nitter 备用源（按优先级排序）
// nitter.net 已关闭，使用 RSSHub 实例作为主力
const RSS_BASE_URLS = [
  'https://rsshub.rssforever.com/twitter/user',
  'https://hub.slarker.me/twitter/user',
  'https://rsshub.liumingye.cn/twitter/user',
  'https://rsshub.pseudoyu.com/twitter/user',
  'https://rsshub-instance.zeabur.app/twitter/user',
  'https://rsshub.app/twitter/user',
];

// ── 重要性判定规则 ─────────────────────────────────────────────────────────────

/** 永远不推送企业微信（但仍存库、展示前端）*/
const WECOM_BLOCK_SOURCES = new Set([
  'TwitterAB', 'WuShuo', 'Phyrex', 'JustinSun', 'XieJiayin',
  'Poly-Breaking', 'Poly-China',
  'TechFlow', 'BlockBeats',
]);

/** 香港合规板块 — 全量推送 */
const HK_SOURCES = new Set([
  'SFC', 'OSL', 'Exio', 'TechubNews',
  'HashKeyGroup', 'HashKeyExchange', 'WuBlock',
]);

/** PRNewswire 白名单：香港相关公司 */
const PR_HK_COMPANIES = [
  'hashkey', 'osl', 'exio', 'matrixport', 'finloop',
  'bitv', 'bitvalve', 'victory', 'hong kong', 'hk',
];

/** PRNewswire 白名单：头部离岸所 */
const PR_TOP_EXCHANGES = [
  'gate', 'okx', 'htx', 'bybit', 'mexc', 'bitget', 'binance', 'kucoin',
];

/** 主流交易所名单 */
const MAINSTREAM_EXCHANGES = new Set([
  'Gate', 'OKX', 'HTX', 'Bybit', 'MEXC', 'Bitget', 'Binance', 'KuCoin',
]);

/** 主流交易所需排除的普通上币类关键词（小写） */
const EXCHANGE_EXCLUDE_KEYWORDS = [
  'listing', '上线', '上架', '新币', 'launch', 'launchpool',
  'launchpad', 'airdrop', '空投', 'defi', '币', 'new pair',
];

/** 主流交易所重大动作关键词（大写，用于 title.toUpperCase() 匹配） */
const EXCHANGE_MAJOR_KEYWORDS = [
  'PENALTY', 'REGULAT', 'LICENSE', 'ACQUISITION', 'UPGRADE',
  '处罚', '高层', 'CEO', '收购', '牌照', 'STRATEGIC', 'INVEST',
  '法律', '合规', '法院', '政府',
];

/** 香港相关关键词 */
const HK_KEYWORDS = ['香港', 'HK', 'HONG KONG', '牌照', '监管', 'VASP', 'SFC', '证监会'];

// ── 噪声过滤 ──────────────────────────────────────────────────────────────────

/** 周报/日报时额外过滤的噪声来源（不进入精选报告） */
const REPORT_NOISE_SOURCES = new Set([
  'BlockBeats', 'TechFlow',
  'Poly-Breaking', 'Poly-China',
  'TwitterAB', 'WuShuo', 'Phyrex', 'JustinSun', 'XieJiayin',
]);

/** 周报噪声关键词（标题包含则跳过） */
const REPORT_NOISE_TITLE_KEYWORDS = [
  '爆仓', '清算', '鲸鱼', 'meme', 'Meme', 'MEME',
  '微信扫码', '分享划过', '置顶',
  '资金费率', '永续合约资金',
  'polymarket', 'Polymarket',
  '伊朗', '以色列', '特朗普', '哈梅内伊', '霍尔木兹',
];

/** filter.js 垃圾 URL 关键词 */
const JUNK_URL_PATTERNS = [
  'service.weibo.com/share/share.php',
  'weibo.com/share',
  'share.php',
];

/** filter.js 精确匹配垃圾标题 */
const JUNK_TITLE_EXACT = [
  '微信扫码 分享划过弹出',
  '微信扫码',
  '分享划过弹出',
  '置顶',
  '[原文链接]',
  '#Launchpool',
  '#Grid Trading',
  '#Demo Trading',
  '#区块链网络 & 分叉',
  'Gate Charity',
  'Gate Square',
  '#Trading Fee',
];

const MIN_TITLE_LENGTH = 8;

// ── AI 处理 ───────────────────────────────────────────────────────────────────

/** 需要经过 AI 分类的来源 */
const AI_SOURCES = new Set([
  'SFC', 'TechubNews', 'Exio', 'OSL', 'WuBlock', 'PRNewswire', 'HTX', 'MEXC', 'Gate',
  'Binance', 'OKX', 'Bybit', 'Bitget', 'KuCoin', 'HashKeyGroup', 'HashKeyExchange',
]);

/** 业务分类选项（与 AI prompt 保持一致） */
const BUSINESS_CATEGORIES = [
  '经纪/OTC/托管', '合约', '公链', '投融资', '合规',
  '稳定币/平台币', '交易/量化/AI', '钱包/支付', 'toB/机构',
  '学院/社交/内容/活动', '大零户/VIP', 'RWA', '法币兑换', '理财',
  '拉新/社媒/社群/pr',
];

/** 竞争类型选项 */
const COMPETITOR_CATEGORIES = [
  '香港合规所', '离岸所', '其他',
];

// ── 报告设置 ──────────────────────────────────────────────────────────────────
const REPORT = {
  MAX_ITEMS_FOR_AI: 60,           // 传入 AI 的最大条目数
  WEEKLY_TOP_PER_CAT: 5,          // 周报每分类最多展示条目数
  DAILY_IMPORTANT_TOP: 20,        // 日报重点条目上限
  WEEKLY_SELECT_TOP: 30,          // 周报精选 top N 条
  CATEGORY_ORDER: [
    '经纪/OTC/托管', '合约', '公链', '投融资', '合规',
    '稳定币/平台币', '交易/量化/AI', '钱包/支付', 'toB/机构',
    '学院/社交/内容/活动', '大零户/VIP', 'RWA', '法币兑换', '理财',
    '拉新/社媒/社群/pr',
  ],
};

// ── 紧急推送 ──────────────────────────────────────────────────────────────────
const CRITICAL_SCORE_THRESHOLD = 95; // alpha_score >= 此值触发即时推送，不等批次

// ── AI 成本控制 ───────────────────────────────────────────────────────────────
const AI_COST = {
  DAILY_BUDGET_USD: 10,           // 每日预算上限（美元）
  COST_PER_1K_TOKENS: 0.001,     // DeepSeek V3 定价
  ALERT_THRESHOLD: 0.8,          // 消耗 80% 时告警
};

// ── 企业微信 ──────────────────────────────────────────────────────────────────
const WECOM = {
  MARKDOWN_LIMIT: 4096,
  SEGMENT_DELAY_MS: 1000,
};

// ── 数据库 ────────────────────────────────────────────────────────────────────
const DB = {
  SUPABASE_CHUNK_SIZE: 100,   // Supabase 批量查询大小
  NEWS_FETCH_LIMIT: 500,
};

// ── 数据生命周期管理 ──────────────────────────────────────────────────────────
const DATA_RETENTION = {
  // 热数据（7天）：完整字段，高频查询
  HOT_DAYS: 7,

  // 温数据（30天）：精简字段，归档存储
  WARM_DAYS: 30,

  // 冷数据（90天）：仅保留统计维度
  COLD_DAYS: 90,

  // 自动清理任务（Cron 表达式）
  AUTO_CLEANUP_CRON: '0 2 * * *', // 每天凌晨2点

  // 压缩阈值：内容字段超过此长度将被截断
  CONTENT_COMPRESS_THRESHOLD: 200,
};

// ── 消息源级别配置 ────────────────────────────────────────────────────────────
/**
 * 每个消息源的独立配置：
 * - maxAgeHours: 允许抓取的最大消息年龄（小时），超过此时间的消息直接丢弃
 * - enableStrictTimestamp: 是否启用严格时间戳模式（无有效时间戳则丢弃）
 * - dedupMode: 去重模式 ('strict' | 'normal' | 'loose')
 *   - strict: URL+ 标题归一化 + 内容指纹三重验证
 *   - normal: URL+ 标题归一化
 *   - loose: 仅 URL 去重
 * - pushCooldownHours: 推送冷却时间（小时），同一来源的相似消息在此时间内不重复推送
 */
const SOURCE_CONFIGS = {
  // 监管源 - 极高权重，长有效期
  'SFC':            { maxAgeHours: 168, enableStrictTimestamp: false, dedupMode: 'strict', pushCooldownHours: 48 },

  // 香港合规板块 - 较宽松的时间窗口（消息价值较高）
  'OSL':            { maxAgeHours: 72, enableStrictTimestamp: false, dedupMode: 'strict', pushCooldownHours: 24 },
  'Exio':           { maxAgeHours: 72, enableStrictTimestamp: false, dedupMode: 'strict', pushCooldownHours: 24 },
  'TechubNews':     { maxAgeHours: 24,  enableStrictTimestamp: true,  dedupMode: 'strict', pushCooldownHours: 48 },
  // Matrixport 已禁用 - 帮助中心页面无时间信息，无法判断文章新旧，导致重复推送
  // 'Matrixport':     { maxAgeHours: 24,  enableStrictTimestamp: false, dedupMode: 'strict', pushCooldownHours: 24 },
  'Matrixport':     { maxAgeHours: 24,  enableStrictTimestamp: true,  dedupMode: 'strict', pushCooldownHours: 24, disabled: true },
  'HashKeyGroup':   { maxAgeHours: 48,  enableStrictTimestamp: false, dedupMode: 'strict', pushCooldownHours: 24 },
  'HashKeyExchange':{ maxAgeHours: 48,  enableStrictTimestamp: false, dedupMode: 'strict', pushCooldownHours: 24 },
  'WuBlock':        { maxAgeHours: 48,  enableStrictTimestamp: false, dedupMode: 'strict', pushCooldownHours: 48 },

  // PRNewswire - 严格时间戳（经常有旧闻混入）
  'PRNewswire':     { maxAgeHours: 24, enableStrictTimestamp: true, dedupMode: 'strict', pushCooldownHours: 24 },

  // 主流交易所 - 中等严格度
  'Binance':        { maxAgeHours: 48, enableStrictTimestamp: false, dedupMode: 'strict', pushCooldownHours: 24 },
  'OKX':            { maxAgeHours: 48, enableStrictTimestamp: false, dedupMode: 'strict', pushCooldownHours: 24 },
  'Bybit':          { maxAgeHours: 48, enableStrictTimestamp: false, dedupMode: 'strict', pushCooldownHours: 24 },
  'HTX':            { maxAgeHours: 48, enableStrictTimestamp: false, dedupMode: 'strict', pushCooldownHours: 24 },
  'Gate':           { maxAgeHours: 48, enableStrictTimestamp: false, dedupMode: 'strict', pushCooldownHours: 24 },
  'MEXC':           { maxAgeHours: 48, enableStrictTimestamp: false, dedupMode: 'strict', pushCooldownHours: 24 },
  'Bitget':         { maxAgeHours: 48, enableStrictTimestamp: false, dedupMode: 'strict', pushCooldownHours: 24 },
  'KuCoin':         { maxAgeHours: 48, enableStrictTimestamp: false, dedupMode: 'strict', pushCooldownHours: 24 },

  // 社交媒体/KOL-严格去重
  'TwitterAB':      { maxAgeHours: 24, enableStrictTimestamp: true, dedupMode: 'strict', pushCooldownHours: 12 },
  'WuShuo':         { maxAgeHours: 24, enableStrictTimestamp: true, dedupMode: 'strict', pushCooldownHours: 12 },
  'Phyrex':         { maxAgeHours: 24, enableStrictTimestamp: true, dedupMode: 'strict', pushCooldownHours: 12 },
  'JustinSun':      { maxAgeHours: 24, enableStrictTimestamp: true, dedupMode: 'strict', pushCooldownHours: 12 },
  'XieJiayin':      { maxAgeHours: 24, enableStrictTimestamp: true, dedupMode: 'strict', pushCooldownHours: 12 },

  // 媒体/快讯 - 严格时间窗口
  'BlockBeats':     { maxAgeHours: 12, enableStrictTimestamp: true, dedupMode: 'strict', pushCooldownHours: 6 },
  'TechFlow':       { maxAgeHours: 72, enableStrictTimestamp: false, dedupMode: 'strict', pushCooldownHours: 24 },

  // Prediction Markets - 严格去重
  'Poly-Breaking':  { maxAgeHours: 24, enableStrictTimestamp: true, dedupMode: 'strict', pushCooldownHours: 12 },
  'Poly-China':     { maxAgeHours: 24, enableStrictTimestamp: true, dedupMode: 'strict', pushCooldownHours: 12 },
};

// 默认配置（未明确配置的消息源使用此默认值）
const DEFAULT_SOURCE_CONFIG = {
  maxAgeHours: 48,
  enableStrictTimestamp: false,
  dedupMode: 'normal',
  pushCooldownHours: 24,
};

// ── 拉取频率分层 ────────────────────────────────────────────────────────────
// 高频拉取源（T0：极度敏感，建议 3-5 分钟级别）
const HIGH_FREQ_SOURCES = [
  'SFC', 'Binance', 'OKX',
  'TwitterKOLs',             // 包含所有的 KOL (TwitterAB, WuShuo 等)
  'PolymarketBreaking', 'PolymarketChina',
];

// 低频拉取源（T1：常规快讯与公关，建议 15-30 分钟级别）
const LOW_FREQ_SOURCES = [
  'TechFlow', 'PRNewswire', 'BlockBeats',
  'OSL', 'TechubNews', 'Exio',
  'WuBlock', 'HashKeyGroup', 'KuCoin', 'HashKeyExchange',
  'Bybit', 'Bitget', 'Mexc', 'Gate', 'Htx',
];

// ── 服务器 ────────────────────────────────────────────────────────────────────
const SERVER = {
  PORT: process.env.PORT || 3001,
  NEWS_LIMIT_ALL: 500,
  NEWS_LIMIT_SOURCE: 100,
  SCRAPE_HIGH_CRON: '*/5 * * * *',    // 高频 5 分钟
  SCRAPE_LOW_CRON: '*/30 * * * *',    // 低频 30 分钟
  DAILY_REPORT_CRON: '0 18 * * *',   // 每天北京时间 18:00 (需配合 timezone: Asia/Shanghai)
  WEEKLY_REPORT_CRON: '0 18 * * 5',   // 每周五北京时间 18:00 (需配合 timezone: Asia/Shanghai)
};

// ── 监控告警配置 ──────────────────────────────────────────────────────────────
const MONITORING = {
  // 爬虫失败告警阈值
  SCRAPER_FAIL_THRESHOLD: parseInt(process.env.SCRAPER_FAIL_THRESHOLD || '3', 10),
  
  // 健康检查间隔（毫秒）
  HEALTH_CHECK_INTERVAL_MS: parseInt(process.env.HEALTH_CHECK_INTERVAL_MS || '300000', 10), // 5 分钟
  
  // 告警冷却时间（毫秒）- 同一告警多久内不重复发送
  ALERT_COOLDOWN_MS: parseInt(process.env.ALERT_COOLDOWN_MS || '3600000', 10), // 1 小时
  
  // AI 成本告警
  AI_DAILY_BUDGET_USD: parseFloat(process.env.AI_DAILY_BUDGET_USD || '10'),
  AI_ALERT_THRESHOLD: parseFloat(process.env.AI_ALERT_THRESHOLD || '0.8'), // 80% 预算时告警
  
  // 数据源健康度阈值
  SOURCE_HEALTH_MIN_SUCCESS_RATE: parseFloat(process.env.SOURCE_HEALTH_MIN_SUCCESS_RATE || '0.7'), // 70% 成功率
  SOURCE_HEALTH_MIN_ITEMS: parseInt(process.env.SOURCE_HEALTH_MIN_ITEMS || '5', 10), // 最少抓取数量
  
  // 数据库大小告警（MB）
  DB_SIZE_WARN_MB: parseInt(process.env.DB_SIZE_WARN_MB || '100', 10),
  
  // 内存使用告警（MB）
  MEMORY_WARN_MB: parseInt(process.env.MEMORY_WARN_MB || '500', 10),
};

module.exports = {
  SCRAPER,
  KOL_LIST,
  RSS_BASE_URLS,
  WECOM_BLOCK_SOURCES,
  HK_SOURCES,
  PR_HK_COMPANIES,
  PR_TOP_EXCHANGES,
  MAINSTREAM_EXCHANGES,
  EXCHANGE_EXCLUDE_KEYWORDS,
  EXCHANGE_MAJOR_KEYWORDS,
  HK_KEYWORDS,
  REPORT_NOISE_SOURCES,
  REPORT_NOISE_TITLE_KEYWORDS,
  JUNK_URL_PATTERNS,
  JUNK_TITLE_EXACT,
  MIN_TITLE_LENGTH,
  AI_SOURCES,
  BUSINESS_CATEGORIES,
  COMPETITOR_CATEGORIES,
  REPORT,
  WECOM,
  DB,
  DATA_RETENTION,
  SERVER,
  MONITORING, // 新增监控配置
  SOURCE_CONFIGS,
  DEFAULT_SOURCE_CONFIG,
  HIGH_FREQ_SOURCES,
  LOW_FREQ_SOURCES,
  CRITICAL_SCORE_THRESHOLD,
  AI_COST,
};
