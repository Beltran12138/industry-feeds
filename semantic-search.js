'use strict';

const { createClient } = require('@supabase/supabase-js');

let supabase = null;
if (process.env.SUPABASE_URL && process.env.SUPABASE_KEY) {
  supabase = createClient(
    process.env.SUPABASE_URL.trim(),
    process.env.SUPABASE_KEY.trim()
  );
}

const EMBEDDING_MODEL = 'text-embedding-3-small';
const EMBEDDING_DIMENSION = 1536;

async function getEmbedding(text) {
  if (!process.env.DEEPSEEK_API_KEY) {
    console.warn('[Semantic] DEEPSEEK_API_KEY not configured');
    return null;
  }

  try {
    const response = await fetch('https://api.deepseek.com/v1/embeddings', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.DEEPSEEK_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: EMBEDDING_MODEL,
        input: text.substring(0, 8000)
      })
    });

    if (!response.ok) {
      const err = await response.text();
      console.error('[Semantic] DeepSeek API error:', err);
      return null;
    }

    const data = await response.json();
    return data.data?.[0]?.embedding || null;
  } catch (e) {
    console.error('[Semantic] getEmbedding error:', e.message);
    return null;
  }
}

async function saveEmbedding(newsId, text) {
  if (!supabase) {
    console.warn('[Semantic] Supabase not configured');
    return false;
  }

  const embedding = await getEmbedding(text);
  if (!embedding) return false;

  try {
    const { error } = await supabase.from('news_embeddings').insert({
      news_id: newsId,
      embedding: embedding
    });

    if (error) {
      console.error('[Semantic] Save embedding error:', error.message);
      return false;
    }
    return true;
  } catch (e) {
    console.error('[Semantic] Save embedding exception:', e.message);
    return false;
  }
}

async function semanticSearch(query, options = {}) {
  const { limit = 10, threshold = 0.5 } = options;

  if (!supabase) {
    console.warn('[Semantic] Supabase not configured');
    return [];
  }

  const queryEmbedding = await getEmbedding(query);
  if (!queryEmbedding) {
    console.warn('[Semantic] Failed to get query embedding');
    return [];
  }

  try {
    const { data, error } = await supabase.rpc('match_news', {
      query_embedding: queryEmbedding,
      match_threshold: threshold,
      match_count: limit
    });

    if (error) {
      console.error('[Semantic] RPC error:', error.message);
      
      const { data: fallback, error: fallbackErr } = await supabase
        .from('news_embeddings')
        .select('news_id, embedding, created_at')
        .limit(limit * 2);

      if (fallbackErr || !fallback?.length) {
        return [];
      }

      const scored = fallback
        .map(row => ({
          news_id: row.news_id,
          similarity: cosineSimilarity(queryEmbedding, row.embedding),
          created_at: row.created_at
        }))
        .filter(r => r.similarity >= threshold)
        .sort((a, b) => b.similarity - a.similarity)
        .slice(0, limit);

      if (scored.length === 0) return [];

      const newsIds = scored.map(s => s.news_id);
      const { data: news } = await supabase
        .from('news')
        .select('*')
        .in('id', newsIds);

      const newsMap = {};
      (news || []).forEach(n => { newsMap[n.id] = n; });

      return scored
        .filter(s => newsMap[s.news_id])
        .map(s => ({ ...newsMap[s.news_id], similarity: s.similarity }));
    }

    return data || [];
  } catch (e) {
    console.error('[Semantic] Search exception:', e.message);
    return [];
  }
}

function cosineSimilarity(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;
  
  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  
  const denominator = Math.sqrt(normA) * Math.sqrt(normB);
  return denominator === 0 ? 0 : dotProduct / denominator;
}

async function generateEmbeddingsForRecentNews(count = 100) {
  if (!supabase) return { success: 0, failed: 0 };

  const { data: news, error } = await supabase
    .from('news')
    .select('id, title, content, detail')
    .order('timestamp', { ascending: false })
    .limit(count);

  if (error || !news?.length) {
    console.warn('[Semantic] No news to process');
    return { success: 0, failed: 0 };
  }

  const { data: existing } = await supabase
    .from('news_embeddings')
    .select('news_id');

  const existingIds = new Set((existing || []).map(e => e.news_id));
  const toProcess = news.filter(n => !existingIds.has(n.id));

  console.log(`[Semantic] Processing ${toProcess.length} new items`);

  let success = 0;
  let failed = 0;

  for (const item of toProcess) {
    const text = [item.title, item.content, item.detail]
      .filter(Boolean)
      .join(' | ');
    
    const saved = await saveEmbedding(item.id, text);
    if (saved) success++;
    else failed++;
    
    await new Promise(r => setTimeout(r, 100));
  }

  return { success, failed };
}

module.exports = {
  getEmbedding,
  saveEmbedding,
  semanticSearch,
  generateEmbeddingsForRecentNews,
  cosineSimilarity
};
