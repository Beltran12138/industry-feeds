/**
 * cleanup-matrixport.js — 一次性脚本：清除所有 Matrixport 数据
 */
require('dotenv').config();

const Database = require('better-sqlite3');
const path = require('path');

const db = new Database(path.join(__dirname, 'alpha_radar.db'));

// 查看当前数据量
const before = db.prepare("SELECT COUNT(*) as n FROM news WHERE source = 'Matrixport'").get();
console.log('Matrixport 本地数据条数:', before.n);

// 删除
const result = db.prepare("DELETE FROM news WHERE source = 'Matrixport'").run();
console.log('已删除:', result.changes, '条');

// 归档表也清理
try {
  const archiveCount = db.prepare("SELECT COUNT(*) as n FROM news_archive WHERE source = 'Matrixport'").get();
  console.log('归档表 Matrixport 数据:', archiveCount.n);
  if (archiveCount.n > 0) {
    const r2 = db.prepare("DELETE FROM news_archive WHERE source = 'Matrixport'").run();
    console.log('归档表已删除:', r2.changes, '条');
  }
} catch (e) {
  console.log('归档表不存在或无数据，跳过');
}

// 验证
const after = db.prepare("SELECT COUNT(*) as n FROM news WHERE source = 'Matrixport'").get();
console.log('删除后剩余:', after.n, '条');

// 总数据量
const total = db.prepare("SELECT COUNT(*) as n FROM news").get();
console.log('数据库总条数:', total.n);

db.close();
console.log('本地清理完成');

// 清理 Supabase（如果配置了）
async function cleanSupabase() {
  const USE_SUPABASE = (process.env.USE_SUPABASE || '').trim() === 'true';
  if (!USE_SUPABASE || !process.env.SUPABASE_URL || !process.env.SUPABASE_KEY) {
    console.log('Supabase 未配置，跳过远端清理');
    return;
  }

  const { createClient } = require('@supabase/supabase-js');
  const supabase = createClient(process.env.SUPABASE_URL.trim(), process.env.SUPABASE_KEY.trim());

  // 查询数量
  const { count: sbCount } = await supabase
    .from('news')
    .select('*', { count: 'exact', head: true })
    .eq('source', 'Matrixport');
  console.log('Supabase Matrixport 数据条数:', sbCount);

  if (sbCount > 0) {
    const { error } = await supabase
      .from('news')
      .delete()
      .eq('source', 'Matrixport');

    if (error) {
      console.error('Supabase 删除失败:', error.message);
    } else {
      console.log('Supabase 已删除 Matrixport 数据');
    }
  }

  // 验证
  const { count: afterCount } = await supabase
    .from('news')
    .select('*', { count: 'exact', head: true })
    .eq('source', 'Matrixport');
  console.log('Supabase 删除后剩余:', afterCount);
}

cleanSupabase().catch(e => console.error('Supabase 清理失败:', e.message));
