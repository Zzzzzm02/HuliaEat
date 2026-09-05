const express = require('express');
const path = require('path');
const fs = require('fs/promises');
const fsSync = require('fs');
const crypto = require('crypto');
const { Pool } = require('pg');
// 与前端共用一份关键词表（见 emoji-rules.js 顶部说明）
const EMOJI_RULES = require('./emoji-rules');

/*
 * 轻量 .env 装载（约 15 行，故意不引入 dotenv）。
 * 规则：只填补缺失项，已存在的环境变量优先 —— 这样容器/CI 显式传参不会被本地文件覆盖。
 */
(function loadEnvFile() {
    const envPath = path.join(__dirname, '.env');
    if (!fsSync.existsSync(envPath)) return;

    for (const line of fsSync.readFileSync(envPath, 'utf8').split('\n')) {
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
})();

const app = express();
const PORT = Number(process.env.PORT) || 3000;
// 默认只绑回环：误启动不会把服务泄露给整个局域网（容器部署需显式设 HOST=0.0.0.0）
const HOST = (process.env.HOST || '127.0.0.1').trim() || '127.0.0.1';
const IS_PUBLIC_BIND = HOST === '0.0.0.0' || HOST === '::' || HOST === '*' || HOST === '::0';
const DATABASE_URL = process.env.DATABASE_URL;
const DATABASE_SSL = process.env.DATABASE_SSL === 'true';
const SEED_FILE = process.env.SEED_FILE || path.join(__dirname, 'data', 'options.json');

const MAX_NAME_LENGTH = 40;
const MAX_EMOJI_LENGTH = 8;
const MAX_ADDRESS_LENGTH = 200;
const MAX_TAG_LENGTH = 12;
const MAX_TAGS_COUNT = 6;

/* ---------------- 安全相关配置 ---------------- */

const IS_PRODUCTION = process.env.NODE_ENV === 'production';
const ADMIN_TOKEN = (process.env.ADMIN_TOKEN || '').trim();

// 高德地图：JSAPI key 随 GET /api/config 下发（它本来就是设计给浏览器用的公开值，
// 建议在高德控制台给 key 配域名白名单）；AMAP_WEB_KEY 只在服务端用——批量地理编码
// 脚本和下面的静态缩略图代理，都不下发给前端
const AMAP_JSAPI_KEY = (process.env.AMAP_JSAPI_KEY || '').trim();
const AMAP_SECURITY_CODE = (process.env.AMAP_SECURITY_CODE || '').trim();
const AMAP_WEB_KEY = (process.env.AMAP_WEB_KEY || '').trim();

// 跨域写操作白名单：逗号分隔的 Origin，例如 "https://admin.example.com,https://fox.example.com"
const CORS_ALLOWED_ORIGINS = new Set(
    (process.env.CORS_ALLOWED_ORIGINS || '')
        .split(',')
        .map((item) => normalizeOriginValue(item))
        .filter(Boolean)
);

// 管理密钥失败次数限流（防止公网暴力猜密钥）
const AUTH_FAIL_WINDOW_MS = 5 * 60 * 1000;
const AUTH_FAIL_MAX = 20;

if (!DATABASE_URL) {
    console.error('启动失败：缺少 DATABASE_URL 环境变量。');
    console.error('示例：postgresql://user:password@host:5432/database');
    process.exit(1);
}

if (!ADMIN_TOKEN) {
    if (IS_PRODUCTION) {
        console.error('启动失败：NODE_ENV=production 时必须设置 ADMIN_TOKEN。');
        console.error('生成方式：node -e "console.log(require(\'crypto\').randomBytes(24).toString(\'hex\'))"');
        console.error('开发调试请改用 NODE_ENV=development 启动，或不要在公网暴露该服务。');
        process.exit(1);
    }

    console.warn('⚠️  安全警告：未设置 ADMIN_TOKEN，当前为开发模式。');
    console.warn('    所有写接口（新增/编辑/删除/导入）无需密钥即可调用。');
    console.warn('    上线务必设置 NODE_ENV=production 与足够随机的 ADMIN_TOKEN。');
}

const pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: DATABASE_SSL ? { rejectUnauthorized: false } : undefined
});

pool.on('error', (error) => {
    console.error('PostgreSQL 连接池异常:', error);
});

/* ---------------- 安全策略 ---------------- */

const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

// 只显式放行前端真正需要的资源，避免把仓库内容（README / package.json / data / .git）整体暴露出去
const SERVED_FILES = new Map([
    ['/styles.css', { file: 'styles.css', type: 'text/css; charset=utf-8' }],
    ['/script.js', { file: 'script.js', type: 'application/javascript; charset=utf-8' }],
    ['/emoji-rules.js', { file: 'emoji-rules.js', type: 'application/javascript; charset=utf-8' }],
    ['/map.js', { file: 'map.js', type: 'application/javascript; charset=utf-8' }],
    // PWA：sw.js 必须 no-cache，否则更新会卡在浏览器缓存上
    ['/manifest.webmanifest', { file: 'manifest.webmanifest', type: 'application/manifest+json; charset=utf-8' }],
    ['/sw.js', { file: 'sw.js', type: 'application/javascript; charset=utf-8', cache: 'no-cache' }],
    ['/icons/icon-192.png', { file: 'icons/icon-192.png', type: 'image/png', cache: 'public, max-age=604800' }],
    ['/icons/icon-512.png', { file: 'icons/icon-512.png', type: 'image/png', cache: 'public, max-age=604800' }],
    ['/icons/icon-180.png', { file: 'icons/icon-180.png', type: 'image/png', cache: 'public, max-age=604800' }]
]);

