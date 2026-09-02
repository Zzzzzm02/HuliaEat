-- 001_init.sql —— 基线结构（幂等）
--
-- 老库早就存在 food_options，但还没有 schema_migrations 记录。
-- 全部使用 IF NOT EXISTS，因此对已有库执行 001 是无害的空操作，
-- 对新库则一次建好原始结构。

CREATE TABLE IF NOT EXISTS food_options (
    id BIGSERIAL PRIMARY KEY,
    name VARCHAR(40) NOT NULL,
    emoji VARCHAR(8) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
