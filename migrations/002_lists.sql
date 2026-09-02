-- 002_lists.sql —— 多榜单：一家店可同时属于多个榜单（多对多）
--
-- 设计要点：
--   * food_options 仍是"店的唯一真相"（一家店只有一行），
--     所以 emoji / 名称的修改不会因复制进多个榜单而分裂。
--   * 删除榜单只解除关联，不会删掉店本身；下架一家店仍走 DELETE /api/options/:id。
--   * 末尾的回填是幂等的：把库里已存在的每家店挂进"默认榜单"，
--     保证老数据升级后立刻可用、不会变成无处可找的孤儿行。

CREATE TABLE IF NOT EXISTS lists (
    id BIGSERIAL PRIMARY KEY,
    name VARCHAR(40) NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS lists_name_lower_uidx ON lists (LOWER(name));

CREATE TABLE IF NOT EXISTS list_items (
    list_id BIGINT NOT NULL REFERENCES lists(id) ON DELETE CASCADE,
    option_id BIGINT NOT NULL REFERENCES food_options(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (list_id, option_id)
);

CREATE INDEX IF NOT EXISTS list_items_option_idx ON list_items(option_id);

-- 建默认榜单（仅当还没有任何榜单时）
INSERT INTO lists (name, sort_order)
SELECT '默认榜单', 1
WHERE NOT EXISTS (SELECT 1 FROM lists);

-- 把每家已有的店挂进默认榜单（仅挂尚未属于任何榜单的行）
INSERT INTO list_items (list_id, option_id)
SELECT l.id, o.id
FROM lists l
CROSS JOIN food_options o
WHERE l.name = '默认榜单'
  AND NOT EXISTS (
      SELECT 1 FROM list_items li
      WHERE li.list_id = l.id AND li.option_id = o.id
  );