function parseOrigin(value) {
    try {
        return new URL(value);
    } catch (error) {
        return null;
    }
}

function originHost(value) {
    const parsed = parseOrigin(value);
    return parsed ? parsed.host.toLowerCase() : null;
}

function normalizeOriginValue(value) {
    const raw = String(value || '').trim();
    if (!raw) return '';

    const parsed = parseOrigin(raw);
    if (!parsed) return raw.toLowerCase();

    // 去掉末尾多余的 path/slash，统一成 "scheme://host" 便于精确比对
    const scheme = parsed.protocol.replace(':', '').toLowerCase();
    return `${scheme}://${parsed.host.toLowerCase()}`;
}

function requestOrigin(req) {
    return normalizeOriginValue(req.get('origin'));
}

function isSameOrigin(req) {
    const raw = req.get('origin');
    if (!raw) return true; // 非浏览器请求（curl / 服务端调用）没有 Origin

    const host = originHost(raw);
    if (!host) return false;

    // 只比较 host:port：浏览器无法伪造 Host，且经反代后我们未必知道真实 scheme
    const forwardedHost = (req.get('x-forwarded-host') || req.get('host') || '').trim().toLowerCase();
    return Boolean(forwardedHost) && host === forwardedHost;
}

function applySecurityHeaders(req, res, next) {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    next();
}

function corsPolicy(req, res, next) {
    const origin = requestOrigin(req);

    if (!origin || isSameOrigin(req)) {
        res.setHeader('Vary', 'Origin');
        return next();
    }

    const requestedMethod = (req.get('access-control-request-method') || req.method).toUpperCase();
    const isWrite = WRITE_METHODS.has(requestedMethod);
    const allowed = CORS_ALLOWED_ORIGINS.has(origin.toLowerCase());

    // 跨域写操作默认拒绝：读接口保持公开，写接口只放行同域与白名单来源
    if (isWrite && !allowed) {
        return res.status(403).json({ error: '该来源不在写操作白名单内（CORS_ALLOWED_ORIGINS）' });
    }

    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');

    if (req.method === 'OPTIONS') {
        res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type,X-Admin-Token,Authorization');
        res.setHeader('Access-Control-Max-Age', '600');
        return res.status(204).end();
    }

    return next();
}

function timingSafeTokenEqual(candidate, expected) {
    // 先各自做 sha256，避免长度差异带来的时序信息，再做常量时间比较
    const a = crypto.createHash('sha256').update(String(candidate)).digest();
    const b = crypto.createHash('sha256').update(String(expected)).digest();
    return crypto.timingSafeEqual(a, b);
}

function extractAdminToken(req) {
    const header = req.get('x-admin-token');
    if (typeof header === 'string' && header.trim()) return header.trim();

    const authorization = req.get('authorization') || '';
    const match = /^Bearer\s+(.+)$/i.exec(authorization.trim());
    return match ? match[1].trim() : '';
}

const authFailures = new Map();

function isRateLimited(key, now) {
    const record = authFailures.get(key);
    if (!record) return false;
    if (record.resetAt <= now) {
        authFailures.delete(key);
        return false;
    }
    return record.count >= AUTH_FAIL_MAX;
}

function recordAuthFailure(key, now) {
    if (authFailures.size > 1000) {
        for (const [existingKey, record] of authFailures) {
            if (record.resetAt <= now) authFailures.delete(existingKey);
        }
    }

    const record = authFailures.get(key);
    if (!record || record.resetAt <= now) {
        authFailures.set(key, { count: 1, resetAt: now + AUTH_FAIL_WINDOW_MS });
        return;
    }
    record.count += 1;
}

function requireAdmin(req, res, next) {
    // 开发模式（未配置 ADMIN_TOKEN）放行，启动时已打印警告
    if (!ADMIN_TOKEN) return next();

    const now = Date.now();
    const key = req.ip || (req.socket && req.socket.remoteAddress) || 'unknown';

    if (isRateLimited(key, now)) {
        return res.status(429).json({ error: '管理密钥错误次数过多，请稍后再试' });
    }

    const token = extractAdminToken(req);

    if (!token || !timingSafeTokenEqual(token, ADMIN_TOKEN)) {
        recordAuthFailure(key, now);
        console.warn(`拒绝未授权写操作: ${req.method} ${req.originalUrl} (来源 ${key})`);
        return res.status(401).json({ error: '缺少或错误的管理密钥，请在页面中输入 ADMIN_TOKEN' });
    }

    authFailures.delete(key);
    return next();
}

if (process.env.TRUST_PROXY === 'true') {
    // 部署在 Nginx / 负载均衡之后时开启，用于取到真实客户端 IP
    app.set('trust proxy', 1);
}

app.disable('x-powered-by');

app.use(applySecurityHeaders);
app.use(corsPolicy);
app.use(express.json({ limit: '100kb' }));

