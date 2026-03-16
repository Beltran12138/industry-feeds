# Vercel 环境变量配置指南

## ✅ 当前状态

你的 Vercel 项目已有以下环境变量：
- ✅ `DEEPSEEK_API_KEY` - AI API 密钥
- ✅ `WECOM_WEBHOOK_URL` - 企业微信机器人
- ✅ `GEMINI_API_KEY` - Google Gemini AI
- ✅ `SUPABASE_URL` - Supabase 数据库 URL
- ✅ `SUPABASE_KEY` - Supabase 数据库密钥
- ✅ `USE_SUPABASE` - Supabase 启用标志

## ⏳ 需要添加的变量

以下是还需要添加的环境变量（按重要性排序）：

### 高优先级（必须）
1. **NOTION_API_KEY** - Notion 集成（高价值情报同步）
2. **NOTION_DATABASE_ID** - Notion 数据库 ID
3. **GITHUB_TOKEN** - GitHub Issues/Releases 集成
4. **GITHUB_REPO** - GitHub 仓库路径

### 中优先级（推荐）
5. **FEISHU_WEBHOOK_URL** - 飞书推送渠道
6. **TELEGRAM_BOT_TOKEN** - Telegram Bot 交互式推送

### 低优先级（可选备用）
7. **OPENROUTER_API_KEY** - OpenRouter（AI 备用提供商）
8. **OPENAI_API_KEY** - OpenAI GPT（AI 备用提供商）

---

## 🚀 快速配置方法

### 方法 1: 使用批处理脚本（最简单）⭐

我已经为你创建了自动化脚本，直接运行即可：

```bash
# 在项目目录中双击运行此文件
vercel-add-envs.bat
```

或手动执行：

```bash
cd C:\Users\lenovo\alpha-radar
.\vercel-add-envs.bat
```

**脚本会自动：**
1. 逐个提示你输入缺失的环境变量值
2. 使用 Vercel CLI 添加到项目中
3. 自动部署到生产环境

---

### 方法 2: 手动逐条添加（最安全）

如果你想手动控制每个变量，可以逐条执行：

```bash
cd C:\Users\lenovo\alpha-radar

# 1. Notion 集成
vercel env add NOTION_API_KEY secret_xxxxxxxxxxxxxxxxxxxxxxxx
vercel env add NOTION_DATABASE_ID xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx

# 2. GitHub 集成
vercel env add GITHUB_TOKEN ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
vercel env add GITHUB_REPO Beltran12138/industry-feeds

# 3. 飞书推送
vercel env add FEISHU_WEBHOOK_URL https://open.feishu.cn/open-apis/bot/v2/hook/xxxxxxxx

# 4. Telegram Bot
vercel env add TELEGRAM_BOT_TOKEN xxxxxxxxxxxx:xxxxxxxxxxxxxxxxxxxx

# 5. AI 备用提供商（可选）
vercel env add OPENROUTER_API_KEY sk-or-v1-xxxxxxxxxxxxxxxx
vercel env add OPENAI_API_KEY sk-proj-xxxxxxxxxxxxxxxx

# 6. 部署到生产环境
vercel --prod
```

---

### 方法 3: Vercel Dashboard 网页配置

1. 访问：https://vercel.com/dashboard
2. 选择项目：`alpha-radar`
3. 点击 **Settings** → **Environment Variables**
4. 点击 **Add New** 添加每个变量
5. 选择环境：**Production**
6. 保存后重新部署

---

## 📋 如何获取这些密钥

### 1. Notion API Key
1. 访问：https://www.notion.so/my-integrations
2. 点击 **+ New integration**
3. 填写名称，选择工作区
4. 复制 **Internal Integration Token** (`secret_xxx`)
5. 在 Notion 数据库中分享你的集成
6. 从数据库 URL 复制 Database ID

### 2. GitHub Token
1. 访问：https://github.com/settings/tokens
2. 点击 **Generate new token (classic)**
3. 勾选权限：`repo`, `workflow`, `write:packages`
4. 生成并复制 token (`ghp_xxx`)

### 3. 飞书 Webhook
1. 在飞书群聊中添加 **自定义机器人**
2. 复制 Webhook URL

### 4. Telegram Bot Token
1. 在 Telegram 中与 @BotFather 对话
2. 发送 `/newbot` 创建机器人
3. 复制 token (`xxx:xxx` 格式)

---

## ✅ 验证配置

配置完成后，等待部署完成（2-5 分钟），然后测试：

```bash
# 测试健康监控 API
curl https://alpha-radar.vercel.app/api/health/sources

# 测试集成状态
curl https://alpha-radar.vercel.app/api/integrations/status

# 访问健康监控页面
# https://alpha-radar.vercel.app/health-monitor
```

---

## 🔍 查看环境变量

```bash
# 列出所有环境变量
vercel env ls

# 查看特定变量（不显示值）
vercel env get NOTION_API_KEY
```

---

## 📊 下一步

配置完环境变量后：

1. ✅ **启用 GitHub Actions**
   - 访问：https://github.com/Beltran12138/industry-feeds/actions
   - 点击 "I understand my workflows, go ahead and enable them"

2. ✅ **配置 GitHub Secrets**（用于 Actions）
   - Settings → Secrets and variables → Actions
   - 添加相同的环境变量

3. ✅ **监控首次运行**
   - 查看 Vercel Logs
   - 检查 GitHub Actions 执行记录

---

## 🆘 常见问题

### Q: 环境变量不生效？
A: 确保选择了正确的环境（Production），并重新部署

### Q: 如何删除环境变量？
A: 使用 `vercel env rm VARIABLE_NAME`

### Q: 本地开发如何使用这些变量？
A: 运行 `vercel env pull` 拉取到 `.env.local` 文件

---

**准备好后，运行 `.\vercel-add-envs.bat` 开始配置！** 🚀
