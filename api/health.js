'use strict';

const { createClient } = require('@supabase/supabase-js');

const START_TIME = Date.now();

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');

  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_KEY
    );

    const { count } = await supabase
      .from('news')
      .select('*', { count: 'exact', head: true });

    res.json({
      status: 'ok',
      uptime: Math.floor((Date.now() - START_TIME) / 1000),
      db: { total: count || 0 },
      version: '2.1.0',
      env: 'vercel',
    });
  } catch (err) {
    res.json({ status: 'ok', uptime: 0, db: { total: 0 }, error: err.message });
  }
};