const DEFAULT_OPTIONS = [
    { name: '川菜', emoji: '🌶️' },
    { name: '粤菜', emoji: '🍤' },
    { name: '湘菜', emoji: '🥘' },
    { name: '鲁菜', emoji: '🐟' },
    { name: '苏菜', emoji: '🦐' },
    { name: '浙菜', emoji: '🍜' },
    { name: '闽菜', emoji: '🦪' },
    { name: '徽菜', emoji: '🥩' },
    { name: '火锅', emoji: '🍲' },
    { name: '烧烤', emoji: '🍢' },
    { name: '麻辣烫', emoji: '🌶️' },
    { name: '串串香', emoji: '🍡' },
    { name: '寿司', emoji: '🍣' },
    { name: '拉面', emoji: '🍜' },
    { name: '披萨', emoji: '🍕' },
    { name: '汉堡', emoji: '🍔' },
    { name: '炸鸡', emoji: '🍗' },
    { name: '牛排', emoji: '🥩' },
    { name: '意大利面', emoji: '🍝' },
    { name: '生鱼片', emoji: '🐟' },
    { name: '天妇罗', emoji: '🍤' },
    { name: '咖喱饭', emoji: '🍛' },
    { name: '石锅拌饭', emoji: '🍚' },
    { name: '冷面', emoji: '🍜' },
    { name: '烤肉', emoji: '🥩' },
    { name: '烤鸭', emoji: '🦆' },
    { name: '包子', emoji: '🥟' },
    { name: '饺子', emoji: '🥟' },
    { name: '馄饨', emoji: '🥟' },
    { name: '面条', emoji: '🍜' },
    { name: '米饭', emoji: '🍚' },
    { name: '粥', emoji: '🍲' },
    { name: '肠粉', emoji: '🍤' },
    { name: '烧腊', emoji: '🥩' },
    { name: '卤味', emoji: '🍗' },
    { name: '凉拌菜', emoji: '🥗' },
    { name: '甜品', emoji: '🍰' },
    { name: '奶茶', emoji: '🥤' },
    { name: '咖啡', emoji: '☕' }
];

function normalizeText(value) {
    if (typeof value !== 'string') return '';
    return value.trim();
}

function parseId(rawId) {
    const text = String(rawId);
    if (!/^[0-9]+$/.test(text)) return null;

    const id = Number(text);
    return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function normalizeSeedOption(option) {
    if (!option || typeof option !== 'object') return null;

    const name = normalizeText(option.name);
    const emoji = normalizeText(option.emoji);

    if (!name || !emoji) return null;
    if (name.length > MAX_NAME_LENGTH) return null;
    if (emoji.length > MAX_EMOJI_LENGTH) return null;

    const result = { name, emoji };

    // 地理信息可选：种子是受信文件，坐标坏了就丢坐标保店铺，不让一家店挡住整份种子
    const latitude = parseCoordinateValue(option.latitude, -90, 90);
    const longitude = parseCoordinateValue(option.longitude, -180, 180);
    if (latitude !== null && longitude !== null) {
        result.latitude = latitude;
        result.longitude = longitude;
    }

    const address = normalizeText(option.address);
    if (address && address.length <= MAX_ADDRESS_LENGTH) {
        result.address = address;
    }

    const tags = normalizeTagArray(option.tags);
    if (tags.length) {
        result.tags = tags;
    }

    return result;
}

// 宽松解析（种子/快照用）：只留合法的短字符串标签，其余静默丢弃
function normalizeTagArray(rawTags) {
    if (!Array.isArray(rawTags)) return [];
    const seen = new Set();
    const tags = [];
    for (const raw of rawTags) {
        const tag = normalizeText(raw);
        if (!tag || tag.length > MAX_TAG_LENGTH || seen.has(tag)) continue;
        seen.add(tag);
        tags.push(tag);
        if (tags.length >= MAX_TAGS_COUNT) break;
    }
    return tags;
}

// 宽松解析（种子/快照用）：不是合法数字或越界就返回 null，静默丢弃
function parseCoordinateValue(value, min, max) {
    if (typeof value === 'string' && value.trim() !== '') value = Number(value);
    if (typeof value !== 'number' || !Number.isFinite(value)) return null;
    if (value < min || value > max) return null;
    return value;
}

function dedupeByName(options) {
    const seen = new Set();
    const result = [];

    for (const option of options) {
        const key = option.name.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        result.push(option);
    }

    return result;
}

function validatePayload(payload, { partial = false } = {}) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        return { ok: false, error: '请求体必须是 JSON 对象' };
    }

    const hasName = Object.prototype.hasOwnProperty.call(payload, 'name');
    const hasEmoji = Object.prototype.hasOwnProperty.call(payload, 'emoji');
    const hasLatitude = Object.prototype.hasOwnProperty.call(payload, 'latitude');
    const hasLongitude = Object.prototype.hasOwnProperty.call(payload, 'longitude');
    const hasAddress = Object.prototype.hasOwnProperty.call(payload, 'address');
    const hasTags = Object.prototype.hasOwnProperty.call(payload, 'tags');

    if (!partial && (!hasName || !hasEmoji)) {
        return { ok: false, error: 'name 和 emoji 都是必填项' };
    }

    if (partial && !hasName && !hasEmoji && !hasLatitude && !hasLongitude && !hasAddress && !hasTags) {
        return { ok: false, error: '至少提供一个可修改字段（name / emoji / latitude / longitude / address / tags）' };
    }

    const result = {};

    if (hasName) {
        const name = normalizeText(payload.name);
        if (!name) return { ok: false, error: 'name 不能为空' };
        if (name.length > MAX_NAME_LENGTH) {
            return { ok: false, error: `name 最长不能超过 ${MAX_NAME_LENGTH} 个字符` };
        }
        result.name = name;
    }

    if (hasEmoji) {
        const emoji = normalizeText(payload.emoji);
        if (!emoji) return { ok: false, error: 'emoji 不能为空' };
        if (emoji.length > MAX_EMOJI_LENGTH) {
            return { ok: false, error: `emoji 最长不能超过 ${MAX_EMOJI_LENGTH} 个字符` };
        }
        result.emoji = emoji;
    }

    // 地理字段严格校验：一旦出现在请求里就必须合法（null = 清除），否则整个请求 400
    if (hasLatitude) {
        const parsed = parseCoordinateInput(payload.latitude, { min: -90, max: 90, label: 'latitude' });
        if (parsed.error) return { ok: false, error: parsed.error };
        result.latitude = parsed.clear ? null : parsed.value;
    }

    if (hasLongitude) {
        const parsed = parseCoordinateInput(payload.longitude, { min: -180, max: 180, label: 'longitude' });
        if (parsed.error) return { ok: false, error: parsed.error };
        result.longitude = parsed.clear ? null : parsed.value;
    }

    if (hasAddress) {
        const address = normalizeText(payload.address);
        if (address.length > MAX_ADDRESS_LENGTH) {
            return { ok: false, error: `address 最长不能超过 ${MAX_ADDRESS_LENGTH} 个字符` };
        }
        result.address = address || null;
    }

    // 类型标签严格校验：必须是字符串数组，自动去空去重；空数组 = 清除全部标签。
    // 请求里给了就不静默修正错误项（超长/超量直接 400），与坐标同一套"填了就必须合法"的哲学
    if (hasTags) {
        if (!Array.isArray(payload.tags)) {
            return { ok: false, error: 'tags 必须是字符串数组' };
        }
        for (const raw of payload.tags) {
            if (typeof raw !== 'string' || !normalizeText(raw)) {
                return { ok: false, error: 'tags 里的每一项都必须是非空字符串' };
            }
            if (normalizeText(raw).length > MAX_TAG_LENGTH) {
                return { ok: false, error: `单个标签最长不能超过 ${MAX_TAG_LENGTH} 个字符` };
            }
        }
        if (payload.tags.length > MAX_TAGS_COUNT) {
            return { ok: false, error: `tags 最多 ${MAX_TAGS_COUNT} 个` };
        }
        result.tags = normalizeTagArray(payload.tags);
    }

    // POST/PUT 没有现值可配对：经纬度必须成对出现
    if (!partial && hasLatitude !== hasLongitude) {
        return { ok: false, error: 'latitude 和 longitude 必须成对提供' };
    }

    return { ok: true, data: result };
}

