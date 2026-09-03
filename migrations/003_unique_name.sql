-- 003_unique_name.sql —— 店名唯一约束
--
-- 背景：单条 POST 重名原本会再插一行，而批量导入路径却按名去重复用已有行，
-- 两条路语义不一致；进了多榜单之后，重名还会让同一家店在同一榜里出现两次。
--
-- 做三件事，全部幂等：
--   1. 已有的重名行合并：保留 id 最小的那家，把落败行的榜单关联迁给它
--      （目标 (list_id, option_id) 已存在时 ON CONFLICT 跳过，不会撞主键）
--   2. 删掉落败行（list_items 的旧关联一并清掉）
--   3. 建 LOWER(name) 上的唯一索引；IF NOT EXISTS 保证重放无害

WITH survivor AS (
    SELECT MIN(id) AS keep_id, LOWER(name) AS name_key
    FROM food_options
    GROUP BY LOWER(name)
    HAVING COUNT(*) > 1
),
victims AS (
    SELECT o.id AS victim_id, s.keep_id
    FROM food_options o
    JOIN survivor s ON LOWER(o.name) = s.name_key AND o.id <> s.keep_id
),
moved AS (
    INSERT INTO list_items (list_id, option_id)
    SELECT li.list_id, v.keep_id
    FROM list_items li
    JOIN victims v ON li.option_id = v.victim_id
    ON CONFLICT DO NOTHING
),
clean AS (
    DELETE FROM list_items li
    USING victims v
    WHERE li.option_id = v.victim_id
)
DELETE FROM food_options o
USING victims v
WHERE o.id = v.victim_id;

CREATE UNIQUE INDEX IF NOT EXISTS food_options_name_lower_uidx
    ON food_options (LOWER(name));
