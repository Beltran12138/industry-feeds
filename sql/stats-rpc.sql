-- Alpha-Radar: Server-side aggregation RPCs for Supabase
-- Run this in Supabase SQL Editor to create the functions.

-- 1. Category stats: replaces pulling all business_category rows
CREATE OR REPLACE FUNCTION get_category_stats(since_ts BIGINT)
RETURNS TABLE(business_category TEXT, n BIGINT) AS $$
  SELECT business_category, COUNT(*) as n
  FROM news
  WHERE timestamp > since_ts AND business_category IS NOT NULL AND business_category != ''
  GROUP BY business_category
  ORDER BY n DESC;
$$ LANGUAGE SQL STABLE;

-- 2. Source stats: replaces pulling all source rows
CREATE OR REPLACE FUNCTION get_source_stats()
RETURNS TABLE(source TEXT, n BIGINT) AS $$
  SELECT source, COUNT(*) as n
  FROM news
  WHERE source IS NOT NULL AND source != ''
  GROUP BY source
  ORDER BY n DESC
  LIMIT 30;
$$ LANGUAGE SQL STABLE;

-- 3. Trend data: daily counts by category for charts
CREATE OR REPLACE FUNCTION get_trend_data(days_back INT DEFAULT 7)
RETURNS TABLE(date TEXT, category TEXT, count BIGINT) AS $$
  SELECT
    to_char(to_timestamp(timestamp / 1000) AT TIME ZONE 'Asia/Shanghai', 'YYYY-MM-DD') as date,
    COALESCE(business_category, '其他') as category,
    COUNT(*) as count
  FROM news
  WHERE timestamp > (EXTRACT(EPOCH FROM NOW()) * 1000 - days_back * 86400000)::BIGINT
  GROUP BY date, category
  ORDER BY date, count DESC;
$$ LANGUAGE SQL STABLE;
