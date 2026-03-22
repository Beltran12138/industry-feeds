'use strict';

const { createClient } = require('@supabase/supabase-js');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');

  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_KEY
    );

    const [{ count: total }, { count: important }, { data: srcRows }] = await Promise.all([
      supabase.from('news').select('*', { count: 'exact', head: true }),
      supabase.from('news').select('*', { count: 'exact', head: true }).eq('is_important', 1),
      supabase.from('news').select('source'),
    ]);

    const srcMap = {};
    (srcRows || []).forEach(r => {
      if (r.source) srcMap[r.source] = (srcMap[r.source] || 0) + 1;
    });
    const sources = Object.entries(srcMap)
      .map(([source, n]) => ({ source, n }))
      .sort((a, b) => b.n - a.n);

    res.json({
      success: true,
      data: { total: total || 0, important: important || 0, sources, categories: [] },
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};