// 严格解析（接口请求用）：null 表示清除，其余必须是可以入库的数字，带错误信息返回
function parseCoordinateInput(raw, { min, max, label }) {
    if (raw === null) return { clear: true };
    if (typeof raw === 'boolean') return { error: `${label} 必须是数字` };
    if (typeof raw === 'string') {
        if (!raw.trim()) return { error: `${label} 不能是空字符串（要清除请传 null）` };
        raw = Number(raw);
    }
    if (typeof raw !== 'number' || !Number.isFinite(raw)) return { error: `${label} 必须是数字` };
    if (raw < min || raw > max) return { error: `${label} 超出有效范围（${min} ~ ${max}）` };
    return { value: raw };
}

// 与前端 script.js 的 guessEmoji 同一套规则（表来自 emoji-rules.js）
function guessEmoji(name) {
    for (const [keyword, emoji] of EMOJI_RULES) {
        if (name.includes(keyword)) return emoji;
    }
    return '🍽️';
}

function normalizeImportItem(item) {
    if (!item || typeof item !== 'object') return null;

    const name = normalizeText(item.name);
    if (!name || name.length > MAX_NAME_LENGTH) return null;

    let emoji = normalizeText(item.emoji);
    if (!emoji || emoji.length > MAX_EMOJI_LENGTH) emoji = guessEmoji(name);

    const result = { name, emoji };
    const hasOwn = Object.prototype.hasOwnProperty;

    // 可选地理信息：填了就必须合法，带 error 返回由调用方 400（比静默丢弃更早暴露问题）
    const hasLatitude = hasOwn.call(item, 'latitude');
    const hasLongitude = hasOwn.call(item, 'longitude');
    if (hasLatitude !== hasLongitude) {
        return { error: `「${name}」的 latitude 和 longitude 必须成对提供` };
    }

    if (hasLatitude) {
        const lat = parseCoordinateInput(item.latitude, { min: -90, max: 90, label: 'latitude' });
        if (lat.error) return { error: `「${name}」的 ${lat.error}` };
        const lng = parseCoordinateInput(item.longitude, { min: -180, max: 180, label: 'longitude' });
        if (lng.error) return { error: `「${name}」的 ${lng.error}` };
        result.latitude = lat.clear ? null : lat.value;
        result.longitude = lng.clear ? null : lng.value;
    }

    if (hasOwn.call(item, 'address')) {
        const address = normalizeText(item.address);
        if (address.length > MAX_ADDRESS_LENGTH) {
            return { error: `「${name}」的 address 超过 ${MAX_ADDRESS_LENGTH} 个字符` };
        }
        result.address = address || null;
    }

    if (hasOwn.call(item, 'tags')) {
        if (!Array.isArray(item.tags)) {
            return { error: `「${name}」的 tags 必须是字符串数组` };
        }
        for (const raw of item.tags) {
            if (typeof raw !== 'string' || !normalizeText(raw)) {
                return { error: `「${name}」的 tags 每一项都必须是非空字符串` };
            }
            if (normalizeText(raw).length > MAX_TAG_LENGTH) {
                return { error: `「${name}」的单个标签超过 ${MAX_TAG_LENGTH} 个字符` };
            }
        }
        if (item.tags.length > MAX_TAGS_COUNT) {
            return { error: `「${name}」的 tags 超过 ${MAX_TAGS_COUNT} 个` };
        }
        result.tags = normalizeTagArray(item.tags);
    }

    return result;
}

