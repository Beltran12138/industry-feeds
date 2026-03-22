'use strict';

const { createClient } = require('@supabase/supabase-js');

const VALID_SOURCES = new Set([
  'All', 'Important',
  'Binance', 'OKX', 'Bybit', 'Gate', 'MEXC', 'Bitget', 'HTX', 'KuCoin',
  'BlockBeats', 'TechFlow', 'PRNewswire',
  'HashKeyGroup', 'HashKeyExchange', 'WuBlock', 'OSL', 'Exio', 'TechubNews',
  'WuShuo', 'Phyrex', 'JustinSun', 'XieJiayin', 'TwitterAB',
  'Poly-Breaking', 'Poly-China',
]);

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');

  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_KEY
    );

    let source = req.query.source || 'All';
    if (!VALID_SOURCES.has(source)) source = 'All';
    const important = req.query.important === '1' ? 1 : 0;
    const limit = Math.min(500, Math.max(1, parseInt(req.query.limit, 10) || 500));
    const search = (req.query.q || '').trim().slice(0, 100);

    let query = supabase
      .from('news')
      .select('*')
      .order('timestamp', { ascending: false })
      .limit(limit);

    if (important === 1) {
      query = query.eq('is_important', 1);
    } else if (source !== 'All') {
      query = query.eq('source', source);
    }

    if (search) {
      query = query.or(`title.ilike.%${search}%,content.ilike.%${search}%,detail.ilike.%${search}%`);
    }

    const { data, error } = await query;
    if (error) throw new Error(error.message);

    res.json({
      success: true,
      count: (data || []).length,
      lastUpdate: new Date().toISOString(),
      data: data || [],
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};
