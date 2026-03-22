# Alpha Radar × QClaw Skill

通过微信消息查询 Web3 行业动态。

## 安装方法

1. 将 `alpha_radar.py` 复制到 QClaw 的技能目录：
   ```
   macOS:   ~/Library/Application Support/QClaw/skills/custom/
   Windows: %APPDATA%\QClaw\skills\custom\
   ```
2. 重启 QClaw，在 Agent 配置中启用以下技能：
   - `alpha_radar_important`
   - `alpha_radar_by_source`
   - `alpha_radar_search`
   - `alpha_radar_competitor`
   - `alpha_radar_stats`

## 使用示例

| 微信消息 | 触发技能 |
|----------|----------|
| 最新5条重要信号 | `alpha_radar_important` |
| 今日要闻 | `alpha_radar_important` |
| Binance 最新动态 | `alpha_radar_by_source` |
| HashKey 今日消息 | `alpha_radar_by_source` |
| 搜索稳定币新闻 | `alpha_radar_search` |
| 查一下 SFC 牌照 | `alpha_radar_search` |
| 竞对动态 | `alpha_radar_competitor` |
| 香港合规所最新消息 | `alpha_radar_competitor` |
| 系统状态 | `alpha_radar_stats` |
| 数据库有多少条 | `alpha_radar_stats` |

## 数据说明

- 数据来源：25 个 Web3 数据源（交易所官方公告 + 媒体 + KOL）
- 实时性：GitHub Actions 每 15 分钟自动抓取
- API 地址：`https://alpha-radar-eight.vercel.app`
