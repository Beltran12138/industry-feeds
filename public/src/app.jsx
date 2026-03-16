const { useState, useEffect, useCallback, useRef, useMemo } = React;

  // ── Dark Mode Hook ─────────────────────────────────────────────────────────
  function useDarkMode() {
    const [dark, setDark] = useState(() => {
      const saved = localStorage.getItem('darkMode');
      if (saved !== null) return saved === 'true';
      return window.matchMedia('(prefers-color-scheme: dark)').matches;
    });
    useEffect(() => {
      document.documentElement.classList.toggle('dark', dark);
      localStorage.setItem('darkMode', dark);
    }, [dark]);
    return [dark, setDark];
  }

  // ── Export Modal Component ────────────────────────────────────────────────
  function ExportModal({ news, onClose }) {
    const [format, setFormat] = useState('csv');
    const [days, setDays] = useState(7);
    const [exporting, setExporting] = useState(false);

    const handleExport = async () => {
      setExporting(true);
      try {
        if (format === 'csv') {
          window.open(`/api/export?format=csv&days=${days}`, '_blank');
        } else if (format === 'json') {
          const res = await fetch(`/api/export?format=json&days=${days}`);
          const data = await res.json();
          const blob = new Blob([JSON.stringify(data.data, null, 2)], { type: 'application/json' });
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url; a.download = `alpha-radar-${days}d.json`; a.click();
          URL.revokeObjectURL(url);
        } else if (format === 'clipboard') {
          const since = Date.now() - days * 86400000;
          const filtered = news.filter(n => (n.timestamp || 0) >= since);
          const text = filtered.map(n =>
            `[${n.source}] ${n.title}${n.detail ? ' - ' + n.detail : ''} (${n.business_category || ''})`
          ).join('\n');
          await navigator.clipboard.writeText(text);
          alert('已复制到剪贴板');
        }
        onClose();
      } catch (err) {
        console.error('Export error:', err);
        alert('导出失败: ' + err.message);
      } finally {
        setExporting(false);
      }
    };

    return (
      <div className="modal-overlay" onClick={onClose}>
        <div className="modal-content" onClick={e => e.stopPropagation()}>
          <div className="flex justify-between items-center mb-6">
            <h2 className="text-lg font-black">导出数据</h2>
            <button onClick={onClose} className="p-2 hover:bg-slate-100 rounded-lg"><i className="fa-solid fa-xmark"/></button>
          </div>

          <div className="space-y-4">
            <div>
              <label className="text-xs font-bold text-slate-500 uppercase tracking-wider mb-2 block">导出格式</label>
              <div className="flex gap-2">
                {[['csv','CSV'], ['json','JSON'], ['clipboard','剪贴板']].map(([val, lbl]) => (
                  <button key={val} onClick={() => setFormat(val)}
                    className={`px-4 py-2 rounded-xl text-sm font-medium transition-all ${
                      format === val ? 'bg-blue-500 text-white' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                    }`}>{lbl}</button>
                ))}
              </div>
            </div>

            <div>
              <label className="text-xs font-bold text-slate-500 uppercase tracking-wider mb-2 block">时间范围</label>
              <div className="flex gap-2">
                {[1, 7, 14, 30, 90].map(d => (
                  <button key={d} onClick={() => setDays(d)}
                    className={`px-3 py-2 rounded-xl text-sm font-medium transition-all ${
                      days === d ? 'bg-blue-500 text-white' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                    }`}>{d}天</button>
                ))}
              </div>
            </div>

            <button onClick={handleExport} disabled={exporting}
              className="w-full py-3 bg-blue-500 hover:bg-blue-600 text-white rounded-xl font-bold text-sm transition-colors disabled:opacity-50">
              {exporting ? '导出中...' : '导出'}
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ── Monitoring Panel Component ──────────────────────────────────────────────
  function MonitoringPanel() {
    const [data, setData] = useState(null);
    const [quality, setQuality] = useState(null);
    const [cacheStats, setCacheStats] = useState(null);

    useEffect(() => {
      Promise.all([
        fetch('/api/monitoring').then(r => r.json()).catch(() => null),
        fetch('/api/quality').then(r => r.json()).catch(() => null),
        fetch('/api/cache-status').then(r => r.json()).catch(() => null),
      ]).then(([mon, qual, cache]) => {
        if (mon?.success) setData(mon.data);
        if (qual?.success) setQuality(qual.data);
        if (cache?.success) setCacheStats(cache.data);
      });
    }, []);

    return (
      <div className="p-6 md:p-10 space-y-6">
        <header className="mb-4">
          <h2 className="text-2xl font-black tracking-tight">
            <i className="fa-solid fa-heart-pulse text-red-400 mr-2"></i>
            系统监控
          </h2>
        </header>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {/* AI Provider Status */}
          <div className="depth-card p-6 rounded-2xl">
            <h3 className="text-xs font-black uppercase tracking-wider text-slate-400 mb-4">
              <i className="fa-solid fa-brain mr-1"></i> AI 状态
            </h3>
            {data?.ai ? (
              <div className="space-y-3">
                <div className="flex justify-between">
                  <span className="text-sm">当前提供商</span>
                  <span className="text-sm font-bold">{data.ai.current}</span>
                </div>
                {data.ai.degradedAt && (
                  <div className="text-xs text-amber-500 font-medium">
                    <i className="fa-solid fa-triangle-exclamation mr-1"></i>
                    已降级 {Math.floor((Date.now() - data.ai.degradedAt) / 3600000)}h
                  </div>
                )}
                <div className="text-xs text-slate-400">
                  降级历史: {data.ai.history?.length || 0} 次
                </div>
              </div>
            ) : (
              <p className="text-sm text-slate-400">数据加载中...</p>
            )}
          </div>

          {/* Data Quality */}
          <div className="depth-card p-6 rounded-2xl">
            <h3 className="text-xs font-black uppercase tracking-wider text-slate-400 mb-4">
              <i className="fa-solid fa-shield-check mr-1"></i> 数据质量
            </h3>
            {quality ? (
              <div className="space-y-3">
                <div className="flex justify-between">
                  <span className="text-sm">已验证</span>
                  <span className="text-sm font-bold">{quality.total}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-sm">通过率</span>
                  <span className="text-sm font-bold text-emerald-500">
                    {quality.total > 0 ? ((quality.passed / quality.total) * 100).toFixed(0) : 0}%
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-sm">失败</span>
                  <span className="text-sm font-bold text-red-500">{quality.failed}</span>
                </div>
              </div>
            ) : (
              <p className="text-sm text-slate-400">暂无数据</p>
            )}
          </div>

          {/* Cache Stats */}
          <div className="depth-card p-6 rounded-2xl">
            <h3 className="text-xs font-black uppercase tracking-wider text-slate-400 mb-4">
              <i className="fa-solid fa-database mr-1"></i> 查询缓存
            </h3>
            {cacheStats ? (
              <div className="space-y-3">
                <div className="flex justify-between">
                  <span className="text-sm">命中率</span>
                  <span className="text-sm font-bold text-blue-500">{cacheStats.hitRate}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-sm">缓存条目</span>
                  <span className="text-sm font-bold">{cacheStats.size} / {cacheStats.maxEntries}</span>
                </div>
              </div>
            ) : (
              <p className="text-sm text-slate-400">暂无数据</p>
            )}
          </div>
        </div>

        {/* Scraper Status Table */}
        {data?.scrapers && Object.keys(data.scrapers).length > 0 && (
          <div className="depth-card p-6 rounded-2xl">
            <h3 className="text-xs font-black uppercase tracking-wider text-slate-400 mb-4">
              <i className="fa-solid fa-spider mr-1"></i> 爬虫状态
            </h3>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-xs text-slate-400 uppercase tracking-wider border-b border-slate-100">
                    <th className="text-left py-2 pr-4">数据源</th>
                    <th className="text-right py-2 px-3">成功率</th>
                    <th className="text-right py-2 px-3">总条目</th>
                    <th className="text-right py-2 px-3">连续失败</th>
                    <th className="text-right py-2 pl-3">最后错误</th>
                  </tr>
                </thead>
                <tbody>
                  {Object.entries(data.scrapers).map(([source, s]) => (
                    <tr key={source} className="border-b border-slate-50">
                      <td className="py-2 pr-4 font-medium">{source}</td>
                      <td className="text-right py-2 px-3">
                        <span className={`font-bold ${parseFloat(s.successRate) >= 80 ? 'text-emerald-500' : 'text-red-500'}`}>
                          {s.successRate}
                        </span>
                      </td>
                      <td className="text-right py-2 px-3">{s.totalItems}</td>
                      <td className="text-right py-2 px-3">
                        {s.consecutive > 0 && <span className="text-red-500 font-bold">{s.consecutive}</span>}
                        {s.consecutive === 0 && <span className="text-slate-300">0</span>}
                      </td>
                      <td className="text-right py-2 pl-3 text-xs text-slate-400 max-w-[200px] truncate">
                        {s.lastError || '-'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* Recent Errors */}
        {data?.recentErrors?.length > 0 && (
          <div className="depth-card p-6 rounded-2xl">
            <h3 className="text-xs font-black uppercase tracking-wider text-red-400 mb-4">
              <i className="fa-solid fa-circle-exclamation mr-1"></i> 近期错误
            </h3>
            <div className="space-y-2 max-h-64 overflow-y-auto scrollbar-hide">
              {data.recentErrors.map((err, i) => (
                <div key={i} className="text-xs p-3 bg-red-50 dark:bg-red-950 rounded-xl border border-red-100 dark:border-red-900">
                  <span className="font-bold text-red-600 mr-2">[{err.category}]</span>
                  <span className="text-red-500">{err.message}</span>
                  <span className="text-slate-400 ml-2">{new Date(err.ts).toLocaleTimeString('zh-CN')}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    );
  }

  // ── 配置 ────────────────────────────────────────────────────────────────────
  // 所有数据通过 /api/* 服务端代理获取，无需前端直连 Supabase
  // 云端同步（书签/已读）通过 /api/sync 接口实现
  const isLocal = ['localhost', '127.0.0.1'].includes(window.location.hostname);

  // 云端同步通过 API 代理，不再需要前端 Supabase 客户端
  let sbClient = null;

  const SOURCE_GROUPS = {
    EXCHANGE: ['Binance','OKX','Bybit','Gate','MEXC','Bitget','HTX','KuCoin'],
    MARKET:   ['Poly-Breaking','Poly-China'],
    SOCIAL:   ['WuShuo','Phyrex','JustinSun','XieJiayin','TwitterAB'],
    MEDIA:    ['BlockBeats','TechFlow','PRNewswire','HashKeyGroup','WuBlock','OSL','HashKeyExchange','Exio','TechubNews'],
  };

  const SOURCES = [
    { id:'All',            label:'全部动态',       icon:'fa-layer-group', group:'CORE' },
    { id:'Important',      label:'重要信号',        icon:'fa-bolt',        group:'CORE' },
    { id:'Binance',        label:'Binance',         icon:'fa-b',           group:'EXCHANGE' },
    { id:'OKX',            label:'OKX',             icon:'fa-circle-dot',  group:'EXCHANGE' },
    { id:'Bybit',          label:'Bybit',           icon:'fa-circle',      group:'EXCHANGE' },
    { id:'Gate',           label:'Gate.io',         icon:'fa-g',           group:'EXCHANGE' },
    { id:'MEXC',           label:'MEXC',            icon:'fa-m',           group:'EXCHANGE' },
    { id:'Bitget',         label:'Bitget',          icon:'fa-coins',       group:'EXCHANGE' },
    { id:'HTX',            label:'HTX',             icon:'fa-h',           group:'EXCHANGE' },
    { id:'KuCoin',         label:'KuCoin',          icon:'fa-k',           group:'EXCHANGE' },
    { id:'Poly-Breaking',  label:'Poly 突发',       icon:'fa-chart-line',  group:'MARKET' },
    { id:'Poly-China',     label:'Poly 中国',       icon:'fa-flag',        group:'MARKET' },
    { id:'WuShuo',         label:'吴说',            icon:'fa-brands fa-x-twitter', group:'SOCIAL' },
    { id:'Phyrex',         label:'Phyrex',          icon:'fa-brands fa-x-twitter', group:'SOCIAL' },
    { id:'JustinSun',      label:'Justin Sun',      icon:'fa-brands fa-x-twitter', group:'SOCIAL' },
    { id:'XieJiayin',      label:'XieJiayin',       icon:'fa-brands fa-x-twitter', group:'SOCIAL' },
    { id:'TwitterAB',      label:'Twitter AB',      icon:'fa-brands fa-x-twitter', group:'SOCIAL' },
    { id:'BlockBeats',     label:'BlockBeats',      icon:'fa-newspaper',   group:'MEDIA' },
    { id:'TechFlow',       label:'TechFlow',        icon:'fa-newspaper',   group:'MEDIA' },
    { id:'PRNewswire',     label:'PR Newswire',     icon:'fa-newspaper',   group:'MEDIA' },
    { id:'HashKeyGroup',   label:'HashKey Group',   icon:'fa-building',    group:'MEDIA' },
    { id:'WuBlock',        label:'WuBlock',         icon:'fa-newspaper',   group:'MEDIA' },
    { id:'OSL',            label:'OSL',             icon:'fa-building',    group:'MEDIA' },
    { id:'HashKeyExchange',label:'HashKey Exchange',icon:'fa-building',    group:'MEDIA' },
    { id:'Exio',           label:'EX.IO',           icon:'fa-building',    group:'MEDIA' },
    { id:'TechubNews',     label:'Techub News',     icon:'fa-newspaper',   group:'MEDIA' },
  ];
  const NAV_GROUPS = ['CORE','EXCHANGE','MARKET','SOCIAL','MEDIA'];

  function getSourceStyle(src) {
    if (SOURCE_GROUPS.EXCHANGE.includes(src)) return 'bg-slate-800 text-white';
    if (SOURCE_GROUPS.MARKET.includes(src))   return 'bg-purple-600 text-white';
    if (SOURCE_GROUPS.SOCIAL.includes(src))   return 'bg-sky-500 text-white';
    return 'bg-slate-200 text-slate-700';
  }

  // ── Alpha Score 徽章 ──────────────────────────────────────────────────────
  function ScoreBadge({ score }) {
    if (!score && score !== 0) return null;
    let cls, icon;
    if (score >= 90) {
      cls = 'score-critical';
      icon = '\uD83D\uDD25'; // fire
    } else if (score >= 70) {
      cls = 'score-high';
      icon = '\u2B50'; // star
    } else {
      cls = 'score-medium';
      icon = '\uD83D\uDCE1'; // satellite
    }
    return (
      <span className={`text-[11px] px-2 py-0.5 rounded-md font-mono ${cls}`}>
        {icon} {score}
      </span>
    );
  }

  // ── 搜索高亮辅助 ───────────────────────────────────────────────────────────
  function highlight(text, q) {
    if (!q || !text) return text;
    const parts = text.split(new RegExp(`(${q.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')})`, 'gi'));
    return parts.map((p, i) => p.toLowerCase() === q.toLowerCase()
      ? <mark key={i}>{p}</mark>
      : p
    );
  }

  // ── 行业记忆 (Insights) 组件 ──────────────────────────────────────────
  function InsightsPanel() {
    const [insights, setInsights] = useState([]);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
      fetch('/api/insights')
        .then(r => r.json())
        .then(d => { if (d.success) setInsights(d.data); })
        .catch(() => {})
        .finally(() => setLoading(false));
    }, []);

    if (loading) return <div className="p-8 text-center text-slate-400">洞察加载中...</div>;
    if (insights.length === 0) return null;

    return (
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 mb-8">
        {insights.map(i => (
          <div key={i.id} className="depth-card p-5 rounded-2xl border-l-4 border-l-indigo-500 bg-indigo-50/30">
            <div className="flex justify-between items-start mb-2">
              <span className="text-[10px] font-black uppercase text-indigo-500 tracking-wider">
                <i className="fa-solid fa-brain mr-1"></i> 行业共识
              </span>
              <span className="text-[10px] font-bold text-slate-400">引证 {i.evidence_count} 次</span>
            </div>
            <h3 className="text-sm font-black text-slate-800 mb-2">{i.trend_key}</h3>
            <p className="text-xs text-slate-600 leading-relaxed italic">"{i.summary}"</p>
          </div>
        ))}
      </div>
    );
  }

  // ── 动态竞速图组件 ─────────────────────────────────────────────────────────
  function StatsChart({ news }) {
    const containerRef = useRef(null);

    useEffect(() => {
      if (!containerRef.current || !news.length) return;
      const chart = echarts.init(containerRef.current);

      // 准备动态增长数据（按时间排序后累加）
      const sortedNews = [...news].sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
      const categories = [...new Set(news.map(n => n.business_category || '其他'))];
      
      const updateData = () => {
        const catMap = {};
        categories.forEach(c => catMap[c] = 0);
        
        // 此处仅展示静态汇总，但增加了入场动画
        news.forEach(n => { const c = n.business_category || '其他'; catMap[c] = (catMap[c] || 0) + 1; });
        const sorted = Object.entries(catMap).sort((a,b) => a[1]-b[1]);

        chart.setOption({
          animationDuration: 2000,
          backgroundColor: 'transparent',
          grid: { left: '15%', right: '10%', top: '5%', bottom: '5%' },
          xAxis: { type: 'value', splitLine: { show: false } },
          yAxis: { 
            type: 'category', 
            data: sorted.map(([c]) => c),
            axisLabel: { fontWeight: 'bold' },
            inverse: false
          },
          series: [{
            type: 'bar',
            data: sorted.map(([,n]) => n),
            realtimeSort: true,
            seriesLayoutBy: 'column',
            itemStyle: {
              color: function(param) {
                const colors = ['#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6'];
                return colors[param.dataIndex % colors.length];
              },
              borderRadius: [0, 4, 4, 0]
            },
            label: { show: true, position: 'right', valueAnimation: true }
          }]
        });
      };

      updateData();
      const ro = new ResizeObserver(() => chart.resize());
      ro.observe(containerRef.current);
      return () => { chart.dispose(); ro.disconnect(); };
    }, [news]);

    return <div ref={containerRef} style={{ height:'400px', width:'100%' }} />;
  }

  // ── 趋势折线图组件 ─────────────────────────────────────────────────────────
  function TrendChart({ days = 7 }) {
    const containerRef = useRef(null);
    const [trendData, setTrendData] = useState(null);
    const [trendDays, setTrendDays] = useState(days);

    useEffect(() => {
      fetch(`/api/trend?days=${trendDays}`)
        .then(r => r.json())
        .then(d => { if (d.success) setTrendData(d.data); })
        .catch(e => console.error('[Trend]', e));
    }, [trendDays]);

    useEffect(() => {
      if (!containerRef.current || !trendData || !trendData.length) return;
      const chart = echarts.init(containerRef.current);

      // Group by category, build series
      const catMap = {};
      trendData.forEach(r => {
        const cat = r.category || '其他';
        if (!catMap[cat]) catMap[cat] = {};
        catMap[cat][r.date] = (catMap[cat][r.date] || 0) + r.count;
      });

      // Unique sorted dates
      const dates = [...new Set(trendData.map(r => r.date))].sort();
      // Top 6 categories by total count
      const catTotals = Object.entries(catMap).map(([cat, dateMap]) => ({
        cat, total: Object.values(dateMap).reduce((a, b) => a + b, 0)
      })).sort((a, b) => b.total - a.total).slice(0, 6);

      const colors = ['#3b82f6', '#ef4444', '#10b981', '#f59e0b', '#8b5cf6', '#ec4899'];
      const series = catTotals.map(({ cat }, i) => ({
        name: cat,
        type: 'line',
        smooth: true,
        symbol: 'circle',
        symbolSize: 6,
        data: dates.map(d => catMap[cat]?.[d] || 0),
        lineStyle: { width: 2.5 },
        itemStyle: { color: colors[i % colors.length] },
      }));

      chart.setOption({
        backgroundColor: 'transparent',
        tooltip: { trigger: 'axis' },
        legend: { data: catTotals.map(c => c.cat), bottom: 0, textStyle: { fontSize: 11 } },
        grid: { left: '5%', right: '5%', top: '8%', bottom: '18%', containLabel: true },
        xAxis: {
          type: 'category', data: dates, boundaryGap: false,
          axisLabel: { fontSize: 11, color: '#64748b', formatter: v => v.slice(5) },
        },
        yAxis: { type: 'value', splitLine: { lineStyle: { color: '#f1f5f9' } } },
        series,
      });

      const ro = new ResizeObserver(() => chart.resize());
      ro.observe(containerRef.current);
      return () => { chart.dispose(); ro.disconnect(); };
    }, [trendData]);

    return (
      <div>
        <div className="flex gap-2 mb-4">
          {[7, 14, 30].map(d => (
            <button key={d} onClick={() => setTrendDays(d)}
              className={`px-3 py-1 rounded-lg text-xs font-medium transition-all ${
                trendDays === d ? 'bg-blue-500 text-white' : 'bg-slate-100 text-slate-500 hover:bg-slate-200'
              }`}>
              {d}天
            </button>
          ))}
        </div>
        <div ref={containerRef} style={{ height: '360px', width: '100%' }} />
      </div>
    );
  }

  // ── 竞对雷达组件 ───────────────────────────────────────────────────────────
  function CompetitorRadar({ news }) {
    // Group by competitor_category
    const grouped = useMemo(() => {
      const map = {};
      const now = Date.now();
      const weekAgo = now - 7 * 24 * 3600 * 1000;

      news.forEach(n => {
        const cat = n.competitor_category;
        if (!cat || cat === '其他') return;
        if (!map[cat]) map[cat] = { items: [], recent: 0, total: 0 };
        map[cat].items.push(n);
        map[cat].total++;
        if ((n.timestamp || 0) >= weekAgo) map[cat].recent++;
      });

      return Object.entries(map)
        .sort((a, b) => b[1].recent - a[1].recent)
        .map(([cat, data]) => ({
          category: cat,
          recent: data.recent,
          total: data.total,
          items: data.items
            .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0))
            .slice(0, 10),
        }));
    }, [news]);

    const heatColor = (count) => {
      if (count >= 20) return 'bg-red-500 text-white';
      if (count >= 10) return 'bg-orange-400 text-white';
      if (count >= 5)  return 'bg-yellow-300 text-yellow-900';
      return 'bg-slate-200 text-slate-600';
    };

    return (
      <div className="space-y-6">
        {/* 热力图概览 */}
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
          {grouped.map(g => (
            <div key={g.category} className="depth-card p-4 rounded-xl">
              <div className="flex items-center justify-between mb-2">
                <span className="text-sm font-bold text-slate-700">{g.category}</span>
                <span className={`text-xs font-bold px-2 py-0.5 rounded-full ${heatColor(g.recent)}`}>
                  {g.recent}
                </span>
              </div>
              <p className="text-[10px] text-slate-400">近7天 {g.recent} 条 / 总计 {g.total} 条</p>
            </div>
          ))}
        </div>

        {/* 各竞对详情 */}
        {grouped.map(g => (
          <div key={g.category} className="depth-card p-6 rounded-2xl">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-base font-bold text-slate-800">
                <i className="fa-solid fa-crosshairs text-red-400 mr-2 text-sm"></i>
                {g.category}
              </h3>
              <span className="text-xs text-slate-400 font-medium">近7天 {g.recent} 条动态</span>
            </div>
            <div className="space-y-3">
              {g.items.map(item => (
                <a key={item.id} href={item.url} target="_blank" rel="noopener noreferrer"
                  className="block p-3 bg-slate-50 hover:bg-slate-100 rounded-xl transition-colors group">
                  <div className="flex items-start gap-2">
                    <div className="flex-1">
                      <h4 className="text-sm font-medium text-slate-700 group-hover:text-blue-600 line-clamp-1">
                        {item.title}
                      </h4>
                      {item.detail && (
                        <p className="text-xs text-slate-400 mt-1 line-clamp-1">{item.detail}</p>
                      )}
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      {item.alpha_score > 0 && <ScoreBadge score={item.alpha_score} />}
                      <span className="text-[10px] text-slate-400">{item.source}</span>
                    </div>
                  </div>
                </a>
              ))}
            </div>
          </div>
        ))}

        {grouped.length === 0 && (
          <div className="text-center py-24 text-slate-300 italic font-medium">
            暂无竞对数据（需要 competitor_category 字段）
          </div>
        )}
      </div>
    );
  }

  // ── 数据源健康看板组件 ─────────────────────────────────────────────────────
  function SourceHealthPanel() {
    const [healthData, setHealthData] = useState([]);
    useEffect(() => {
      fetch('/api/source-health')
        .then(r => r.json())
        .then(d => { if (d.success) setHealthData(d.data); })
        .catch(() => {});
    }, []);

    if (!healthData.length) return null;

    return (
      <div className="depth-card p-4 rounded-xl mb-6">
        <h3 className="text-[10px] font-black text-slate-400 uppercase tracking-[.15em] mb-3">
          <i className="fa-solid fa-signal mr-1"></i>数据源状态
        </h3>
        <div className="grid grid-cols-2 gap-1.5">
          {healthData.slice(0, 12).map(s => (
            <div key={s.source} className="flex items-center justify-between text-[10px] px-2 py-1 rounded-md bg-slate-50">
              <span className="text-slate-600 font-medium truncate max-w-[80px]">{s.source}</span>
              <div className="flex items-center gap-1">
                <span className={`w-1.5 h-1.5 rounded-full ${s.status === 'healthy' ? 'bg-emerald-500' : 'bg-red-500 animate-pulse'}`}></span>
                <span className={`font-bold ${s.status === 'healthy' ? 'text-emerald-500' : 'text-red-500'}`}>
                  {s.hours_since_update}h
                </span>
              </div>
            </div>
          ))}
        </div>
      </div>
    );
  }

  // ── 主应用 ─────────────────────────────────────────────────────────────────
  function App() {
    const [allNews, setAllNews]         = useState([]);
    const [displayNews, setDisplayNews] = useState([]);
    const [loading, setLoading]         = useState(true);
    const [activeFilter, setActiveFilter] = useState('All');
    const [search, setSearch]           = useState('');
    const [searchInput, setSearchInput] = useState('');
    const [timeRange, setTimeRange]     = useState('month'); // today|week|month|all
    const [readIds, setReadIds]         = useState(new Set(JSON.parse(localStorage.getItem('readIds')||'[]')));
    const [bookmarks, setBookmarks]     = useState(new Set(JSON.parse(localStorage.getItem('bookmarks')||'[]')));
    const [syncCode, setSyncCode]       = useState(localStorage.getItem('syncCode') || '');
    const [syncInput, setSyncInput]     = useState('');
    const [isSyncing, setIsSyncing]     = useState(false);
    const [countdown, setCountdown]     = useState(300);
    const [viewMode, setViewMode]       = useState('feed'); // feed|chart|competitor|trend|monitor
    const [menuOpen, setMenuOpen]       = useState(false);
    const [health, setHealth]           = useState(null);
    const [lastUpdateTime, setLastUpdateTime] = useState(null);
    const [focusIdx, setFocusIdx]       = useState(-1);
    const [showExport, setShowExport]   = useState(false);
    const [dark, setDark]               = useDarkMode();
    const searchInputRef                = useRef(null);
    const feedContainerRef              = useRef(null);

    // 实时计数
    const counts = useMemo(() => {
      const c = { All: allNews.length, Important: allNews.filter(n=>n.is_important===1).length };
      allNews.forEach(n => { c[n.source] = (c[n.source]||0)+1; });
      return c;
    }, [allNews]);

    // 时间范围筛选
    const timeFilterTs = useMemo(() => {
      const now = Date.now();
      if (timeRange === 'today') return now - 86400000;
      if (timeRange === 'week')  return now - 7*86400000;
      if (timeRange === 'month') return now - 30*86400000;
      return 0;
    }, [timeRange]);

    // 客户端搜索过滤
    const filteredNews = useMemo(() => {
      let items = displayNews;
      if (timeFilterTs > 0) items = items.filter(n => (n.timestamp||0) >= timeFilterTs);
      if (search) {
        const q = search.toLowerCase();
        items = items.filter(n =>
          (n.title||'').toLowerCase().includes(q) ||
          (n.detail||'').toLowerCase().includes(q) ||
          (n.business_category||'').toLowerCase().includes(q)
        );
      }
      return items;
    }, [displayNews, search, timeFilterTs]);

    useEffect(() => {
      const params = new URLSearchParams(window.location.search);
      const query = params.get('q');
      const isDeepAsk = params.get('deep_ask') === 'true';
      
      if (query && isDeepAsk) {
        setSearch(query);
        setSearchInput(query);
        // 自动聚焦到对应的条目或显示 AI 对话引导
        console.log('[DeepAsk] Auto-searching for:', query);
      }
    }, []);

    // ── 数据拉取 ──────────────────────────────────────────────────────────────
    const fetchNews = useCallback(async (source) => {
      const src = source || activeFilter;
      setLoading(true);
      try {
        const q = src === 'Important' ? 'important=1' : `source=${src}`;
        const [dispRes, allRes] = await Promise.all([
          fetch(`/api/news?${q}&limit=500`),
          fetch('/api/news?source=All&limit=500'),
        ]);
        const [dispData, allData] = await Promise.all([dispRes.json(), allRes.json()]);
        setDisplayNews(dispData.data || []);
        setAllNews(allData.data || []);
        setLastUpdateTime(Date.now());
        setCountdown(300);
      } catch (err) {
        console.error('[fetch]', err);
      } finally { setLoading(false); }
    }, [activeFilter]);

    // 健康检查
    const fetchHealth = useCallback(async () => {
      try {
        const res = await fetch('/api/health');
        const d   = await res.json();
        setHealth(d);
      } catch (_) {}
    }, []);

    useEffect(() => { fetchNews(activeFilter); fetchHealth(); }, [activeFilter]);

    // 自动刷新倒计时
    useEffect(() => {
      const t = setInterval(() => {
        setCountdown(prev => {
          if (prev <= 1) { fetchNews(activeFilter); return 300; }
          return prev - 1;
        });
      }, 1000);
      return () => clearInterval(t);
    }, [activeFilter, fetchNews]);

    // 键盘快捷键：Ctrl/Cmd+K 聚焦搜索, J/K 上下导航, S 收藏, R 刷新
    useEffect(() => {
      const handler = (e) => {
        if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
          e.preventDefault();
          searchInputRef.current?.focus();
          return;
        }
        // 不在输入框中时才触发快捷键
        const tag = document.activeElement?.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA') return;

        if (e.key === 'j' || e.key === 'J') {
          e.preventDefault();
          setFocusIdx(prev => Math.min(prev + 1, filteredNews.length - 1));
        } else if (e.key === 'k' || e.key === 'K') {
          e.preventDefault();
          setFocusIdx(prev => Math.max(prev - 1, 0));
        } else if (e.key === 's' || e.key === 'S') {
          if (focusIdx >= 0 && focusIdx < filteredNews.length) {
            e.preventDefault();
            const item = filteredNews[focusIdx];
            toggleBookmark({ stopPropagation: () => {} }, item.id);
          }
        } else if (e.key === 'r' || e.key === 'R') {
          e.preventDefault();
          fetchNews(activeFilter);
        }
      };
      window.addEventListener('keydown', handler);
      return () => window.removeEventListener('keydown', handler);
    }, [focusIdx, filteredNews, activeFilter, fetchNews]);

    // ── 云端同步（极简 6 位码） ──────────────────────────────────────────────────
    const generateSyncCode = async () => {
      const code = Math.random().toString(36).substring(2, 8).toUpperCase();
      setSyncCode(code);
      localStorage.setItem('syncCode', code);
      setIsSyncing(true);
      try {
        await fetch('/api/sync/save', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sync_code: code, read_ids: [...readIds], bookmarks: [...bookmarks] }),
        });
      } catch(e) { console.error('Sync code generation failed', e); }
      finally { setIsSyncing(false); }
    };

    const loadFromSync = async () => {
      const code = syncInput.trim().toUpperCase();
      if (!code || code.length !== 6) return;
      setIsSyncing(true);
      try {
        const res = await fetch(`/api/sync/load?code=${code}`);
        const result = await res.json();
        if (result.success && result.data) {
          const data = result.data;
          const loadedReads = new Set(data.read_ids || []);
          const loadedBookmarks = new Set(data.bookmarks || []);
          setReadIds(loadedReads);
          setBookmarks(loadedBookmarks);
          localStorage.setItem('readIds', JSON.stringify([...loadedReads]));
          localStorage.setItem('bookmarks', JSON.stringify([...loadedBookmarks]));
          setSyncCode(code);
          localStorage.setItem('syncCode', code);
          alert('同步成功！已恢复云端书签与已读历史。');
        } else {
          alert('找不到该同步码，请检查是否输入正确。');
        }
      } catch (e) {
        console.error('Load sync code failed', e);
        alert('同步失败，请稍后重试。');
      } finally { setIsSyncing(false); }
    };

    const syncToCloud = useCallback(async (rIds, bMarks) => {
      if (!syncCode) return;
      try {
        await fetch('/api/sync/save', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sync_code: syncCode, read_ids: [...rIds], bookmarks: [...bMarks] }),
        });
      } catch(e) { console.error('Auto sync failed', e); }
    }, [syncCode]);

    const markAsRead = (id) => {
      if (readIds.has(id)) return;
      const next = new Set(readIds); next.add(id);
      setReadIds(next);
      localStorage.setItem('readIds', JSON.stringify([...next]));
      syncToCloud(next, bookmarks);
    };

    const toggleBookmark = (e, id) => {
      e.stopPropagation();
      const next = new Set(bookmarks);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      setBookmarks(next);
      localStorage.setItem('bookmarks', JSON.stringify([...next]));
      syncToCloud(readIds, next);
    };

    // 搜索与其他工具
    const handleSearch = (e) => { if (e.key === 'Enter') setSearch(searchInput.trim()); };
    const clearSearch  = () => { setSearch(''); setSearchInput(''); };

    const formatTime = (ts) => {
      if (!ts) return '—';
      const diff = Date.now() - ts;
      if (diff < 60000)  return '刚才';
      const min = Math.floor(diff/60000);
      if (min < 60)      return `${min}分钟前`;
      const hr = Math.floor(min/60);
      if (hr < 24)       return `${hr}小时前`;
      return new Date(ts).toLocaleDateString('zh-CN');
    };

    // 最后更新时间格式化（动态更新）
    const [lastUpdateLabel, setLastUpdateLabel] = useState('');
    useEffect(() => {
      if (!lastUpdateTime) return;
      const tick = () => {
        const diff = Date.now() - lastUpdateTime;
        if (diff < 60000) setLastUpdateLabel('刚刚更新');
        else {
          const min = Math.floor(diff / 60000);
          setLastUpdateLabel(`${min} 分钟前更新`);
        }
      };
      tick();
      const t = setInterval(tick, 10000);
      return () => clearInterval(t);
    }, [lastUpdateTime]);

    const SkeletonCard = () => (
      <div className="depth-card p-5 rounded-2xl mb-4">
        <div className="flex gap-2 mb-3"><div className="skeleton w-16 h-4"/><div className="skeleton w-24 h-4"/></div>
        <div className="skeleton w-full h-6 mb-2"/><div className="skeleton w-3/4 h-6"/>
      </div>
    );

    const sidebarNav = (
      <nav className="flex flex-col gap-1 flex-1 overflow-y-auto scrollbar-hide pr-2">
        {NAV_GROUPS.map(group => (
          <div key={group} className="mb-4">
            <h3 className="text-[10px] font-bold text-slate-400 uppercase tracking-widest px-4 mb-2">
              {group === 'CORE' ? '概览' : group}
            </h3>
            {SOURCES.filter(s => s.group === group).map(src => (
              <button key={src.id} onClick={() => { setActiveFilter(src.id); setMenuOpen(false); }}
                className={`w-full flex items-center justify-between px-4 py-2 rounded-xl transition-all group ${
                  activeFilter === src.id ? 'nav-active' : 'text-slate-500 hover:bg-slate-50'
                }`}>
                <div className="flex items-center gap-3">
                  <i className={`fa-solid ${src.icon} w-4 text-center text-xs opacity-70 group-hover:opacity-100`}/>
                  <span className="text-[13px]">{src.label}</span>
                </div>
                {counts[src.id] > 0 && (
                  <span className="text-[10px] font-bold bg-slate-100 px-2 py-0.5 rounded-full text-slate-400">
                    {counts[src.id]}
                  </span>
                )}
              </button>
            ))}
          </div>
        ))}
      </nav>
    );

    return (
      <div className="flex h-screen overflow-hidden bg-[#fcfcfd]">

        {/* ── 移动端遮罩 ──────────────────────────────────────── */}
        {menuOpen && (
          <div className="fixed inset-0 bg-black/30 z-20 md:hidden" onClick={() => setMenuOpen(false)} />
        )}

        {/* ── 侧边栏（桌面常驻 + 移动端抽屉）──────────────────── */}
        <aside className={`
          fixed md:static inset-y-0 left-0 z-30 w-72 border-r border-slate-200 p-6 flex flex-col gap-6 bg-[#fcfcfd]
          transform transition-transform duration-200
          ${menuOpen ? 'translate-x-0' : '-translate-x-full md:translate-x-0'}
        `}>
          <div className="flex items-center gap-3 px-2">
            <div className="w-10 h-10 bg-black rounded-xl flex items-center justify-center shadow-lg shadow-slate-200">
              <i className="fa-solid fa-rss text-white text-lg"/>
            </div>
            <div>
              <h1 className="text-lg font-black tracking-tight leading-none">Alpha Radar</h1>
              <p className="text-[10px] text-slate-400 font-bold uppercase tracking-widest mt-1">情报引擎 v2.0</p>
            </div>
          </div>

          {sidebarNav}

          {/* 底部状态 */}
          <div className="pt-4 border-t border-slate-100 space-y-3">
            {/* 云同步挂件 */}
            <div className="bg-slate-50 p-3 rounded-xl border border-slate-100 relative group">
              <div className="flex justify-between items-center mb-2">
                <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">云端同步</span>
                {isSyncing && <i className="fa-solid fa-circle-notch fa-spin text-slate-300 text-xs"></i>}
              </div>
              
              {syncCode ? (
                <div className="flex justify-between items-center gap-2">
                  <div className="bg-white px-2 py-1 flex-1 rounded text-center border border-slate-200">
                    <span className="font-mono text-sm font-bold tracking-[0.2em] text-slate-700">{syncCode}</span>
                  </div>
                  <button onClick={() => {setSyncCode(''); setSyncInput(''); localStorage.removeItem('syncCode');}} className="text-[10px] text-slate-400 hover:text-red-500 underline" title="解除绑定">解绑</button>
                </div>
              ) : (
                <div className="space-y-2">
                  <div className="flex gap-1">
                    <input type="text" value={syncInput} onChange={e=>setSyncInput(e.target.value.toUpperCase())} maxLength={6} placeholder="输入 6 位码" className="w-full text-xs font-mono uppercase bg-white border border-slate-200 rounded px-2 py-1 focus:outline-blue-400" />
                    <button onClick={loadFromSync} className="bg-slate-200 hover:bg-slate-300 text-slate-600 px-2 py-1 rounded text-xs font-medium transition-colors">加载</button>
                  </div>
                  <button onClick={generateSyncCode} className="w-full text-[11px] text-blue-500 hover:text-blue-600 font-medium py-1 border border-blue-100 bg-blue-50 hover:bg-blue-100 rounded transition-colors text-center">
                    <i className="fa-solid fa-plus mr-1 text-[10px]"></i>新建同步设备
                  </button>
                </div>
              )}
            </div>

            {health && (
              <div className="flex items-center justify-between px-2 text-xs text-slate-400">
                <span>数据库</span>
                <span className="font-bold text-emerald-500">{health.db?.total?.toLocaleString()} 条</span>
              </div>
            )}
            <div className="flex items-center justify-between px-2">
              <div className="flex flex-col">
                <span className="text-xs font-bold text-slate-400">{countdown}s 后刷新</span>
                {lastUpdateLabel && <span className="text-[10px] text-emerald-500 font-medium">{lastUpdateLabel}</span>}
              </div>
              <button onClick={() => fetchNews(activeFilter)}
                className="p-2 hover:bg-slate-100 rounded-lg text-slate-400 hover:text-black transition-colors">
                <i className="fa-solid fa-rotate-right"/>
              </button>
            </div>
          </div>
        </aside>

        {/* ── 主区域 ───────────────────────────────────────────── */}
        <main className="flex-1 overflow-hidden flex flex-col">

          {/* 顶部工具栏 */}
          <div className="border-b border-slate-100 bg-white px-6 py-3 flex items-center gap-3 shrink-0">
            {/* 移动端菜单按钮 */}
            <button onClick={() => setMenuOpen(v => !v)} className="md:hidden p-2 rounded-lg hover:bg-slate-100">
              <i className="fa-solid fa-bars text-slate-500"/>
            </button>

            {/* 搜索框 */}
            <div className="flex-1 relative max-w-md">
              <i className="fa-solid fa-search absolute left-3 top-1/2 -translate-y-1/2 text-slate-300 text-sm"/>
              <input
                ref={searchInputRef}
                type="text"
                placeholder="搜索标题、摘要… (Ctrl+K)"
                value={searchInput}
                onChange={e => setSearchInput(e.target.value)}
                onKeyDown={handleSearch}
                className="w-full pl-9 pr-8 py-2 text-sm border border-slate-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-200 bg-slate-50"
              />
              {searchInput && (
                <button onClick={clearSearch}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-300 hover:text-slate-500">
                  <i className="fa-solid fa-xmark"/>
                </button>
              )}
            </div>

            {/* 时间范围 */}
            <div className="flex gap-1 bg-slate-100 rounded-xl p-1">
              {[['today','今日'],['week','本周'],['month','本月'],['all','全部']].map(([val,lbl]) => (
                <button key={val} onClick={() => setTimeRange(val)}
                  className={`px-3 py-1 rounded-lg text-xs font-medium transition-all ${
                    timeRange === val ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-700'
                  }`}>
                  {lbl}
                </button>
              ))}
            </div>

            {/* 视图切换 */}
            <div className="flex gap-1 bg-slate-100 rounded-xl p-1">
              <button onClick={() => setViewMode('feed')}
                className={`px-3 py-1 rounded-lg text-xs font-medium transition-all ${viewMode==='feed' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500'}`}>
                <i className="fa-solid fa-list mr-1"/>列表
              </button>
              <button onClick={() => setViewMode('chart')}
                className={`px-3 py-1 rounded-lg text-xs font-medium transition-all ${viewMode==='chart' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500'}`}>
                <i className="fa-solid fa-chart-bar mr-1"/>图表
              </button>
              <button onClick={() => setViewMode('trend')}
                className={`px-3 py-1 rounded-lg text-xs font-medium transition-all ${viewMode==='trend' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500'}`}>
                <i className="fa-solid fa-chart-line mr-1"/>趋势
              </button>
              <button onClick={() => setViewMode('competitor')}
                className={`px-3 py-1 rounded-lg text-xs font-medium transition-all ${viewMode==='competitor' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500'}`}>
                <i className="fa-solid fa-crosshairs mr-1"/>竞对
              </button>
              <button onClick={() => setViewMode('monitor')}
                className={`px-3 py-1 rounded-lg text-xs font-medium transition-all ${viewMode==='monitor' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500'}`}>
                <i className="fa-solid fa-heart-pulse mr-1"/>监控
              </button>
            </div>

            {/* 导出按钮 */}
            <button onClick={() => setShowExport(true)}
              className="px-3 py-1.5 rounded-xl text-xs font-medium bg-slate-100 text-slate-500 hover:bg-slate-200 transition-colors"
              title="导出数据">
              <i className="fa-solid fa-download mr-1"/>导出
            </button>

            {/* Dark Mode Toggle */}
            <button onClick={() => setDark(d => !d)}
              className="p-2 rounded-xl text-sm bg-slate-100 text-slate-500 hover:bg-slate-200 transition-colors"
              title={dark ? '切换亮色模式' : '切换暗色模式'}>
              <i className={`fa-solid ${dark ? 'fa-sun text-amber-400' : 'fa-moon'}`}/>
            </button>
          </div>

          {/* 搜索结果提示 */}
          {search && (
            <div className="px-6 py-2 bg-blue-50 text-xs text-blue-600 border-b border-blue-100 shrink-0">
              搜索 "<strong>{search}</strong>" — 找到 {filteredNews.length} 条结果
              <button onClick={clearSearch} className="ml-3 underline">清除</button>
            </div>
          )}

          {/* 内容区 */}
          <div className="flex-1 overflow-y-auto scrollbar-hide" ref={feedContainerRef}>
            {viewMode === 'chart' ? (
              <div className="p-8">
                <div className="depth-card p-6 rounded-2xl">
                  <h2 className="text-lg font-black mb-1 text-slate-900">情报分布图表</h2>
                  <p className="text-xs text-slate-400 mb-4">
                    基于当前视图数据 ({filteredNews.length} 条)
                  </p>
                  <StatsChart news={filteredNews} />
                </div>
              </div>
            ) : viewMode === 'trend' ? (
              <div className="p-8">
                <header className="mb-8">
                  <h2 className="text-2xl font-black text-slate-900 tracking-tight">
                    <i className="fa-solid fa-chart-line text-blue-500 mr-2"></i>
                    趋势洞察
                  </h2>
                </header>
                
                {/* 行业记忆看板 */}
                <InsightsPanel />

                <div className="depth-card p-6 rounded-2xl">
                  <h2 className="text-lg font-black mb-1 text-slate-900">业务热度走势</h2>
                  <p className="text-xs text-slate-400 mb-4">
                    各业务分类消息量随时间变化
                  </p>
                  <TrendChart days={7} />
                </div>
              </div>
            ) : viewMode === 'competitor' ? (
              <div className="p-6 md:p-10">
                <header className="mb-8">
                  <h2 className="text-2xl font-black text-slate-900 tracking-tight">
                    <i className="fa-solid fa-crosshairs text-red-400 mr-2"></i>
                    竞对雷达
                    <span className="ml-3 text-base font-normal text-slate-400">
                      按竞争类型分组
                    </span>
                  </h2>
                </header>
                <CompetitorRadar news={allNews} />
              </div>
            ) : viewMode === 'monitor' ? (
              <MonitoringPanel />
            ) : (
              <div className="p-6 md:p-10">
                <header className="mb-8">
                  <h2 className="text-2xl font-black text-slate-900 tracking-tight">
                    {activeFilter === 'All' ? '全部动态' : SOURCES.find(s=>s.id===activeFilter)?.label}
                    <span className="ml-3 text-base font-normal text-slate-400">
                      {filteredNews.length} 条
                    </span>
                  </h2>
                </header>

                {loading && filteredNews.length === 0 ? (
                  <div className="max-w-4xl">
                    {[1,2,3,4,5].map(i => <SkeletonCard key={i}/>)}
                  </div>
                ) : filteredNews.length === 0 ? (
                  <div className="text-center py-24 text-slate-300 italic font-medium">暂无雷达信号</div>
                ) : (
                  <div className="max-w-4xl flex flex-col gap-4">
                    {(() => {
                      let prevDateStr = '';
                      const WEEKS = ['周日','周一','周二','周三','周四','周五','周六'];
                      
                      return filteredNews.map(item => {
                        const isRead   = readIds.has(item.id);
                        const isBookmarked = bookmarks.has(item.id);
                        const caMatch  = (item.title + (item.content||'')).match(/0x[a-fA-F0-9]{40}/);
                        
                        // Date parsing
                        const d = new Date(item.timestamp || Date.now());
                        const dateStr = `${d.getMonth()+1}月${d.getDate()}日, ${WEEKS[d.getDay()]}`;
                        const timeStr = `${d.getHours().toString().padStart(2,'0')}:${d.getMinutes().toString().padStart(2,'0')}`;
                        
                        const showHeader = dateStr !== prevDateStr;
                        prevDateStr = dateStr;

                        return (
                          <React.Fragment key={item.id}>
                            {showHeader && (
                              <div className="flex items-center mt-6 mb-4 first:mt-0">
                                <h2 className="text-xl font-bold text-slate-800 tracking-tight">{dateStr}</h2>
                              </div>
                            )}

                            <div className="flex gap-4 group relative mb-2">
                              {/* 时间轴左侧 */}
                              <div className="w-16 shrink-0 flex items-start justify-end pt-1 gap-2">
                                <span className="text-[13px] font-medium text-slate-400 mt-[2px]">{timeStr}</span>
                                <div className="w-2 h-2 rounded-full bg-blue-600 mt-[7px] shrink-0 outline outline-4 outline-[#fcfcfd]" />
                              </div>

                              {/* 内容卡片 */}
                              <div 
                                onClick={() => { markAsRead(item.id); window.open(item.url,'_blank'); }}
                                className={`flex-1 bg-white p-5 rounded-xl border border-slate-150 shadow-[0_2px_8px_-4px_rgba(0,0,0,0.05)] cursor-pointer transition-all hover:shadow-md hover:-translate-y-[1px] ${isRead ? 'feed-read':''} ${item.is_important ? 'border-l-4 border-l-red-500':''} ${filteredNews.indexOf(item) === focusIdx ? 'keyboard-focus' : ''}`}>
                                
                                {/* 标题 */}
                                <h3 className="text-[16px] font-bold leading-relaxed text-slate-900 mb-2">
                                  {highlight(item.title, search)}
                                </h3>

                                {/* 内容 / 摘要 */}
                                {item.detail ? (
                                  <p className="text-[14px] text-slate-600 leading-relaxed mb-4">
                                    {highlight(item.detail, search)}
                                  </p>
                                ) : item.content ? (
                                  <p className="text-[14px] text-slate-500 leading-relaxed line-clamp-2 mb-4">
                                    {item.content}
                                  </p>
                                ) : null}

                                {/* 底部标签 & Action */}
                                <div className="flex justify-between items-end mt-auto pt-2">
                                  <div className="flex items-center gap-2 flex-wrap">
                                    <span className="text-[11px] px-2 py-0.5 rounded-md bg-slate-50 text-slate-500 border border-slate-100 font-medium">
                                      {item.source}
                                    </span>
                                    {item.alpha_score > 0 && <ScoreBadge score={item.alpha_score} />}
                                    {item.is_important === 1 && <span className="text-[11px] px-2 py-0.5 rounded-md bg-red-50 text-red-600 font-bold border border-red-100 flex items-center gap-1"><i className="fa-solid fa-star text-[9px]"></i> 重要信号</span>}
                                    {item.business_category && (
                                      <span className="text-[11px] px-2 py-0.5 rounded-md bg-emerald-50 text-emerald-600 font-medium border border-emerald-100 flex items-center gap-1">
                                        <i className="fa-solid fa-tag text-[9px]"></i> {item.business_category}
                                      </span>
                                    )}
                                    {caMatch && (
                                      <button onClick={e=>{e.stopPropagation();navigator.clipboard.writeText(caMatch[0])}}
                                        className="text-[11px] font-bold text-indigo-500 hover:text-indigo-700 bg-indigo-50 hover:bg-indigo-100 px-2 py-0.5 rounded-md border border-indigo-100 transition-colors flex items-center gap-1">
                                        <i className="fa-regular fa-copy"></i> CA
                                      </button>
                                    )}
                                  </div>
                                  <div className="flex gap-3 text-slate-300">
                                    <button onClick={(e) => toggleBookmark(e, item.id)} className={`transition-colors text-lg ${isBookmarked ? 'text-amber-400 drop-shadow-[0_0_2px_rgba(251,191,36,0.5)]' : 'hover:text-amber-400'}`}>
                                      <i className={isBookmarked ? "fa-solid fa-star" : "fa-regular fa-star"}></i>
                                    </button>
                                    <button onClick={(e) => {e.stopPropagation(); window.open(item.url, '_blank')}} className="hover:text-blue-500 transition-colors text-lg"><i className="fa-solid fa-arrow-up-right-from-square"></i></button>
                                  </div>
                                </div>
                              </div>
                            </div>
                          </React.Fragment>
                        );
                      });
                    })()}
                  </div>
                )}
              </div>
            )}
          </div>
        </main>

        {/* ── 右侧信息栏（仅桌面大屏）─────────────────────────── */}
        <aside className="w-72 border-l border-slate-100 p-8 hidden xl:flex flex-col gap-8 bg-white shrink-0 overflow-y-auto scrollbar-hide">
          {/* 数据源健康看板 */}
          <SourceHealthPanel />

          <div>
            <h3 className="text-[10px] font-black text-slate-400 uppercase tracking-[.2em] mb-4">系统状态</h3>
            <div className="space-y-3">
              <div className="flex justify-between">
                <span className="text-xs text-slate-500">数据节点</span>
                <span className="text-xs font-black">{SOURCES.length - 2}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-xs text-slate-500">总条目</span>
                <span className="text-xs font-black">{health?.db?.total?.toLocaleString() || counts.All}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-xs text-slate-500">重要信号</span>
                <span className="text-xs font-black text-red-500">{counts.Important || 0}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-xs text-slate-500">运行时长</span>
                <span className="text-xs font-black text-emerald-500">
                  {health ? `${Math.floor(health.uptime/3600)}h` : '—'}
                </span>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-xs text-slate-500">数据库</span>
                <span className="flex items-center gap-1.5 text-xs font-black text-emerald-500">
                  <span className="w-1.5 h-1.5 bg-emerald-500 rounded-full animate-pulse"/>
                  在线
                </span>
              </div>
            </div>
          </div>

          <div>
            <h3 className="text-[10px] font-black text-slate-400 uppercase tracking-[.2em] mb-4">当前视图</h3>
            <div className="space-y-2 text-xs text-slate-400">
              <p>• 显示: {filteredNews.length} / {displayNews.length} 条</p>
              <p>• 时间: {timeRange === 'today' ? '今日' : timeRange === 'week' ? '本周' : timeRange === 'month' ? '本月' : '全部'}</p>
              {search && <p className="text-blue-500">• 搜索: "{search}"</p>}
              <p>• 刷新: {countdown}s 后</p>
            </div>
          </div>

          <div>
            <h3 className="text-[10px] font-black text-slate-400 uppercase tracking-[.2em] mb-4">分类统计</h3>
            <div className="space-y-1.5">
              {useMemo(() => {
                const m = {};
                filteredNews.forEach(n => { const c = n.business_category||'其他'; m[c]=(m[c]||0)+1; });
                return Object.entries(m).sort((a,b)=>b[1]-a[1]).slice(0,8).map(([cat,cnt]) => (
                  <div key={cat} className="flex justify-between">
                    <span className="text-xs text-slate-500 truncate max-w-[140px]">{cat}</span>
                    <span className="text-xs font-bold text-slate-700">{cnt}</span>
                  </div>
                ));
              }, [filteredNews])}
            </div>
          </div>

          {/* 快捷键提示 */}
          <div className="py-3 border-t border-slate-50">
            <h3 className="text-[10px] font-black text-slate-400 uppercase tracking-[.15em] mb-2">快捷键</h3>
            <div className="grid grid-cols-2 gap-1 text-[10px] text-slate-400">
              <span><kbd className="bg-slate-100 px-1 rounded text-slate-500">J</kbd> 下一条</span>
              <span><kbd className="bg-slate-100 px-1 rounded text-slate-500">K</kbd> 上一条</span>
              <span><kbd className="bg-slate-100 px-1 rounded text-slate-500">S</kbd> 收藏</span>
              <span><kbd className="bg-slate-100 px-1 rounded text-slate-500">R</kbd> 刷新</span>
            </div>
          </div>

          <div className="mt-auto py-4 border-t border-slate-50 text-center">
            <span className="text-[10px] font-black text-slate-300 uppercase tracking-[.3em]">Alpha Radar v2.0</span>
          </div>
        </aside>

        {/* Export Modal */}
        {showExport && <ExportModal news={allNews} onClose={() => setShowExport(false)} />}
      </div>
    );
  }

  ReactDOM.createRoot(document.getElementById('root')).render(<App />);
