#!/usr/bin/env node
/*
 * 按商圈批量拉取高德餐饮 POI,评分过滤后入库为「就近随便吃」池。
 *
 *   node scripts/fetch-pois.mjs            # dry-run:只打印结果,不写库
 *   node scripts/fetch-pois.mjs --apply    # 真正入库
 *
 * 用 v5 place/around + show_fields=business(评分/人均)。
 * 过滤:餐饮大类去掉糕饼/饮品/果品;必须有评分且 >= RATING_MIN;店名与库内不重复。
 * 个人 key 有 QPS 限制,请求间隔 400ms,失败退避重试(与 staticmap 同一套哲学)。
 */

import { readFileSync } from 'fs';

const env = readFileSync(new URL('../.env', import.meta.url), 'utf8');
for (const line of env.split('\n')) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (m && process.env[m[1]] === undefined && m[2].trim()) process.env[m[1]] = m[2].trim();
}

const KEY = (process.env.AMAP_WEB_KEY || '').trim();
const APPLY = process.argv.includes('--apply');
const RATING_MIN = 4.2;      // 评分门槛,当"人气"用
const TOTAL_CAP = 400;       // 整个池子上限
const PAGES_PER_CIRCLE = 4;  // 每个商圈最多翻 4 页(25 条/页)
const GAP_MS = 400;

if (!KEY) {
    console.error('缺少 AMAP_WEB_KEY');
    process.exit(2);
}

