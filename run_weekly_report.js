/**
 * run_weekly_report.js — 周报生成 + 推送入口
 *
 * 用法：
 *   node run_weekly_report.js            # 生成并推送周报到企微群
 *   node run_weekly_report.js --dry-run  # 仅生成周报内容，不推送
 *
 * 可由 GitHub Actions cron（每周五 UTC 10:00 = 北京时间 18:00）调用
 */
require('dotenv').config();
const { runWeeklyReport } = require('./report');

const dryRun = process.argv.includes('--dry-run');

(async () => {
    try {
        console.log(`[WeeklyReport] Starting... (dryRun=${dryRun})`);
        console.log(`[WeeklyReport] Time: ${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`);
        await runWeeklyReport(dryRun);
        console.log('[WeeklyReport] Completed.');
    } catch (err) {
        console.error('[WeeklyReport] Fatal error:', err);
        process.exit(1);
    }
})();
