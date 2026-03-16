# Vercel 环境变量配置指南

## 🚀 快速配置

### 方法 1: 使用 Vercel CLI（推荐）

```bash
# 安装 Vercel CLI
npm install -g vercel

# 登录 Vercel
vercel login

# 进入项目目录
cd alpha-radar

# 拉取现有环境变量
vercel env pull

# 或逐个添加环境变量
vercel env add DEEPSEEK_API_KEY sk-xxx
vercel env add WECOM_WEBHOOK_URL https://...
vercel env add NOTION_API_KEY secret_xxx
vercel env add NOTION_DATABASE_ID xxx
vercel env add GITHUB_TOKEN ghp_xxx
vercel env add GITHUB_REPO Beltran12138/industry-feeds
vercel env add FEISHU_WEBHOOK_URL https://...
vercel env add FEISHU_SECRET xxx
vercel env add TELEGRAM_BOT_TOKEN xxx:xxx
vercel env add TELEGRAM_WEBHOOK_PORT 8080

# 部署到生产环境
vercel --prod
```

### 方法 2: Vercel Dashboard 手动配置

1. 访问 https://vercel.com/dashboard
2. 选择你的项目 `alpha-radar`
3. 进入 **Settings** → **Environment Variables**
4. 点击 **Add New** 添加以下变量

---

## 📋 必需环境变量

### 基础配置（必须）
```env
# AI 服务
DEEPSEEK_API_KEY=sk-xxxxxxxxxxxxxxxx

# 推送渠道
WECOM_WEBHOOK_URL=https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=xxx

# 数据库（可选，不填则仅使用本地 SQLite）
USE_SUPABASE=false
SUPABASE_URL=https://xxxxx.supabase.co
SUPABASE_KEY=sb_publishable_xxxxx
```

### 新功能配置（强烈推荐）

#### Notion 集成
```env
NOTION_API_KEY=secret_xxxxxxxxxxxxxxxxxxxxxxxx
NOTION_DATABASE_ID=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

#### GitHub 集成
```env
GITHUB_TOKEN=ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
GITHUB_REPO=Beltran12138/industry-feeds
```

#### Feishu（飞书）推送
```env
FEISHU_WEBHOOK_URL=https://open.feishu.cn/open-apis/bot/v2/hook/xxxxxxxx
FEISHU_SECRET=xxxxxxxxxxxxxxxx
```

#### Telegram Bot
```env
TELEGRAM_BOT_TOKEN=xxxxxxxx:xxxxxxxxxxxxxxxx
TELEGRAM_CHAT_ID=-100xxxxxxxx
TELEGRAM_WEBHOOK_PORT=8080
TELEGRAM_CHANNEL_ID=-100xxxxxxxx  # 可选：频道广播
```

#### AI 备用提供商（推荐配置）
```env
OPENROUTER_API_KEY=sk-or-v1-xxxxxxxxxxxxxxxx
OPENROUTER_MODEL=anthropic/claude-3.5-sonnet

ANTHROPIC_API_KEY=sk-ant-xxxxxxxxxxxxxxxx
ANTHROPIC_MODEL=claude-3-5-sonnet-20241022

OPENAI_API_KEY=sk-proj-xxxxxxxxxxxxxxxx
OPENAI_MODEL=gpt-4o-mini

GEMINI_API_KEY=AIza-xxxxxxxxxxxxxxxx
GEMINI_MODEL=gemini-2.0-flash
```

---

## 🔧 高级配置（可选）

### 成本与预算控制
```env
# AI 每日预算（美元）
AI_COST_DAILY_BUDGET_USD=10

# 预算告警阈值（80%）
AI_COST_ALERT_THRESHOLD=0.8

# 每个 token 成本（DeepSeek V3）
AI_COST_PER_1K_TOKENS=0.001
```

### 监控告警
```env
# 情报密度预警阈值
MONITOR_ALERT_THRESHOLD=3

# API 保护密钥
API_SECRET=your-secret-key-for-api-protection
```

### 应用配置
```env
# 应用 URL
APP_URL=https://alpha-radar.vercel.app
DASHBOARD_URL=https://alpha-radar.vercel.app

# CORS 配置
CORS_ORIGIN=https://alpha-radar.vercel.app

