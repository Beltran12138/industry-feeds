'use strict';

const { createClient } = require('@supabase/supabase-js');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');

  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_KEY
    );

    const days = Math.min(90, Math.max(1, parseInt(req.query.days, 10) || 7));
    const category = (req.query.category || '').trim();
    const since = Date.now() - days * 24 * 3600 * 1000;

    let query = supabase
      .from('news')
      .select('timestamp,business_category')
      .gte('timestamp', since)
      .neq('business_category', '');

    if (category) query = query.eq('business_category', category);

    const { data, error } = await query;
    if (error) throw new Error(error.message);

    const trendMap = {};
    (data || []).forEach(n => {
      const d = new Date(n.timestamp).toISOString().split('T')[0];
      const cat = category || n.business_category;
      const key = `${d}|${cat}`;
      if (!trendMap[key]) trendMap[key] = { date: d, category: cat, count: 0 };
      trendMap[key].count++;
    });

    const rows = Object.values(trendMap).sort((a, b) => a.date.localeCompare(b.date));
    res.json({ success: true, days, category: category || 'all', data: rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};