const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

/* ---------------- 迁移：migrations/NNN_*.sql 按序执行 ---------------- */

async function runMigrations() {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
            name TEXT PRIMARY KEY,
            applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
    `);

    let files;
    try {
        files = (await fs.readdir(MIGRATIONS_DIR))
            .filter((file) => /^\d+_.*\.sql$/.test(file))
            .sort();
    } catch (error) {
        console.warn(`未找到 migrations 目录（${MIGRATIONS_DIR}），跳过迁移。`);
        return;
    }

    const appliedResult = await pool.query('SELECT name FROM schema_migrations');
    const applied = new Set(appliedResult.rows.map((row) => row.name));

    for (const file of files) {
        if (applied.has(file)) continue;

        const sql = await fs.readFile(path.join(MIGRATIONS_DIR, file), 'utf8');
        const client = await pool.connect();

        try {
            await client.query('BEGIN');
            await client.query(sql);
            await client.query('INSERT INTO schema_migrations(name) VALUES ($1)', [file]);
            await client.query('COMMIT');
            console.log(`已应用迁移: ${file}`);
        } catch (error) {
            await client.query('ROLLBACK');
            throw new Error(`迁移 ${file} 失败: ${error.message}`);
        } finally {
            client.release();
        }
    }
}

/* ---------------- 种子：兼容 v1 裸数组 / v2 多榜单 / v3 类型标签 ---------------- */

function normalizeSeedDocument(parsed) {
    // v1：[{ name, emoji }, ...]
    if (Array.isArray(parsed)) {
        const options = dedupeByName(parsed.map(normalizeSeedOption).filter(Boolean));
        return { options };
    }

    // v2：{ version: 2, lists: [...], options: [{ name, emoji, lists: [榜单名] }] }
    // v3：{ version: 3, options: [{ name, emoji, tags: [标签] , ...地理 }] }
    // v2 的 lists 声明已随榜单体系退役，这里只取 options（v2 的 lists 成员关系
    // 已由 005 迁移在数据库里转成标签，不再从种子回放）
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.options)) {
        throw new Error('种子文件格式错误：应为数组，或含 options 数组的对象');
    }

    const merged = new Map();

    for (const raw of parsed.options) {
        const option = normalizeSeedOption(raw);
        if (!option) continue;

        const key = option.name.toLowerCase();
        if (!merged.has(key)) {
            merged.set(key, option);
            continue;
        }

        // 重名行合并：以先出现的为准，标签取并集
        const existing = merged.get(key);
        existing.tags = normalizeTagArray([...(existing.tags || []), ...(option.tags || [])]);
    }

    const options = [...merged.values()];

    if (options.length === 0) {
        throw new Error('种子文件没有有效数据');
    }

    return { options };
}

async function loadSeedDocument() {
    try {
        const content = await fs.readFile(SEED_FILE, 'utf8');
        return normalizeSeedDocument(JSON.parse(content));
    } catch (error) {
        console.warn(`读取种子文件失败，将回退默认菜单。原因: ${error.message}`);
        return normalizeSeedDocument([...DEFAULT_OPTIONS]);
    }
}

async function seedIfEmpty() {
    const countResult = await pool.query('SELECT COUNT(*)::int AS count FROM food_options');
    if (countResult.rows[0].count > 0) return;

    const seed = await loadSeedDocument();

    const client = await pool.connect();
    let inTransaction = false;

    try {
        await client.query('BEGIN');
        inTransaction = true;

        for (const option of seed.options) {
            await client.query(
                `INSERT INTO food_options(name, emoji, latitude, longitude, address, tags)
                 VALUES ($1, $2, $3, $4, $5, $6)`,
                [
                    option.name,
                    option.emoji,
                    option.latitude ?? null,
                    option.longitude ?? null,
                    option.address ?? null,
                    option.tags ?? []
                ]
            );
        }

        await client.query('COMMIT');
        console.log(`已从种子文件初始化 ${seed.options.length} 家餐厅`);
    } catch (error) {
        if (inTransaction) {
            await client.query('ROLLBACK');
        }
        throw error;
    } finally {
        client.release();
    }
}

async function initDb() {
    await runMigrations();
    await seedIfEmpty();
}

async function getOptionCount() {
    const result = await pool.query('SELECT COUNT(*)::int AS count FROM food_options');
    return result.rows[0].count;
}

/* ---------------- 静态资源（显式白名单） ---------------- */

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

for (const [route, meta] of SERVED_FILES) {
    app.get(route, (req, res) => {
        if (meta.cache) {
            res.set('Cache-Control', meta.cache);
        }
        res.type(meta.type).sendFile(path.join(__dirname, meta.file));
    });
}

// 前端只引用 image1/ 下的图片，其余目录（data/、.git/、源码）一律不对外暴露
app.use('/image1', express.static(path.join(__dirname, 'image1'), {
    index: false,
    dotfiles: 'deny'
}));

app.get('/api/health', async (req, res) => {
    try {
        const optionCount = await getOptionCount();
        res.json({
            status: 'ok',
            timestamp: new Date().toISOString(),
            uptimeSeconds: Number(process.uptime().toFixed(0)),
            optionCount,
            storage: 'postgres'
        });
    } catch (error) {
        res.status(503).json({
            status: 'degraded',
            timestamp: new Date().toISOString(),
            error: '数据库连接异常',
            storage: 'postgres'
        });
    }
});

// 前端地图页初始化要用的公开配置。未配置 JSAPI key 时返回 null，地图页据此显示配置指引
app.get('/api/config', (req, res) => {
    res.json({
        amap: AMAP_JSAPI_KEY
            ? { key: AMAP_JSAPI_KEY, securityCode: AMAP_SECURITY_CODE || null }
            : null
    });
});

// 管理入口解锁校验：密钥对 → 200（前端据此显示「管理选项」），错/缺 → 401。
// 管理界面本身对普通访客隐藏，只有持有 ADMIN_TOKEN 的人能解锁
app.get('/api/admin/check', requireAdmin, (req, res) => {
    res.json({ ok: true });
});

const OPTIONS_SELECT = `
    SELECT o.id, o.name, o.emoji, o.latitude, o.longitude, o.address, o.tags
    FROM food_options o
`;

app.get('/api/options', async (req, res, next) => {
    try {
        const tag = normalizeText(req.query.tag);
        const nearRaw = normalizeText(req.query.near);

        // 定位就近模式：near=经度,纬度，可选 radius（米，默认 1500，上限 10000）。
        // 只返回已定位的店，按距离升序，带 distance_meters
        if (nearRaw) {
            const parts = nearRaw.split(',').map(Number);
            if (parts.length !== 2 || !parts.every(Number.isFinite)) {
                return res.status(400).json({ error: 'near 格式应为 经度,纬度' });
            }
            const [lng, lat] = parts;
            const radius = Math.min(Math.max(Number(req.query.radius) || 1500, 100), 10000);
            const distExpr = `(6371000 * acos(least(1::float8, greatest(-1::float8,
                cos(radians($1)) * cos(radians(o.latitude)) * cos(radians(o.longitude) - radians($2))
                + sin(radians($1)) * sin(radians(o.latitude))))))`;
            const result = await pool.query(
                `SELECT o.id, o.name, o.emoji, o.latitude, o.longitude, o.address, o.tags,
                        round(${distExpr})::int AS distance_meters
                 FROM food_options o
                 WHERE o.latitude IS NOT NULL AND ${distExpr} <= $3
                 ORDER BY ${distExpr} ASC`,
                [lat, lng, radius]
            );
            return res.json(result.rows);
        }

        const params = [];
        let where = '';

        if (tag) {
            where = 'WHERE $1 = ANY(o.tags)';
            params.push(tag);
        }

        const result = await pool.query(
            `${OPTIONS_SELECT}
             ${where}
             ORDER BY o.id ASC`,
            params
        );

        return res.json(result.rows);
    } catch (error) {
        return next(error);
    }
});

app.get('/api/options/:id', async (req, res, next) => {
    try {
        const id = parseId(req.params.id);
        if (!id) {
            return res.status(400).json({ error: '无效的选项 ID' });
        }

        const result = await pool.query(
            `${OPTIONS_SELECT} WHERE o.id = $1`,
            [id]
        );

        if (result.rowCount === 0) {
            return res.status(404).json({ error: '选项不存在' });
        }

        return res.json(result.rows[0]);
    } catch (error) {
        return next(error);
    }
});

// 结果页的位置缩略图：服务端代理高德静态地图 API，AMAP_WEB_KEY 不出现在前端。
// 未定位/不存在的店 404，key 未配置 503 —— 前端据此隐藏缩略图块
app.get('/api/options/:id/staticmap', async (req, res, next) => {
    try {
        const id = parseId(req.params.id);
        if (!id) {
            return res.status(400).json({ error: '无效的选项 ID' });
        }

        const result = await pool.query(
            'SELECT latitude, longitude FROM food_options WHERE id = $1',
            [id]
        );
        if (result.rowCount === 0) {
            return res.status(404).json({ error: '选项不存在' });
        }
        const { latitude, longitude } = result.rows[0];
        if (latitude == null || longitude == null) {
            return res.status(404).json({ error: '该店还没有定位' });
        }
        if (!AMAP_WEB_KEY) {
            return res.status(503).json({ error: '地图服务未配置（缺少 AMAP_WEB_KEY）' });
        }

        // 个人 key 有 QPS 限制（约 3 次/秒），连续抽签容易撞上：失败就退避重试，
        // 通常一次就能落到新的限流窗口
        let lastError = null;
        for (let attempt = 0; attempt < 3; attempt += 1) {
            if (attempt > 0) {
                await new Promise((resolve) => setTimeout(resolve, 400 + Math.floor(Math.random() * 300)));
            }

            const params = new URLSearchParams({
                key: AMAP_WEB_KEY,
                location: `${longitude},${latitude}`,
                zoom: '15',
                size: '480*280',
                scale: '2',
                markers: `mid,0xE7631C,A:${longitude},${latitude}`
            });

            let upstream;
            try {
                upstream = await fetch(`https://restapi.amap.com/v3/staticmap?${params}`);
            } catch (fetchError) {
                lastError = fetchError;
                continue;
            }

            const contentType = upstream.headers.get('content-type') || '';
            if (upstream.ok && contentType.startsWith('image/')) {
                res.set('Content-Type', 'image/png');
                res.set('Cache-Control', 'public, max-age=3600');
                return res.send(Buffer.from(await upstream.arrayBuffer()));
            }
            lastError = new Error(`上游返回 ${upstream.status} ${contentType || '空 Content-Type'}`);
        }

        console.warn(`静态地图获取失败 (option ${id}): ${lastError && lastError.message}`);
        return res.status(502).json({ error: '静态地图服务暂时不可用，稍后再试' });
    } catch (error) {
        return next(error);
    }
});