# 日志级别
LOG_LEVEL=info
```

---

## ⚙️ Vercel 特殊配置

### 1. 定时任务（Cron Jobs）

已在 `vercel.json` 中配置：
```json
{
  "crons": [
    {"path": "/api/scrape?tier=high", "schedule": "*/5 * * * *"},
    {"path": "/api/scrape?tier=low", "schedule": "*/30 * * * *"},
    {"path": "/api/health/check", "schedule": "0 * * * *"}
  ]
}
```

**注意**: Vercel Cron 需要 Pro 计划。如果使用免费版，请使用 GitHub Actions。

### 2. GitHub Actions 定时任务

已创建 `.github/workflows/cron.yml`，包含：
- ✅ 高频抓取（每 5 分钟）
- ✅ 低频抓取（每 30 分钟）
- ✅ 健康检查（每小时）
- ✅ 日报（每天 18:00 北京时间）
- ✅ 周报（每周五 18:00）
- ✅ Notion 同步（每 6 小时）
- ✅ GitHub 导出（每天 00:30）

**启用步骤**:
1. 在 GitHub 仓库启用 Actions
2. 在 Settings → Secrets and variables → Actions 中添加环境变量
3. Actions 会自动按 schedule 运行

### 3. Telegram Webhook

由于 Vercel Serverless 限制，需要在外部运行 webhook 服务器：

**选项 A: 使用 Railway（推荐）**
```bash
# 创建 Railway 项目
railway init

# 添加环境变量
railway variables set DEEPSEEK_API_KEY=xxx ...

# 部署
railway up
```

**选项 B: 使用 VPS**
```bash
# 在 VPS 上运行
node telegram-callbacks.js
```

**选项 C: 使用 ngrok（开发用）**
```bash
ngrok http 8080
# 将生成的 URL 设置为 TELEGRAM_PUBLIC_URL
```

---

## 🧪 验证配置

### 1. 测试 API 端点
```bash
# 健康状态
curl https://alpha-radar.vercel.app/api/health/sources

# 集成状态
curl https://alpha-radar.vercel.app/api/integrations/status

# RSS 输出
curl https://alpha-radar.vercel.app/api/feed.rss?min_score=80
```

### 2. 访问界面
- **主 Dashboard**: https://alpha-radar.vercel.app
- **健康监控**: https://alpha-radar.vercel.app/health-monitor
- **API 文档**: https://alpha-radar.vercel.app/api-docs

### 3. 测试推送
```bash
# 企业微信推送
curl -X POST https://alpha-radar.vercel.app/api/test-push

# Notion 同步
curl -X POST https://alpha-radar.vercel.app/api/integrations/notion/sync \
  -H "Content-Type: application/json" \
  -d '{"minScore":85}'
```

---

## 📊 监控与调试

### Vercel Dashboard
- **Deployments**: https://vercel.com/[account]/[project]/deployments
- **Analytics**: https://vercel.com/[account]/[project]/analytics
- **Logs**: https://vercel.com/[account]/[project]/logs

### GitHub Actions
- **Actions**: https://github.com/Beltran12138/industry-feeds/actions
- **Cron Runs**: 查看 cron.yml 的执行记录

### 常见问题

#### Q1: 部署失败
**解决**:
1. 检查 Build Logs
2. 确认 Node.js 版本为 20.x
3. 验证 `package.json` scripts 正确

#### Q2: API 返回 500
**解决**:
1. 检查 Functions Logs
2. 确认所有环境变量已配置
3. 验证数据库权限

#### Q3: 定时任务未执行
**解决**:
1. 检查 Vercel Cron 是否启用（需要 Pro 计划）
2. 或使用 GitHub Actions（免费）
3. 查看 Actions 运行日志

---

## 🎯 完成清单

- [ ] 添加所有环境变量到 Vercel
- [ ] 验证部署成功
- [ ] 测试所有 API 端点
- [ ] 启用 GitHub Actions
- [ ] 配置 GitHub Secrets
- [ ] 测试定时任务执行
- [ ] 配置 Telegram webhook（可选）
- [ ] 监控首次自动运行

---

**配置完成后，系统将自动运行！** 🚀

详细文档参考：
- DEPLOYMENT_GUIDE.md - 完整部署指南
- QUICKSTART.md - 快速开始
- IMPLEMENTATION_SUMMARY_2.md - 实施报告
