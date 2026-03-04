/**
 * run_daily_report.js — 日报生成 + 推送入口
 *
 * 用法：
 *   node run_daily_report.js            # 生成并推送日报到企微群
 *   node run_daily_report.js --dry-run  # 仅生成日报内容，不推送
 *
 * 可由 GitHub Actions cron 或 node-cron 调用
 */
require('dotenv').config();
const { runDailyReport } = require('./report');

const dryRun = process.argv.includes('--dry-run');

(async () => {
    try {
        console.log(`[DailyReport] Starting... (dryRun=${dryRun})`);
        console.log(`[DailyReport] Time: ${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`);
        await runDailyReport(dryRun);
        console.log('[DailyReport] Completed.');
    } catch (err) {
        console.error('[DailyReport] Fatal error:', err);
        process.exit(1);
    }
})();