app.post('/api/options', requireAdmin, async (req, res, next) => {
    try {
        const validation = validatePayload(req.body, { partial: false });
        if (!validation.ok) {
            return res.status(400).json({ error: validation.error });
        }

        const inserted = await pool.query(
            `INSERT INTO food_options(name, emoji, latitude, longitude, address, tags)
             VALUES ($1, $2, $3, $4, $5, $6)
             RETURNING id, name, emoji, latitude, longitude, address, tags`,
            [
                validation.data.name,
                validation.data.emoji,
                validation.data.latitude ?? null,
                validation.data.longitude ?? null,
                validation.data.address ?? null,
                validation.data.tags ?? []
            ]
        );

        return res.status(201).json(inserted.rows[0]);
    } catch (error) {
        if (error && error.code === '23505') {
            return res.status(409).json({ error: '已有同名店铺（改名或直接用现有的）' });
        }
        return next(error);
    }
});

app.put('/api/options/:id', requireAdmin, async (req, res, next) => {
    try {
        const id = parseId(req.params.id);
        if (!id) {
            return res.status(400).json({ error: '无效的选项 ID' });
        }

        const validation = validatePayload(req.body, { partial: false });
        if (!validation.ok) {
            return res.status(400).json({ error: validation.error });
        }

        // 坐标是附加元数据：PUT 没带的字段保留现值，带了（含 null）才更新
        const data = validation.data;
        const hasOwn = Object.prototype.hasOwnProperty;
        const assignments = ['name = $1', 'emoji = $2', 'updated_at = NOW()'];
        const params = [data.name, data.emoji];

        if (hasOwn.call(data, 'address')) {
            params.push(data.address);
            assignments.push(`address = $${params.length}`);
        }
        if (hasOwn.call(data, 'latitude')) {
            params.push(data.latitude);
            assignments.push(`latitude = $${params.length}`);
        }
        if (hasOwn.call(data, 'longitude')) {
            params.push(data.longitude);
            assignments.push(`longitude = $${params.length}`);
        }
        if (hasOwn.call(data, 'tags')) {
            params.push(data.tags ?? []);
            assignments.push(`tags = $${params.length}`);
        }
        params.push(id);
        const idIndex = params.length;

        const result = await pool.query(
            `
                UPDATE food_options
                SET ${assignments.join(', ')}
                WHERE id = $${idIndex}
                RETURNING id, name, emoji, latitude, longitude, address, tags
            `,
            params
        );

        if (result.rowCount === 0) {
            return res.status(404).json({ error: '选项不存在' });
        }

        return res.json(result.rows[0]);
    } catch (error) {
        if (error && error.code === '23505') {
            return res.status(409).json({ error: '已有同名店铺（改名或直接用现有的）' });
        }
        return next(error);
    }
});

