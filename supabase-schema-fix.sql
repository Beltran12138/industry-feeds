-- Add missing columns to news table
ALTER TABLE news ADD COLUMN IF NOT EXISTS alpha_score INTEGER DEFAULT 0;
ALTER TABLE news ADD COLUMN IF NOT EXISTS sent_to_wecom INTEGER DEFAULT 0;
ALTER TABLE news ADD COLUMN IF NOT EXISTS normalized_title TEXT DEFAULT '';

-- Create indexes for better performance
CREATE INDEX IF NOT EXISTS idx_news_alpha_score ON news(alpha_score);
CREATE INDEX IF NOT EXISTS idx_news_sent_to_wecom ON news(sent_to_wecom);
CREATE INDEX IF NOT EXISTS idx_news_normalized_title ON news(normalized_title);