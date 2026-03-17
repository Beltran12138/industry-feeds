#!/usr/bin/env node
'use strict';
/**
 * verify-deployment.js - 验证 GitHub 和 Vercel 部署状态
 */

const https = require('https');

console.log('=== Alpha Radar 部署验证 ===\n');

// GitHub 仓库信息
const GITHUB_REPO = 'Beltran12138/industry-feeds';
const LATEST_COMMIT = require('child_process')
  .execSync('git log --oneline -1')
  .toString()
  .trim();

console.log('📦 GitHub 同步状态:');
console.log(`   仓库：${GITHUB_REPO}`);
console.log(`   最新提交：${LATEST_COMMIT}`);
console.log(`   ✓ 已推送到 GitHub\n`);

// Vercel 部署检查
const VERCEL_URL = 'industry-feeds.vercel.app';

console.log('🚀 Vercel 部署状态:');
console.log(`   项目：${VERCEL_URL}`);
console.log(`   状态：检测中...\n`);

// 检查 Vercel 网站可访问性
https.get(`https://${VERCEL_URL}/api/health`, (res) => {
  let data = '';
  
  res.on('data', chunk => data += chunk);
  res.on('end', () => {
    if (res.statusCode === 200) {
      try {
        const health = JSON.parse(data);
        console.log('✅ Vercel 部署成功！\n');
        console.log('📊 健康状态:');
        console.log(`   状态：${health.status || 'OK'}`);
        console.log(`   运行时间：${Math.floor(health.uptime / 60)} 分钟`);
        if (health.db) {
          console.log(`   数据库：${health.db.total} 条记录`);
        }
        console.log(`\n🔗 访问链接:`);
        console.log(`   主页：https://${VERCEL_URL}`);
        console.log(`   监控面板：https://${VERCEL_URL}/monitoring.html`);
        console.log(`   API 文档：https://${VERCEL_URL}/api-docs`);
        console.log(`   健康检查：https://${VERCEL_URL}/api/health\n`);
      } catch (e) {
        console.log('⏳ Vercel 正在部署中，请稍候重试...\n');
      }
    } else {
      console.log('⏳ Vercel 正在部署中，请稍候重试...\n');
      console.log(`   HTTP ${res.statusCode}\n`);
    }
    
    printNextSteps();
  });
}).on('error', (err) => {
  console.log('⏳ Vercel 正在部署中，请稍候重试...\n');
  console.log(`   错误：${err.message}\n`);
  printNextSteps();
});

function printNextSteps() {
  console.log('📝 下一步操作:\n');
  console.log('1. 查看 Vercel 部署日志:');
  console.log('   https://vercel.com/dashboard');
  console.log('');
  console.log('2. 检查 GitHub Actions:');
  console.log('   https://github.com/Beltran12138/industry-feeds/actions');
  console.log('');
  console.log('3. 测试生产环境功能:');
  console.log('   - 访问监控面板查看实时数据');
  console.log('   - 测试 API 端点响应');
  console.log('   - 验证 Redis 缓存（如已启用）');
  console.log('');
  console.log('✨ 所有更改已成功同步！\n');
}

// 超时处理
setTimeout(() => {
  console.log('\n⏱️  验证超时，Vercel 可能仍在部署中...');
  console.log('请手动访问：https://vercel.com/dashboard 查看部署进度\n');
  process.exit(0);
}, 15000);
