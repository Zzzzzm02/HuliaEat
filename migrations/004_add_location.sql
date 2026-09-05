-- 004: 地理信息（地图页用）。三者都可空——没定位的店不上图，其余功能不受影响。
ALTER TABLE food_options
    ADD COLUMN IF NOT EXISTS latitude DOUBLE PRECISION,
    ADD COLUMN IF NOT EXISTS longitude DOUBLE PRECISION,
    ADD COLUMN IF NOT EXISTS address VARCHAR(200);
