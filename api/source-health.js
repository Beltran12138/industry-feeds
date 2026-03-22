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

    const { data } = await supabase
      .from('news')
      .select('source,timestamp')
      .order('timestamp', { ascending: false })
      .limit(2000);

    const srcMap = {};
    (data || []).forEach(n => {
      if (!srcMap[n.source]) srcMap[n.source] = { source: n.source, latest_timestamp: 0, total_count: 0 };
      srcMap[n.source].total_count++;
      if (n.timestamp > srcMap[n.source].latest_timestamp) srcMap[n.source].latest_timestamp = n.timestamp;
    });

    const now = Date.now();
    const TWO_HOURS = 2 * 60 * 60 * 1000;
    const sourceHealth = Object.values(srcMap)
      .sort((a, b) => b.latest_timestamp - a.latest_timestamp)
      .map(row => ({
        source: row.source,
        latest_timestamp: row.latest_timestamp,
        total_count: row.total_count,
        status: (now - row.latest_timestamp) > TWO_HOURS ? 'stale' : 'healthy',
        hours_since_update: Math.floor((now - row.latest_timestamp) / 3600000),
      }));

    res.json({ success: true, data: sourceHealth });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};
