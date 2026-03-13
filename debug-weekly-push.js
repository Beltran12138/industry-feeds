'use strict';

// 强制使用本地 SQLite 并启用详细日志
process.env.USE_SUPABASE = 'false';

const { runWeeklyReport } = require('./report');

async function debugWeeklyReport() {
  try {
    console.log('=== 开始调试周报生成 ===');
    
    // 先获取原始数据看看
    const db = require('./db').db;
    const stmt = db.prepare('SELECT title, source, business_category, alpha_score FROM news WHERE timestamp > ? ORDER BY timestamp DESC LIMIT 10');
    const oneWeekAgo = Date.now() - 7 * 24 * 3600 * 1000;
    const recentItems = stmt.all(oneWeekAgo);
    
    console.log('最近 10 条数据:');
    recentItems.forEach((item, i) => {
      console.log(`${i+1}. [${item.source}] ${item.title.substring(0, 30)}...`);
      console.log(`   分类: ${item.business_category || '未分类'} | Score: ${item.alpha_score}`);
    });
    
    console.log('\n开始生成周报...');
    const report = await runWeeklyReport(false);  // 实际推送
    
    if (report) {
      console.log('✅ 周报生成并推送成功!');
      console.log('报告长度:', report.length);
    } else {
      console.log('❌ 周报返回 null');
    }
    
  } catch (err) {
    console.error('❌ 错误:', err.message);
    console.error('Stack:', err.stack);
  }
}

debugWeeklyReport();