app.patch('/api/options/:id', requireAdmin, async (req, res, next) => {
    try {
        const id = parseId(req.params.id);
        if (!id) {
            return res.status(400).json({ error: '无效的选项 ID' });
        }

        const validation = validatePayload(req.body, { partial: true });
        if (!validation.ok) {
            return res.status(400).json({ error: validation.error });
        }

        const currentResult = await pool.query(
            'SELECT id, name, emoji, latitude, longitude, address, tags FROM food_options WHERE id = $1',
            [id]
        );

        if (currentResult.rowCount === 0) {
            return res.status(404).json({ error: '选项不存在' });
        }

        const current = currentResult.rows[0];
        const data = validation.data;
        const hasOwn = Object.prototype.hasOwnProperty;

        const nextName = data.name ?? current.name;
        const nextEmoji = data.emoji ?? current.emoji;

        // 地理字段三态：没提供 → 保留现值；null → 清除；有值 → 更新。
        // 合并后经纬度必须成对存在，半对（有 lat 没 lng）一律 400
        const nextLatitude = hasOwn.call(data, 'latitude') ? data.latitude : current.latitude;
        const nextLongitude = hasOwn.call(data, 'longitude') ? data.longitude : current.longitude;
        if ((nextLatitude === null) !== (nextLongitude === null)) {
            return res.status(400).json({ error: 'latitude 和 longitude 必须成对提供或成对清除' });
        }
        const nextAddress = hasOwn.call(data, 'address') ? data.address : current.address;
        const nextTags = hasOwn.call(data, 'tags') ? (data.tags ?? []) : (current.tags ?? []);

        const updatedResult = await pool.query(
            `
                UPDATE food_options
                SET name = $1, emoji = $2, latitude = $3, longitude = $4, address = $5, tags = $6, updated_at = NOW()
                WHERE id = $7
                RETURNING id, name, emoji, latitude, longitude, address, tags
            `,
            [nextName, nextEmoji, nextLatitude, nextLongitude, nextAddress, nextTags, id]
        );

        return res.json(updatedResult.rows[0]);
    } catch (error) {
        if (error && error.code === '23505') {
            return res.status(409).json({ error: '已有同名店铺（改名或直接用现有的）' });
        }
        return next(error);
    }
});

