#!/usr/bin/env node
/*
 * 批量给没坐标的店查位置（高德「关键字搜索」Web 服务 API），直接入库。
 *
 *   npm run geocode             # 查询并写库
 *   npm run geocode -- --dry-run# 只打印结果，不写库
 *
 * 需要「Web 服务」类型的 key（JSAPI key 不行，会返回 USERKEY_PLAT_NOMATCH）：
 *   .env 里配 AMAP_WEB_KEY=xxx
 *
 * 匹配策略：keywords = 店名 + scripts/geocode-hints.json 里的地址提示（如有）；
 * 候选的 poi 名与店名互为包含才算命中，否则宁可留空也不猜 —— 留空的店会列在
 * 复核清单里，人工确认后可以在管理页补坐标。
 * 个人开发者 QPS 有限制，请求间隔 350ms。
 */

const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const ROOT = path.join(__dirname, '..');

function loadEnvFile() {
    const envPath = path.join(ROOT, '.env');
    if (!fs.existsSync(envPath)) return;

    for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
        const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
        if (!match) continue;

        let value = match[2].trim();
        if (/^".*"$/.test(value) || /^'.*'$/.test(value)) {
            value = value.slice(1, -1);
        }
        if (value && process.env[match[1]] === undefined) {
            process.env[match[1]] = value;
        }
    }
}

loadEnvFile();

const AMAP_WEB_KEY = (process.env.AMAP_WEB_KEY || '').trim();
const DATABASE_URL = process.env.DATABASE_URL;
const DRY_RUN = process.argv.includes('--dry-run');
const REQUEST_GAP_MS = 350;
const CITY = '杭州';

if (!DATABASE_URL) {
    console.error('缺少 DATABASE_URL（可放在 .env 里）。');
    process.exit(1);
}

if (!AMAP_WEB_KEY) {
    console.error('缺少 AMAP_WEB_KEY。到 lbs.amap.com 控制台创建一个「Web 服务」类型的 key，');
    console.error('写进 .env（AMAP_WEB_KEY=xxx）后重跑。JSAPI 类型的 key 查不了坐标。');
    process.exit(2);
}

const pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : undefined
});

function loadHints() {
    const file = path.join(__dirname, 'geocode-hints.json');
    if (!fs.existsSync(file)) return {};
    try {
        return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (error) {
        console.warn(`geocode-hints.json 解析失败（忽略提示词）: ${error.message}`);
        return {};
    }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function normalize(text) {
    return String(text || '').replace(/[·\s·]/g, '').toLowerCase();
}

async function searchPois(keywords) {
    const url = 'https://restapi.amap.com/v3/place/text'
        + `?key=${encodeURIComponent(AMAP_WEB_KEY)}`
        + `&keywords=${encodeURIComponent(keywords)}`
        + `&city=${encodeURIComponent(CITY)}&citylimit=true&offset=5&page=1`;

    const response = await fetch(url);
    const body = await response.json();

    if (body.status !== '1') {
        throw new Error(`高德 API 返回失败: ${body.info} (${body.infocode})`);
    }
    return body.pois || [];
}

// 同一家店可能有几种叫法（去掉 · / 后缀），由宽到窄依次尝试
function queryVariants(name, hint) {
    const variants = [];
    if (hint) variants.push(`${name} ${hint}`);
    variants.push(name);
    const withoutDot = name.replace(/·/g, '');
    if (withoutDot !== name) variants.push(withoutDot);
    const firstSegment = name.split('·')[0];
    if (firstSegment && firstSegment !== name && firstSegment.length >= 2) variants.push(firstSegment);
    return [...new Set(variants)];
}

function buildAddress(poi) {
    const parts = [poi.adname, poi.address].filter(Boolean);
    let address = parts.join('').trim();
    if (!address) address = [poi.pname, poi.cityname, poi.adname].filter(Boolean).join('');
    return address.slice(0, 200);
}

async function geocodeOne(name, hint) {
    for (const keywords of queryVariants(name, hint)) {
        const pois = await searchPois(keywords);
        const key = normalize(name);

        const matched = pois.filter((poi) => {
            const poiName = normalize(poi.name);
            return poiName.includes(key) || key.includes(poiName);
        });

        if (matched.length === 1) {
            return { poi: matched[0], keywords };
        }
        if (matched.length > 1) {
            // 多个候选取第一个也是同名的那家往往就是分店；保守起见标注待复核
            return { poi: matched[0], keywords, ambiguous: matched.map((poi) => poi.name) };
        }
        await sleep(REQUEST_GAP_MS);
    }
    return null;
}

async function main() {
    const hints = loadHints();

    const pending = await pool.query(
        'SELECT id, name FROM food_options WHERE latitude IS NULL OR longitude IS NULL ORDER BY id'
    );

    if (pending.rowCount === 0) {
        console.log('所有店都已有坐标，无事可做。');
        return;
    }

    console.log(`待定位 ${pending.rowCount} 家（${DRY_RUN ? 'dry-run，不写库' : '命中即写库'}）\n`);
    const unresolved = [];
    let updated = 0;

    const reportHit = (name, poi, keywords, ambiguous) => {
        const note = ambiguous ? ` ⚠️多候选: ${ambiguous.join(' / ')}` : '';
        console.log(`✓ ${name} → ${poi.location} ${buildAddress(poi)} (via "${keywords}")${note}`);
    };

    for (const option of pending.rows) {
        const hint = hints[option.name] || '';

        let result;
        try {
            result = await geocodeOne(option.name, hint);
        } catch (error) {
            console.error(`✗ ${option.name}: ${error.message}`);
            if (/QUOTA|LIMIT|INVALID_USER_KEY/i.test(error.message)) {
                console.error('key 配额或类型问题，中止本次运行。');
                break;
            }
            await sleep(REQUEST_GAP_MS);
            continue;
        }

        if (!result) {
            unresolved.push(option.name);
            console.log(`? ${option.name}: 没有可信候选（人工复核）`);
        } else {
            const { poi, keywords, ambiguous } = result;
            const [longitude, latitude] = String(poi.location || '').split(',').map(Number);

            if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
                unresolved.push(option.name);
                console.log(`? ${option.name}: 候选「${poi.name}」没有坐标`);
            } else if (DRY_RUN) {
                reportHit(option.name, poi, keywords, ambiguous);
                updated += 1;
            } else {
                await pool.query(
                    'UPDATE food_options SET latitude = $1, longitude = $2, address = $3, updated_at = NOW() WHERE id = $4',
                    [latitude, longitude, buildAddress(poi), option.id]
                );
                updated += 1;
                reportHit(option.name, poi, keywords, ambiguous);
            }
        }

        await sleep(REQUEST_GAP_MS);
    }

    console.log(`\n完成：${DRY_RUN ? 'dry-run 命中（未写库）' : '定位入库'} ${updated} 家，待人工复核 ${unresolved.length} 家`);
    if (unresolved.length) {
        console.log(unresolved.map((name) => `  - ${name}`).join('\n'));
    }
    if (!DRY_RUN && updated > 0) {
        console.log('\n别忘了 npm run export 把坐标写进快照。');
    }
}

main()
    .catch((error) => {
        console.error('地理编码失败:', error.message);
        process.exitCode = 1;
    })
    .finally(() => pool.end());
