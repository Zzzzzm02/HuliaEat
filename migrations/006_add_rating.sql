-- 006: 评分与人均消费（展示信息，来自高德 v5 business 字段）。
-- 抽签不参与评分——它们只在拉取时当入库门槛、在附近列表里展示。
ALTER TABLE food_options
    ADD COLUMN IF NOT EXISTS rating REAL,
    ADD COLUMN IF NOT EXISTS cost INTEGER;
