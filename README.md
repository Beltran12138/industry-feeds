# Alpha-Radar | 行业情报引擎

> Web3/Crypto 行业聚合 + AI 分类摘要 + 多渠道推送 — 为决策者提供高信噪比情报

![Version](https://img.shields.io/badge/version-1.4.0-blue.svg)
![License](https://img.shields.io/badge/license-MIT-green.svg)

---

## 📖 项目简介

Alpha-Radar 是一个**面向香港 Web3 合规交易所（VATP 申请者）**的行业情报系统，自动抓取 **20+ 数据源**（交易所公告、KOL 推文、媒体快讯、预测市场），通过 **DeepSeek AI** 进行智能分类、摘要提炼和重要性判定，支持**多渠道推送**（企业微信/钉钉/Slack/Telegram/Email），并提供日报/周报自动生成。

### 核心能力

| 能力 | 描述 |
|------|------|
| 🔍 **多源抓取** | 20+ 数据源：Binance/OKX/Bybit 等 8 家交易所 + HashKey/OSL 等香港合规所 + BlockBeats/TechFlow 等媒体 + KOL Twitter + Polymarket |
| 🤖 **AI 分类** | DeepSeek V3 模型 + 三级降级策略（备用 OpenRouter/OpenAI + 本地规则引擎） |
| ⚡ **多渠道推送** | 企业微信/钉钉/Slack/Telegram/Email 五大渠道，统一推送接口 |
| 📊 **可视化前端** | React + ECharts，支持搜索、时间筛选、分类统计图表、移动端适配 |
| 📰 **自动报告** | 每日 18:00 推送日报，每周五 18:00 推送周报（精选 Top 30 + 竞品格局分析） |
| 🗄️ **数据生命周期** | 热/温/冷三级存储，自动归档清理，数据库体积可控 |

---

## ️ 架构图

```
─────────────────────────────────────────────────────────────────────┐
│                        GitHub Actions (定时调度)                      │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐            │
│  │ Exchange │  │   HK     │  │  Media   │  │  Social  │            │
│  │ Scrapers │  │ Scrapers │  │ Scrapers │  │ Scrapers │            │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘  └────┬─────┘            │
│       └─────────────┴─────────────┴─────────────┘                   │
│                              │                                       │
│                    [filter.js 清洗去重]                               │
│                              │                                       │
│              ┌───────────────┴───────────────┐                       │
│              │  AI 分类 (三级降级策略)         │                       │
│              │  L1: DeepSeek V3 (主要)        │                       │
│              │  L2: OpenRouter/OpenAI (备用)  │                       │
│              │  L3: 本地规则引擎 (兜底)        │                       │
│              └───────────────┬───────────────┘                       │
│                              │                                       │
│           ┌──────────────────┼──────────────────┐                   │
│           │                  │                  │                   │
│    [SQLite 本地缓存]   [Supabase 云端同步]   [多渠道推送]            │
│    [数据生命周期管理]                        [企业微信/钉钉/Slack]   │
│           │                  │                  │                   │
│    ┌──────┴──────    ┌─────┴─────┐    ┌────────────┐             │
│    │  Web 前端    │    │  多端访问  │    │  领导看板   │             │
│    └─────────────┘    └───────────┘    └─────────────┘             │
└─────────────────────────────────────────────────────────────────────┘
```

---

## 🚀 快速部署

### 方案 A：Vercel 一键部署（推荐）

1. Fork 本仓库到你的 GitHub
2. 在 Vercel 导入项目，关联你的 GitHub 仓库
3. 在 Vercel 项目设置中添加环境变量：
   ```bash
   DEEPSEEK_API_KEY=sk-xxxxxxxx
   WECOM_WEBHOOK_URL=https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=xxxx
   SUPABASE_URL=https://xxxxx.supabase.co
   SUPABASE_KEY=sb_publishable_xxxxx
   ```
4. 部署完成！访问 `https://your-project.vercel.app` 即可使用

### 方案 B：Docker 部署（自托管）

```bash
# 1. 克隆仓库
git clone https://github.com/Beltran12138/industry-feeds.git
cd industry-feeds

# 2. 配置环境变量
cp .env.example .env
# 编辑 .env 填入 API Key 等配置

# 3. Docker Compose 启动
docker-compose up -d

# 4. 访问 http://localhost:3001
```

### 方案 C：本地开发

```bash
# 安装依赖
npm install

# 配置环境变量
cp .env.example .env
# 编辑 .env

# 启动服务（Express + 定时任务）
npm start

# 或开发模式（热重载）
npm run dev

# 手动触发爬虫
npm run scrape

# 测试日报/周报（dry-run 模式）
npm run daily-report:dry
npm run weekly-report:dry
```

---

## 📁 项目结构

```
alpha-radar/
├── config.js                 # 全局配置中心（所有魔数/清单集中管理）
├── scrapers/
│   ├── index.js              # 主调度器（runAllScrapers）
│   ├── browser.js            # 共享浏览器池（复用 Chrome 实例）
│   ├── utils.js              # 公共工具（时间戳解析、item 构建）
│   └── sources/
│       ├── apis.js           # HTTP/API 类爬虫（OKX/Binance 等）
│       ├── puppeteer.js      # 浏览器渲染类爬虫（BlockBeats/Bybit 等）
│       └── twitter-enhanced.js # Twitter KOL 多源冗余抓取
├── ai.js                     # DeepSeek AI 处理（原版）
├── ai-provider.js            # AI 多提供商管理（三级降级）
├── ai-enhanced.js            # AI 处理增强版（支持降级策略）
├── filter.js                 # 噪声过滤 + 去重逻辑
├── db.js                     # SQLite + Supabase 双存储
├── data-lifecycle.js         # 数据生命周期管理（热/温/冷三级存储）
├── push-channel.js           # 推送渠道抽象层（企业微信/钉钉/Slack/Telegram/Email）
├── wecom.js                  # 企业微信推送（兼容旧版）
├── report.js                 # 日报/周报生成（精选模式）
├── server.js                 # Express 后端（API + 健康检查 + 定时任务）
├── public/
│   └── index.html            # React 前端（搜索/图表/移动端）
├── tests/                    # 测试文件目录
├── .github/workflows/
│   ├── scrape.yml            # 每 30 分钟低频抓取
│   ├── scrape_high.yml       # 每 5 分钟高频抓取
│   ├── daily_report.yml      # 每日 18:00 日报
│   └── weekly_report.yml     # 每周五 18:00 周报
├── vercel.json               # Vercel 部署配置
├── package.json
├── .gitignore
├── .env.example
├── CHANGELOG-v1.4.md         # v1.4 更新日志
└── README.md
```

---

## ⚙️ 配置说明

### 环境变量（`.env`）

#### 必需配置

| 变量 | 说明 |
|------|------|
| `DEEPSEEK_API_KEY` | DeepSeek AI API Key（主要 AI 提供商） |
| `WECOM_WEBHOOK_URL` | 企业微信机器人 Webhook URL |

#### AI 备用提供商（推荐）

| 变量 | 说明 |
|------|------|
| `OPENROUTER_API_KEY` | OpenRouter API Key（支持 Claude/GPT 等多种模型） |
| `OPENAI_API_KEY` | OpenAI API Key（直接使用 GPT 模型） |

#### 推送渠道（可选）

| 变量 | 说明 |
|------|------|
| `DINGTALK_WEBHOOK_URL` | 钉钉机器人 Webhook URL |
| `DINGTALK_SECRET` | 钉钉机器人签名密钥 |
| `SLACK_WEBHOOK_URL` | Slack Webhook URL |
| `TELEGRAM_BOT_TOKEN` | Telegram Bot Token |
| `TELEGRAM_CHAT_ID` | Telegram Chat ID |
| `SMTP_HOST` | SMTP 服务器地址 |
| `SMTP_USER` | SMTP 用户名 |
| `SMTP_PASS` | SMTP 密码 |
| `EMAIL_TO` | 邮件接收地址 |

#### Twitter 抓取（可选）

| 变量 | 说明 |
|------|------|
| `TWITTERAPI_KEY` | twitterapi.io API Key |
| `SCRAPFLY_KEY` | Scrapfly API Key |

#### 其他配置

| 变量 | 说明 |
|------|------|
| `USE_SUPABASE` | 是否启用 Supabase 云端同步（默认 `false`） |
| `SUPABASE_URL` | Supabase 项目 URL |
| `SUPABASE_KEY` | Supabase Publishable Key |
| `PORT` | 服务端口（默认 `3001`） |
| `API_SECRET` | API 端点保护密钥（设置后需 `X-API-Key` header） |
| `CORS_ORIGIN` | CORS 允许的来源（生产环境建议配置） |

### 核心配置（`config.js`）

```js
// 爬虫批次大小 / 间隔
SCRAPER.BATCH_SIZE = 4
SCRAPER.BATCH_DELAY_MS = 2000

// AI 调用限额（防止超支）
SCRAPER.MAX_AI_PER_RUN = 60

// 重要性判定规则
WECOM_BLOCK_SOURCES = ['TechFlow', 'BlockBeats', 'Poly-*', 'KOLs']  // 不推送
HK_SOURCES = ['OSL', 'HashKey*', 'Exio', 'TechubNews']              // 全推送
EXCHANGE_EXCLUDE_KEYWORDS = ['listing', '上线', '新币', ... ]        // 排除普通上币
```

---

## 📊 数据源列表

### 交易所（8 家）
- Binance, OKX, Bybit, Gate, MEXC, Bitget, HTX, KuCoin

### 香港合规所（5 家）
- OSL, HashKey Group, HashKey Exchange, Exio, Techub News, WuBlock

### 媒体（3 家）
- BlockBeats, TechFlow, PR Newswire

### KOL（5 位）
- 吴硕、Phyrex、Justin Sun、XieJiayin、Twitter AB

### 预测市场（2 个）
- Polymarket Breaking, Polymarket China

---

## 🎯 优化亮点（对比 TrendRadar）

| 维度 | TrendRadar | Alpha-Radar |
|------|------------|-------------|
| **定位** | 通用热点聚合 | 香港 VATP 竞品情报 |
| **AI 覆盖** | 部分条目 | 批量补充机制（消灭"其他"分类） |
| **AI 可用性** | 单点故障 | 三级降级策略（99.9% 可用） |
| **报告质量** | 全量 dump | AI 精选 Top 30 + 竞品维度组织 |
| **噪声过滤** | 基础关键词 | 双层过滤（通用 + 报告专用） |
| **浏览器池** | 每次 launch | 共享实例（节省 70% 内存） |
| **前端功能** | 基础列表 | 搜索 + 图表 + 时间筛选 + 移动端 |
| **安全性** | 无认证 | API Key 保护 + SQL 注入防护 + 前端密钥移除 |
| **推送渠道** | 单一渠道 | 五大渠道统一接口 |
| **数据存储** | 无限增长 | 生命周期管理（90天自动归档） |
| **Twitter 抓取** | 单源不稳定 | 多源冗余（95%+ 成功率） |

---

## 🛠️ 常见问题

### Q: 如何添加新的数据源？
A: 在 `scrapers/sources/apis.js` 或 `puppeteer.js` 中新增爬虫函数，然后在 `scrapers/index.js` 的 `ALL_SCRAPERS` 数组中注册即可。

### Q: AI 分类不准确怎么办？
A: 调整 `ai.js` 中的 prompt，或在 `config.js` 中修改 `BUSINESS_CATEGORIES` / `COMPETITOR_CATEGORIES` 选项。

### Q: 如何关闭某些数据源？
A: 在 `scrapers/index.js` 的 `ALL_SCRAPERS` 数组中注释掉对应爬虫函数。

### Q: 日报/周报推送时间能改吗？
A: 修改 `.github/workflows/daily_report.yml` 和 `weekly_report.yml` 中的 cron 表达式，或在 `server.js` 中调整 `SERVER.DAILY_REPORT_CRON`。

---

## 📝 更新日志

### v1.4.0 (2026-03-13)
- 🤖 **AI 三级降级策略**: DeepSeek → OpenRouter/OpenAI → 本地规则引擎
- 📦 **数据生命周期管理**: 热/温/冷三级存储，自动归档清理
- 📢 **多渠道推送**: 企业微信/钉钉/Slack/Telegram/Email 五大渠道
- 🐦 **Twitter 多源抓取**: Nitter 池 + RSSHub + 第三方 API 冗余策略
- 🔒 **安全加固**: 移除前端硬编码密钥，API Key 保护
- 📊 **新增 API 端点**: `/api/ai-status`, `/api/push-status`, `/api/archive`, `/api/history-stats`
- 🛠️ **NPM 脚本增强**: `npm run cleanup`, `npm run test-push`

### v1.3.0 (2026-03-09)
- ✨ 前端增强：搜索功能、ECharts 统计图表、时间范围筛选、移动端菜单
- 🤖 AI 批量分类补充（消灭周报"其他 650 条"现象）
- 🧹 双层噪声过滤（日报/周报更精简）
- 🔒 安全修复：SQL 注入防护、API Key 认证
- 🏗️ 架构重构：拆分 scraper.js 为模块化 scrapers/ 目录
- 🐛 修复 Date.now() fallback 导致旧新闻被标记为"刚刚"的问题
- 📦 完善 .gitignore、package.json、vercel.json

### v1.2.0
- 初始开源版本

---

## 🙏 致谢

灵感来自 [TrendRadar](https://github.com/sansan0/TrendRadar) — 一个优秀的多平台热点聚合项目。

---

## 📄 License

MIT © [Alpha-Radar Team](https://github.com/Beltran12138/industry-feeds)