app.delete('/api/options/:id', requireAdmin, async (req, res, next) => {
    try {
        const id = parseId(req.params.id);
        if (!id) {
            return res.status(400).json({ error: '无效的选项 ID' });
        }

        const result = await pool.query('DELETE FROM food_options WHERE id = $1', [id]);

        if (result.rowCount === 0) {
            return res.status(404).json({ error: '选项不存在' });
        }

        return res.status(204).send();
    } catch (error) {
        return next(error);
    }
});

app.post('/api/options/import', requireAdmin, async (req, res, next) => {
    try {
        const body = req.body || {};
        if (!['append', 'replace'].includes(body.mode)) {
            return res.status(400).json({ error: "mode 必须是 'append' 或 'replace'" });
        }

        const mode = body.mode;
        const rawItems = Array.isArray(body.items) ? body.items : [];

        // 逐项 normalize：带 error 的条目（非法坐标等）直接 400，避免一半入库一半丢失
        const normalized = rawItems.map((item, index) => ({ item: normalizeImportItem(item), index }));
        const firstError = normalized.find((entry) => entry.item && entry.item.error);
        if (firstError) {
            return res.status(400).json({ error: `第 ${firstError.index + 1} 项：${firstError.item.error}` });
        }

        const items = dedupeByName(normalized.map((entry) => entry.item).filter(Boolean));

        if (items.length === 0) {
            return res.status(400).json({ error: '没有可导入的有效选项' });
        }

        const client = await pool.connect();
        let inTransaction = false;
        let created = 0;

        try {
            await client.query('BEGIN');
            inTransaction = true;

            if (mode === 'replace') {
                await client.query('TRUNCATE food_options RESTART IDENTITY CASCADE');
            }

            for (const item of items) {
                // 重名不新建行，而是复用已有那一家 —— 否则会出现同一家店的两份真相
                const found = await client.query(
                    'SELECT id FROM food_options WHERE LOWER(name) = LOWER($1) ORDER BY id LIMIT 1',
                    [item.name]
                );

                if (found.rowCount > 0) {
                    continue;
                }

                await client.query(
                    `INSERT INTO food_options(name, emoji, latitude, longitude, address, tags)
                     VALUES ($1, $2, $3, $4, $5, $6)`,
                    [item.name, item.emoji, item.latitude ?? null, item.longitude ?? null, item.address ?? null, item.tags ?? []]
                );
                created += 1;
            }

            await client.query('COMMIT');
        } catch (error) {
            if (inTransaction) {
                await client.query('ROLLBACK');
            }
            throw error;
        } finally {
            client.release();
        }

        const result = await pool.query(`${OPTIONS_SELECT} ORDER BY o.id ASC`);
        return res.json({
            mode,
            imported: items.length,
            created,
            total: result.rows.length,
            options: result.rows
        });
    } catch (error) {
        return next(error);
    }
});

// 未匹配的接口统一返回 JSON 404，不再回落到静态托管
app.use('/api', (req, res) => {
    res.status(404).json({ error: '接口不存在' });
});

app.use((err, req, res, next) => {
    if (res.headersSent) {
        return next(err);
    }

    // 请求体不是合法 JSON 时 body-parser 抛 SyntaxError，应当是 400 而不是 500
    if (err instanceof SyntaxError || err.type === 'entity.parse.failed') {
        return res.status(400).json({ error: '请求体不是合法的 JSON' });
    }

    if (err.type === 'entity.too.large') {
        return res.status(413).json({ error: '请求体过大' });
    }

    console.error(err);
    res.status(500).json({ error: '服务器内部错误，请稍后重试' });
});

let server;

async function startServer() {
    await initDb();

    server = app.listen(PORT, HOST, () => {
        const shown = IS_PUBLIC_BIND ? `* (所有网卡)` : HOST;
        console.log(`服务器运行在 http://${HOST === '0.0.0.0' || HOST === '*' ? 'localhost' : HOST}:${PORT}  监听 ${shown}`);
        console.log('数据存储: PostgreSQL');
        console.log(`运行环境: ${IS_PRODUCTION ? 'production' : 'development'}`);
        console.log(`写接口鉴权: ${ADMIN_TOKEN ? '已启用（x-admin-token / Authorization: Bearer）' : '未启用（开发模式）'}`);
        console.log(`跨域写白名单: ${CORS_ALLOWED_ORIGINS.size ? [...CORS_ALLOWED_ORIGINS].join(', ') : '（仅同域）'}`);

        if (IS_PUBLIC_BIND) {
            console.warn('⚠️  已绑定所有网卡：同一网络内的任何设备都能访问本服务。');
            console.warn('    这通常是 Docker / 服务器部署的预期行为；若只是本机调试，请改用 HOST=127.0.0.1。');
        }
    });
}

async function shutdown(signal) {
    console.log(`收到 ${signal}，正在关闭服务...`);

    if (server) {
        await new Promise((resolve) => server.close(resolve));
    }

    await pool.end();
    process.exit(0);
}

process.on('SIGINT', () => {
    shutdown('SIGINT').catch((error) => {
        console.error('关闭失败:', error);
        process.exit(1);
    });
});

process.on('SIGTERM', () => {
    shutdown('SIGTERM').catch((error) => {
        console.error('关闭失败:', error);
        process.exit(1);
    });
});

startServer().catch((error) => {
    console.error('服务启动失败:', error);
    process.exit(1);
});
