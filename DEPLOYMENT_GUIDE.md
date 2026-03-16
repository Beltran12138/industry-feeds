# Alpha Radar GitHub & Vercel 部署指南

## ✅ GitHub 同步完成

所有优化已成功推送到 GitHub：
- **仓库**: https://github.com/Beltran12138/industry-feeds
- **分支**: master
- **最新提交**: `a47de09` - 🚀 MAJOR: Complete Alpha-Radar optimization (100% done)

### 提交统计
- **新增文件**: 22 个
- **修改文件**: 63 个
- **代码变更**: +6974 行，-2422 行
- **删除文件**: 2 个（包含敏感信息）

---

## 🚀 Vercel 自动部署

Vercel 会自动从 GitHub 仓库部署，无需手动操作。

### 自动触发流程

1. **GitHub Push** → 已完成 ✅
2. **Vercel Webhook** → 自动触发构建
3. **生产环境部署** → 预计 2-5 分钟

### 查看部署状态

访问 Vercel Dashboard：
```
https://vercel.com/dashboard
```

或查看项目部署：
```
https://vercel.com/[your-account]/industry-feeds
```

---

## ⚙️ Vercel 环境变量配置

在 Vercel Dashboard 中添加以下环境变量：

### 必需变量
```env
DEEPSEEK_API_KEY=sk-xxx
WECOM_WEBHOOK_URL=https://...
```

### 推荐变量（新功能）
```env
# Feishu
FEISHU_WEBHOOK_URL=https://open.feishu.cn/open-apis/bot/v2/hook/xxx
FEISHU_SECRET=xxx

# Telegram
TELEGRAM_BOT_TOKEN=xxx:xxx
TELEGRAM_CHAT_ID=-100xxx
TELEGRAM_WEBHOOK_PORT=8080

# Notion
NOTION_API_KEY=secret_xxx
NOTION_DATABASE_ID=xxx

# GitHub
GITHUB_TOKEN=ghp_xxx
GITHUB_REPO=username/repo-name

# AI 备用
OPENROUTER_API_KEY=sk-or-xxx
ANTHROPIC_API_KEY=sk-ant-xxx
```

### 配置步骤
1. 打开 Vercel 项目设置
2. 进入 "Environment Variables"
3. 添加上述变量
4. 点击 "Redeploy" 使新变量生效

---

## 🔧 Vercel 特殊配置

### 1. 定时任务（Cron Jobs）

Vercel 使用 GitHub Actions 运行定时任务，配置如下：

创建 `.github/workflows/cron.yml`:
```yaml
name: Cron Jobs

on:
  schedule:
    # 高频抓取（每 5 分钟）
    - cron: '*/5 * * * *'
    # 低频抓取（每 30 分钟）
    - cron: '*/30 * * * *'
    # 日报（每天 18:00 UTC）
    - cron: '0 10 * * *'
    # 周报（每周五 18:00 UTC）
    - cron: '0 10 * * 5'

jobs:
  scrape:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
      - run: npm install
      - run: npm run scrape:high
        env:
          DEEPSEEK_API_KEY: ${{ secrets.DEEPSEEK_API_KEY }}
          WECOM_WEBHOOK_URL: ${{ secrets.WECOM_WEBHOOK_URL }}
          # ... 其他环境变量
```

### 2. Telegram Webhook

由于 Vercel Serverless 限制，需要在外部服务器运行 Telegram webhook：

选项 1：使用 VPS（推荐）
```bash
# 在 VPS 上运行
node telegram-callbacks.js
```

选项 2：使用 Railway/Render 等 PaaS
```bash
# 部署到 Railway
railway up
```

选项 3：使用 ngrok 本地隧道（开发用）
```bash
ngrok http 8080
# 将生成的 URL 设置为 TELEGRAM_PUBLIC_URL
```

### 3. 健康监控 Dashboard

访问地址：
```
https://alpha-radar.vercel.app/health-monitor
```

如果无法访问，检查 Vercel 路由配置：

创建 `vercel.json`:
```json
{
  "routes": [
    {
      "src": "/health-monitor",
      "dest": "/public/health.html"
    },
    {
      "src": "/api/(.*)",
      "dest": "/server.js"
    },
    {
      "src": "/(.*)",
      "dest": "/public/$1"
    }
  ]
}
```

---

## 📊 验证部署

### 1. 检查 API 端点
```bash
# 健康监控
curl https://alpha-radar.vercel.app/api/health/sources

# RSS 输出
curl https://alpha-radar.vercel.app/api/feed.rss?min_score=80

# 集成状态
curl https://alpha-radar.vercel.app/api/integrations/status
```

### 2. 访问界面
- **主 Dashboard**: https://alpha-radar.vercel.app
- **健康监控**: https://alpha-radar.vercel.app/health-monitor
- **API 文档**: https://alpha-radar.vercel.app/api-docs

### 3. 测试推送
```bash
# 测试企业微信推送
curl -X POST https://alpha-radar.vercel.app/api/test-push

# 触发 Notion 同步
curl -X POST https://alpha-radar.vercel.app/api/integrations/notion/sync \
  -H "Content-Type: application/json" \
  -d '{"minScore":85}'
```

---

## 🔍 故障排查

### 问题 1: Vercel 构建失败
**解决方案**:
1. 检查 Vercel Build Logs
2. 确认 `package.json` 中的 scripts 正确
3. 验证 Node.js 版本（需要 20.x）

### 问题 2: API 返回 500 错误
**解决方案**:
1. 检查 Vercel Functions Logs
2. 确认所有环境变量已配置
3. 验证数据库文件权限

### 问题 3: Telegram webhook 不工作
**解决方案**:
1. 确认 webhook URL 可公开访问
2. 检查 TELEGRAM_BOT_TOKEN 配置
3. 验证端口 8080 开放

### 问题 4: 定时任务未执行
**解决方案**:
1. 检查 GitHub Actions 是否启用
2. 验证 `.github/workflows/cron.yml` 语法
3. 查看 Actions 运行日志

---

## 📈 性能监控

### Vercel Analytics
访问：https://vercel.com/[account]/[project]/analytics

监控指标：
- Web Vitals
- 页面加载时间
- API 响应时间

### 自定义监控
使用健康监控 API：
```bash
# 每分钟检查一次
watch -n 60 curl https://alpha-radar.vercel.app/api/health/sources
```

---

## 🎯 下一步行动

### 立即可做
1. ✅ ~~GitHub 推送完成~~
2. [ ] 配置 Vercel 环境变量
3. [ ] 验证自动部署成功
4. [ ] 测试所有 API 端点

### 短期（1-2 天）
1. [ ] 设置 GitHub Actions 定时任务
2. [ ] 配置 Telegram webhook 服务器
3. [ ] 测试 Notion/GitHub 集成

### 中期（1 周）
1. [ ] 监控生产环境性能
2. [ ] 收集用户反馈
3. [ ] 根据使用情况调整配置

---

## 📞 支持资源

- **Vercel 文档**: https://vercel.com/docs
- **GitHub Actions**: https://docs.github.com/actions
- **项目文档**: 查看本目录下的 .md 文件

---

**祝部署顺利！** 🚀

如有问题，请查看：
- IMPLEMENTATION_SUMMARY_2.md - 完整实施报告
- QUICKSTART.md - 快速开始指南
- CHECKLIST.md - 功能检查清单