const { Pool } = await import('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// 商圈:名称 / 圆心(经,纬) / 半径米。想加删商圈改这里就行
const CIRCLES = [
    ['武林广场', 120.1660, 30.2790, 1500],
    ['湖滨·in77', 120.1640, 30.2470, 1200],
    ['黄龙', 120.1330, 30.2660, 1500],
    ['钱江新城·万象城', 120.2160, 30.2560, 1500],
    ['滨江·星光大道', 120.2010, 30.2080, 1500],
    ['城西·城西银泰城', 120.1180, 30.2960, 1800],
    ['未来科技城·西溪银泰', 120.0760, 30.2830, 2000],
    ['拱宸桥·运河', 120.1420, 30.3250, 1500],
    ['萧山·万象汇', 120.2530, 30.1830, 1500],
    ['下沙·金沙天街', 120.3520, 30.3120, 1500]
];

// 这些品类不当正餐(糕饼/饮品/果品/茶艺/冷饮/甜品店),按类型词跳过
const EXCLUDE_TYPE_RE = /糕饼|饮品|果品|茶艺|冷饮|甜品/;
// 类型 → 追加标签(能判断出来的才给,判断不出就只挂「就近随便吃」)
function extraTags(poi) {
    const type = String(poi.type || '');
    const keytag = String((poi.business && poi.business.keytag) || '');
    const hay = `${type} ${keytag}`;
    const tags = [];
    if (hay.includes('火锅')) tags.push('火锅');
    if (/烧烤|烤肉/.test(hay)) tags.push('烧烤');
    if (/面馆|米线|面条/.test(hay)) tags.push('面');
    if (/小吃|快餐|简餐|熟食/.test(hay)) tags.push('小吃');
    if (/外国餐厅|日本|韩国|西餐|东南亚|泰国|意大利/.test(hay)) tags.push('换口味');
    if (tags.length === 0 && /浙菜|杭|本帮|江浙/.test(hay)) tags.push('杭帮菜');
    return tags;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function searchAround(circle, pageNum) {
    const [name, lng, lat, radius] = circle;
    const url = 'https://restapi.amap.com/v5/place/around'
        + `?key=${encodeURIComponent(KEY)}`
        + `&location=${lng},${lat}&radius=${radius}`
        + '&types=050000&show_fields=business'
        + `&page_size=25&page_num=${pageNum}`;

    for (let attempt = 0; attempt < 3; attempt += 1) {
        if (attempt > 0) await sleep(400 + Math.floor(Math.random() * 300));
        const res = await fetch(url);
        const body = await res.json();
        if (body.status === '1') return body.pois || [];
        console.error(`  ⚠️ ${name} 第${pageNum}页: ${body.info} (${body.infocode})`);
    }
    return [];
}

function buildAddress(poi) {
    return [poi.adname, poi.address].filter(Boolean).join('').slice(0, 200) || null;
}

async function main() {
    // 库内已有的店名不去撞(精选 59 家不进批量池,重名直接跳过)
    const existing = await pool.query('SELECT LOWER(name) AS k FROM food_options');
    const existingNames = new Set(existing.rows.map((r) => r.k));

    const seen = new Map(); // key: name@location → poi
    const perCircle = [];

    outer:
    for (const circle of CIRCLES) {
        let kept = 0;
        for (let page = 1; page <= PAGES_PER_CIRCLE; page += 1) {
            const pois = await searchAround(circle, page);
            if (!pois.length) break;
            for (const poi of pois) {
                const hay = `${poi.type || ''} ${(poi.business && poi.business.keytag) || ''}`;
                if (EXCLUDE_TYPE_RE.test(hay)) continue;

                const rating = poi.business && poi.business.rating != null ? Number(poi.business.rating) : null;
                if (rating === null || Number.isNaN(rating) || rating < RATING_MIN) continue;

                const key = `${poi.name}@${poi.location}`;
                if (seen.has(key) || existingNames.has(String(poi.name).toLowerCase())) continue;

                seen.set(key, { ...poi, _rating: rating });
                kept += 1;
                if (seen.size >= TOTAL_CAP) break outer;
            }
            await sleep(GAP_MS);
        }
        perCircle.push(`${circle[0]}: ${kept} 家`);
        console.log(`${circle[0]}: 累计 ${seen.size} 家`);
    }

    console.log(`\n=== 共 ${seen.size} 家(评分 ≥ ${RATING_MIN}},${APPLY ? '将入库' : 'dry-run 未入库'} ===`);
    const list = [...seen.values()];
    for (const poi of list.slice(0, 25)) {
        const tags = ['就近随便吃', ...extraTags(poi)];
        const cost = poi.business && poi.business.cost ? `¥${poi.business.cost}` : '¥?';
        console.log(`${poi._rating}分 ${cost} [${tags.join('/')}] ${poi.name} @ ${buildAddress(poi)}`);
    }
    if (list.length > 25) console.log(`... 其余 ${list.length - 25} 家略`);

    // 评分分布,帮用户定门槛
    const buckets = [4.2, 4.4, 4.6, 4.8];
    console.log('\n评分分布:');
    for (let i = 0; i < buckets.length; i += 1) {
        const lo = buckets[i];
        const hi = buckets[i + 1];
        const n = list.filter((p) => p._rating >= lo && (hi === undefined || p._rating < hi)).length;
        console.log(`  ${lo}${hi ? '~' + hi : '+'}: ${n} 家`);
    }

    if (APPLY) {
        let inserted = 0;
        for (const poi of list) {
            const [lng, lat] = String(poi.location).split(',').map(Number);
            if (!Number.isFinite(lng) || !Number.isFinite(lat)) continue;
            const tags = ['就近随便吃', ...extraTags(poi)];
            await pool.query(
                `INSERT INTO food_options(name, emoji, tags, latitude, longitude, address)
                 VALUES ($1, $2, $3, $4, $5, $6)
                 ON CONFLICT DO NOTHING`,
                [poi.name, guessEmoji(poi.name), tags, lat, lng, buildAddress(poi)]
            );
            inserted += 1;
        }
        console.log(`\n已入库 ${inserted} 家(标签:就近随便吃 + 类型)。`);
        console.log('记得 npm run export 更新快照。');
    }

    if (!APPLY) {
        console.log('\n确认没问题后跑:node scripts/fetch-pois.mjs --apply');
    }
}

// 与 emoji-rules.js 同源的兜底(脚本单独跑,不引前端那份也行——直接 require)
function guessEmoji(name) {
    const rules = JSON.parse(readFileSync(new URL('../package.json', import.meta.url)));
    void rules;
    const table = [['火锅', '🍲'], ['烧烤', '🍢'], ['烤肉', '🍖'], ['面', '🍜'], ['小吃', '🥢'], ['粉', '🍜'],
        ['虾', '🦐'], ['蟹', '🦀'], ['鱼', '🐟'], ['鸭', '🦆'], ['鸡', '🍗'], ['牛', '🥩'], ['肉', '🥩'],
        ['茶', '🍵'], ['咖啡', '☕'], ['寿司', '🍣'], ['日料', '🍣'], ['披萨', '🍕'], ['汉堡', '🍔'],
        ['饺子', '🥟'], ['包子', '🥟'], ['粥', '🥣'], ['饭', '🍚'], ['甜品', '🍰'], ['烘焙', '🍰']];
    for (const [kw, emoji] of table) {
        if (String(name).includes(kw)) return emoji;
    }
    return '🍽️';
}

main()
    .catch((error) => {
        console.error('拉取失败:', error.message);
        process.exitCode = 1;
    })
    .finally(() => pool.end());
