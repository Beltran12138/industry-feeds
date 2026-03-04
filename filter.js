/**
 * filter.js — 统一数据清洗模块
 * 用于过滤抓取数据中的垃圾条目（微博分享链接、无效标题等）
 */

// 垃圾 URL 模式
const JUNK_URL_PATTERNS = [
    'service.weibo.com/share/share.php',
    'weibo.com/share',
    'share.php',
    '#m',  // nitter 锚点链接的重复
];

// 垃圾标题关键词（完全匹配或包含即过滤）
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
];

// 标题最小长度
const MIN_TITLE_LENGTH = 8;

/**
 * 判断一条新闻是否为垃圾数据
 * @param {Object} item - 新闻条目 {title, url, source, ...}
 * @returns {boolean} true = 应该被过滤掉
 */
function isJunkItem(item) {
    const title = (item.title || '').trim();
    const url = (item.url || '').trim();

    // 1. URL 匹配垃圾模式
    if (JUNK_URL_PATTERNS.some(p => url.includes(p))) return true;

    // 2. 标题完全匹配垃圾列表
    if (JUNK_TITLE_EXACT.some(junk => title === junk || title.startsWith(junk))) return true;

    // 3. 标题过短
    if (title.length < MIN_TITLE_LENGTH) return true;

    // 4. 纯标签类标题（以 # 开头且无实质内容）
    if (/^#\S+$/.test(title)) return true;

    return false;
}

/**
 * 过滤新闻列表，去除垃圾数据并按标题去重
 * @param {Array} items - 新闻条目数组
 * @returns {Array} 清洗后的条目
 */
function filterNewsItems(items) {
    const seen = new Set();
    return items.filter(item => {
        if (isJunkItem(item)) return false;

        // 标题去重（忽略前后空格、统一大小写）
        const titleKey = (item.title || '').trim().toLowerCase();
        const urlKey = (item.url || '').trim();
        // 联合去重
        const compositeKey = `${titleKey}|${urlKey}`;

        if (seen.has(compositeKey)) return false;
        seen.add(compositeKey);
        // 同时也防止仅标题极其相似（完全相同）的霸屏，加入到另一种查重中可以考虑，这里暂时只防 url+title。
        // 但是不同的源可能发一模一样的标题。为了保留多源， composite 也行。如果发现纯标题重复太多，也可以加回来。
        // 为了"根治"重复：很多时候不同交易所公告或者新闻是完全相同的标题。我们在这里按标题去重即可，忽略不同来源的重复发送。
        if (seen.has(titleKey)) return false;
        seen.add(titleKey);

        return true;
    });
}

module.exports = { isJunkItem, filterNewsItems };
