-- =====================================================
-- Alpha-Radar 向量搜索 SQL 脚本
-- 请在 Supabase SQL Editor 中执行
-- =====================================================

-- 1. 启用 pgvector 扩展
CREATE EXTENSION IF NOT EXISTS vector;

-- 2. 创建向量表 (如果不存在)
CREATE TABLE IF NOT EXISTS news_embeddings (
  id BIGSERIAL PRIMARY KEY,
  news_id BIGINT REFERENCES news(id) ON DELETE CASCADE,
  embedding vector(1536),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 3. 创建 HNSW 索引 (加速相似度搜索)
DROP INDEX IF EXISTS idx_embeddings_hnsw;
CREATE INDEX idx_embeddings_hnsw 
ON news_embeddings USING hnsw (embedding vector_cosine_ops);

-- 4. 创建 RPC 函数 (语义搜索)
CREATE OR REPLACE FUNCTION match_news(
  query_embedding vector(1536),
  match_threshold FLOAT DEFAULT 0.5,
  match_count INT DEFAULT 10
)
RETURNS TABLE (
  news_id BIGINT,
  similarity FLOAT,
  created_at TIMESTAMPTZ
)
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  SELECT 
    ne.news_id,
    1 - (ne.embedding <=> query_embedding) AS similarity,
    ne.created_at
  FROM news_embeddings ne
  WHERE 1 - (ne.embedding <=> query_embedding) > match_threshold
  ORDER BY ne.embedding <=> query_embedding
  LIMIT match_count;
END;
$$;

-- 5. 添加唯一约束 (防止重复)
ALTER TABLE news_embeddings 
ADD CONSTRAINT unique_news_id UNIQUE (news_id);

-- 6. 查看结果
SELECT 'Setup complete!' AS status;
