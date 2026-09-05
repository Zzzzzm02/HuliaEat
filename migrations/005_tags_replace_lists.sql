-- 005: 榜单体系退役,改用类型标签。
-- 每家店挂 0~N 个标签(火锅/烧烤/面……),首页筛选从"榜单"换成"今天想吃X"。
-- 分类榜单(🍜 面馆 之类)的成员关系转成标签后,lists / list_items 整体退役。

ALTER TABLE food_options
    ADD COLUMN IF NOT EXISTS tags TEXT[] NOT NULL DEFAULT '{}';

-- 分类榜单 → 标签:去掉 "🍜 " 这类 emoji 前缀;"默认榜单" 是全量池,不算分类
UPDATE food_options o
SET tags = t.tag_array
FROM (
    SELECT li.option_id,
           array_agg(DISTINCT regexp_replace(l.name, '^[^[:alnum:]]+[[:space:]]+', '')) AS tag_array
    FROM list_items li
    JOIN lists l ON l.id = li.list_id
    WHERE l.name <> '默认榜单'
    GROUP BY li.option_id
) t
WHERE o.id = t.option_id;

DROP TABLE list_items;
DROP TABLE lists;
