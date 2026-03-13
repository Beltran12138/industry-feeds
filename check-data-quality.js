'use strict';

process.env.USE_SUPABASE = 'false';

const db = require('./db').db;

// 检查高分项目
const stmt = db.prepare('SELECT COUNT(*) as count FROM news WHERE alpha_score >= 70');
const result = stmt.get();
console.log('High score items (>=70):', result.count);

// 检查已分类项目
const stmt2 = db.prepare("SELECT COUNT(*) as count FROM news WHERE business_category IS NOT NULL AND business_category != '' AND business_category != '其他'");
const result2 = stmt2.get();
console.log('Classified items:', result2.count);

// 检查最近一周的数据
const oneWeekAgo = Date.now() - 7 * 24 * 3600 * 1000;
const stmt3 = db.prepare('SELECT COUNT(*) as count FROM news WHERE timestamp > ?');
const result3 = stmt3.get(oneWeekAgo);
console.log('Items in last week:', result3.count);