"""
Alpha Radar — QClaw Skill
查询 Web3 行业动态，支持以下意图：
  - 最新重要信号
  - 按来源查询（Binance / OKX / HashKey 等）
  - 关键词搜索
  - 竞对动态（香港合规所 / 离岸所）
  - 数据统计 / 系统状态
"""

import json
import urllib.request
import urllib.parse
from datetime import datetime, timezone, timedelta
from openclaw.skills import register_skill

BASE_URL = "https://alpha-radar-eight.vercel.app"

# ── 工具函数 ─────────────────────────────────────────────────────────────────

def _fetch(path: str) -> dict:
    """调用 Vercel API，返回 JSON dict"""
    url = BASE_URL + path
    req = urllib.request.Request(url, headers={"Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=10) as resp:
        return json.loads(resp.read().decode())

def _fmt_time(ts_ms: int) -> str:
    """毫秒时间戳 → 北京时间字符串"""
    if not ts_ms:
        return "—"
    dt = datetime.fromtimestamp(ts_ms / 1000, tz=timezone(timedelta(hours=8)))
    return dt.strftime("%m-%d %H:%M")

def _fmt_item(item: dict, idx: int) -> str:
    """单条新闻格式化"""
    score = f"[{item.get('alpha_score',0)}分]" if item.get("alpha_score") else ""
    cat   = f"#{item.get('business_category','')}" if item.get("business_category") else ""
    src   = item.get("source", "")
    time  = _fmt_time(item.get("timestamp", 0))
    title = item.get("title", "（无标题）")
    detail = item.get("detail", "")
    detail_line = f"\n   └ {detail}" if detail else ""
    return f"{idx}. {score}{cat} [{src}] {time}\n   {title}{detail_line}"


# ── Skill 1：重要信号 ─────────────────────────────────────────────────────────

@register_skill(
    name="alpha_radar_important",
    description=(
        "查询 Web3/加密行业最新重要信号。"
        "当用户说"重要新闻"、"重要信号"、"今日要闻"、"高分情报"时触发。"
        "可附带数量，如"最新3条"，默认返回5条。"
    ),
    parameters={
        "limit": {
            "type": "integer",
            "description": "返回条数，默认5，最多20",
            "required": False,
        }
    },
)
def get_important_news(limit: int = 5) -> str:
    limit = max(1, min(20, limit))
    data = _fetch(f"/api/news?important=1&limit={limit}")
    items = data.get("data", [])
    if not items:
        return "📭 暂无重要信号，可能数据正在更新中。"
    lines = [f"🔔 最新 {len(items)} 条重要信号\n"]
    for i, item in enumerate(items, 1):
        lines.append(_fmt_item(item, i))
    return "\n".join(lines)


# ── Skill 2：按来源查询 ───────────────────────────────────────────────────────

@register_skill(
    name="alpha_radar_by_source",
    description=(
        "查询指定数据源的最新 Web3 行业动态。"
        "当用户提到具体交易所或机构名称时触发，如"Binance 最新动态"、"HashKey 新闻"、"OKX 今日消息"。"
        "支持的来源：Binance、OKX、Bybit、Gate、MEXC、Bitget、HTX、KuCoin、"
        "HashKeyGroup、HashKeyExchange、OSL、Exio、BlockBeats、TechFlow 等。"
    ),
    parameters={
        "source": {
            "type": "string",
            "description": "数据源名称，如 Binance、OKX、HashKeyGroup",
            "required": True,
        },
        "limit": {
            "type": "integer",
            "description": "返回条数，默认5",
            "required": False,
        },
    },
)
def get_news_by_source(source: str, limit: int = 5) -> str:
    limit = max(1, min(20, limit))
    encoded = urllib.parse.quote(source)
    data = _fetch(f"/api/news?source={encoded}&limit={limit}")
    items = data.get("data", [])
    if not items:
        return f"📭 【{source}】暂无数据，请确认来源名称是否正确。"
    lines = [f"📡 【{source}】最新 {len(items)} 条\n"]
    for i, item in enumerate(items, 1):
        lines.append(_fmt_item(item, i))
    return "\n".join(lines)


# ── Skill 3：关键词搜索 ───────────────────────────────────────────────────────

@register_skill(
    name="alpha_radar_search",
    description=(
        "在 Web3 行业动态库中搜索关键词。"
        "当用户说"搜索XXX"、"查一下XXX"、"有没有关于XXX的新闻"时触发。"
    ),
    parameters={
        "keyword": {
            "type": "string",
            "description": "搜索关键词，如 稳定币、RWA、SFC、牌照",
            "required": True,
        },
        "limit": {
            "type": "integer",
            "description": "返回条数，默认8",
            "required": False,
        },
    },
)
def search_news(keyword: str, limit: int = 8) -> str:
    limit = max(1, min(20, limit))
    encoded = urllib.parse.quote(keyword)
    data = _fetch(f"/api/news?q={encoded}&limit={limit}")
    items = data.get("data", [])
    if not items:
        return f"🔍 未找到关于「{keyword}」的相关动态。"
    lines = [f"🔍 「{keyword}」相关动态 {len(items)} 条\n"]
    for i, item in enumerate(items, 1):
        lines.append(_fmt_item(item, i))
    return "\n".join(lines)


# ── Skill 4：竞对动态 ─────────────────────────────────────────────────────────

@register_skill(
    name="alpha_radar_competitor",
    description=(
        "查询竞对交易所最新动态，分为香港合规所和离岸所两类。"
        "当用户说"竞对"、"香港合规所"、"离岸所"、"竞争对手"时触发。"
        "香港合规所 = HashKey、OSL、Exio；离岸所 = Binance、OKX、Bybit、Gate 等。"
    ),
    parameters={
        "category": {
            "type": "string",
            "description": "竞对类型：hk（香港合规所）或 offshore（离岸所），不填返回两类",
            "required": False,
        },
        "limit": {
            "type": "integer",
            "description": "每类返回条数，默认3",
            "required": False,
        },
    },
)
def get_competitor_news(category: str = "", limit: int = 3) -> str:
    limit = max(1, min(10, limit))

    HK_SOURCES      = ["HashKeyGroup", "HashKeyExchange", "OSL", "Exio"]
    OFFSHORE_SOURCES = ["Binance", "OKX", "Bybit", "Gate", "MEXC", "Bitget", "HTX", "KuCoin"]

    def fetch_source_items(sources, n):
        results = []
        for src in sources:
            encoded = urllib.parse.quote(src)
            d = _fetch(f"/api/news?source={encoded}&limit={n}")
            items = d.get("data", [])
            results.extend(items)
        results.sort(key=lambda x: x.get("timestamp", 0), reverse=True)
        return results[:n * 2]

    lines = []

    if category in ("", "hk"):
        hk_items = fetch_source_items(HK_SOURCES, limit)
        lines.append("🏦 香港合规所（HashKey/OSL/Exio）")
        if hk_items:
            for i, item in enumerate(hk_items[:limit], 1):
                lines.append(_fmt_item(item, i))
        else:
            lines.append("   暂无数据")
        lines.append("")

    if category in ("", "offshore"):
        off_items = fetch_source_items(OFFSHORE_SOURCES, limit)
        lines.append("🌊 头部离岸所（Binance/OKX/Bybit 等）")
        if off_items:
            for i, item in enumerate(off_items[:limit], 1):
                lines.append(_fmt_item(item, i))
        else:
            lines.append("   暂无数据")

    return "\n".join(lines) if lines else "暂无竞对数据"


# ── Skill 5：数据统计 ─────────────────────────────────────────────────────────

@register_skill(
    name="alpha_radar_stats",
    description=(
        "查询 Alpha Radar 系统数据统计和状态。"
        "当用户说"统计"、"数据库有多少条"、"系统状态"、"健康检查"时触发。"
    ),
    parameters={},
)
def get_stats() -> str:
    try:
        stats  = _fetch("/api/stats")
        health = _fetch("/api/health")
        d = stats.get("data", {})
        total     = d.get("total", 0)
        important = d.get("important", 0)
        sources   = d.get("sources", [])
        uptime    = health.get("uptime", 0)

        top_src = "、".join(
            f"{s['source']}({s['n']})" for s in sources[:5]
        ) if sources else "—"

        return (
            f"📊 Alpha Radar 数据统计\n"
            f"总条目：{total:,} 条\n"
            f"重要信号：{important:,} 条（占比 {important*100//total if total else 0}%）\n"
            f"活跃来源（Top5）：{top_src}\n"
            f"系统运行时长：{uptime//3600}h {uptime%3600//60}m"
        )
    except Exception as e:
        return f"⚠️ 查询失败：{e}"
