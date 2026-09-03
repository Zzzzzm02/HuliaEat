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

/* ---------------- 安全相关配置 ---------------- */

const IS_PRODUCTION = process.env.NODE_ENV === 'production';
const ADMIN_TOKEN = (process.env.ADMIN_TOKEN || '').trim();

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
    const id = Number.parseInt(rawId, 10);
    return Number.isInteger(id) && id > 0 ? id : null;
}

function normalizeSeedOption(option) {
    if (!option || typeof option !== 'object') return null;

    const name = normalizeText(option.name);
    const emoji = normalizeText(option.emoji);

    if (!name || !emoji) return null;
    if (name.length > MAX_NAME_LENGTH) return null;
    if (emoji.length > MAX_EMOJI_LENGTH) return null;

    return { name, emoji };
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

    if (!partial && (!hasName || !hasEmoji)) {
        return { ok: false, error: 'name 和 emoji 都是必填项' };
    }

    if (partial && !hasName && !hasEmoji) {
        return { ok: false, error: '至少提供一个可修改字段（name 或 emoji）' };
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

    return { ok: true, data: result };
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

    return { name, emoji };
}

const MIGRATIONS_DIR = path.join(__dirname, 'migrations');
const DEFAULT_LIST_NAME = '默认榜单';

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

/* ---------------- 种子：支持 v1 裸数组与 v2 多榜单两种格式 ---------------- */

function normalizeSeedDocument(parsed) {
    // v1：[{ name, emoji }, ...] —— 全部落到默认榜单
    if (Array.isArray(parsed)) {
        const options = dedupeByName(parsed.map(normalizeSeedOption).filter(Boolean))
            .map((option) => ({ ...option, lists: [] }));

        return { lists: [], options };
    }

    // v2：{ version: 2, lists: [{ name, sortOrder }], options: [{ name, emoji, lists: [榜单名] }] }
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.options)) {
        throw new Error('种子文件格式错误：应为数组，或 { version, lists, options } 对象');
    }

    const seenLists = new Set();
    const lists = [];

    for (const [index, item] of (Array.isArray(parsed.lists) ? parsed.lists : []).entries()) {
        const name = normalizeText(item && item.name);
        if (!name || name.length > MAX_NAME_LENGTH) continue;

        const key = name.toLowerCase();
        if (seenLists.has(key)) continue;

        seenLists.add(key);
        lists.push({ name, sortOrder: Number(item.sortOrder) || index + 1 });
    }

    const merged = new Map();

    for (const raw of parsed.options) {
        const option = normalizeSeedOption(raw);
        if (!option) continue;

        const key = option.name.toLowerCase();
        const wanted = Array.isArray(raw.lists)
            ? raw.lists.map(normalizeText).filter((name) => seenLists.has(name.toLowerCase()))
            : [];

        if (!merged.has(key)) {
            merged.set(key, { ...option, lists: wanted });
            continue;
        }

        const existing = merged.get(key);
        existing.lists = [...new Set([...existing.lists, ...wanted])];
    }

    const options = [...merged.values()];

    if (options.length === 0) {
        throw new Error('种子文件没有有效数据');
    }

    return { lists, options };
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

async function ensureDefaultList(client) {
    const existing = await client.query('SELECT id FROM lists WHERE LOWER(name) = $1', [DEFAULT_LIST_NAME.toLowerCase()]);
    if (existing.rowCount > 0) return existing.rows[0].id;

    const created = await client.query(
        'INSERT INTO lists(name, sort_order) VALUES ($1, $2) RETURNING id',
        [DEFAULT_LIST_NAME, 999]
    );
    return created.rows[0].id;
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

        const defaultListId = await ensureDefaultList(client);

        // 先建榜单，记下 名称 → id
        const listIds = new Map();
        for (const list of seed.lists) {
            const result = await client.query(
                `INSERT INTO lists(name, sort_order) VALUES ($1, $2)
                 ON CONFLICT (LOWER(name)) DO UPDATE SET sort_order = EXCLUDED.sort_order
                 RETURNING id`,
                [list.name, list.sortOrder]
            );
            listIds.set(list.name.toLowerCase(), result.rows[0].id);
        }

        // 再插店，并按声明挂进榜单（未声明的进默认榜单）
        for (const option of seed.options) {
            const inserted = await client.query(
                'INSERT INTO food_options(name, emoji) VALUES ($1, $2) RETURNING id',
                [option.name, option.emoji]
            );
            const optionId = inserted.rows[0].id;

            const targets = option.lists.length
                ? option.lists.map((name) => listIds.get(name.toLowerCase())).filter(Boolean)
                : [defaultListId];

            for (const listId of new Set(targets)) {
                await client.query(
                    'INSERT INTO list_items(list_id, option_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
                    [listId, optionId]
                );
            }
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

const OPTIONS_SELECT = `
    SELECT o.id, o.name, o.emoji,
           COALESCE(
               json_agg(json_build_object('id', l.id, 'name', l.name)
                        ORDER BY l.sort_order, l.id)
               FILTER (WHERE l.id IS NOT NULL),
               '[]'
           ) AS lists
    FROM food_options o
    LEFT JOIN list_items li ON li.option_id = o.id
    LEFT JOIN lists l ON l.id = li.list_id
`;

app.get('/api/options', async (req, res, next) => {
    try {
        const listId = parseId(req.query.list);

        // ?list=<非法值> 应当是 400，而不是静默返回全量
        if (req.query.list !== undefined && !listId) {
            return res.status(400).json({ error: '无效的榜单 ID' });
        }

        const params = [];
        let where = '';

        if (listId) {
            where = 'WHERE EXISTS (SELECT 1 FROM list_items f WHERE f.option_id = o.id AND f.list_id = $1)';
            params.push(listId);
        }

        const result = await pool.query(
            `${OPTIONS_SELECT}
             ${where}
             GROUP BY o.id
             ORDER BY o.id ASC`,
            params
        );

        return res.json(result.rows);
    } catch (error) {
        return next(error);
    }
});

app.get('/api/lists', async (req, res, next) => {
    try {
        const result = await pool.query(`
            SELECT l.id, l.name, l.sort_order AS "sortOrder",
                   COUNT(li.option_id)::int AS count
            FROM lists l
            LEFT JOIN list_items li ON li.list_id = l.id
            GROUP BY l.id
            ORDER BY l.sort_order ASC, l.id ASC
        `);

        res.json(result.rows);
    } catch (error) {
        next(error);
    }
});

function validateListPayload(payload, { partial = false } = {}) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        return { ok: false, error: '请求体必须是 JSON 对象' };
    }

    const hasName = Object.prototype.hasOwnProperty.call(payload, 'name');
    const hasOrder = Object.prototype.hasOwnProperty.call(payload, 'sortOrder');

    if (!hasName && !hasOrder) {
        return { ok: false, error: partial ? '至少提供 name 或 sortOrder' : 'name 是必填项' };
    }

    const data = {};

    if (hasName) {
        const name = normalizeText(payload.name);
        if (!name) return { ok: false, error: '榜单名称不能为空' };
        if (name.length > MAX_NAME_LENGTH) {
            return { ok: false, error: `榜单名称最长不能超过 ${MAX_NAME_LENGTH} 个字符` };
        }
        data.name = name;
    }

    if (hasOrder) {
        const sortOrder = Number(payload.sortOrder);
        if (!Number.isInteger(sortOrder)) return { ok: false, error: 'sortOrder 必须是整数' };
        data.sortOrder = sortOrder;
    }

    return { ok: true, data };
}

app.post('/api/lists', requireAdmin, async (req, res, next) => {
    try {
        const validation = validateListPayload(req.body);
        if (!validation.ok) {
            return res.status(400).json({ error: validation.error });
        }

        const maxOrder = await pool.query('SELECT COALESCE(MAX(sort_order), 0)::int AS max FROM lists');
        const result = await pool.query(
            'INSERT INTO lists(name, sort_order) VALUES ($1, $2) RETURNING id, name, sort_order AS "sortOrder"',
            [validation.data.name, maxOrder.rows[0].max + 1]
        );

        return res.status(201).json({ ...result.rows[0], count: 0 });
    } catch (error) {
        if (error.code === '23505') {
            return res.status(409).json({ error: '已存在同名榜单' });
        }
        return next(error);
    }
});

app.patch('/api/lists/:id', requireAdmin, async (req, res, next) => {
    try {
        const id = parseId(req.params.id);
        if (!id) {
            return res.status(400).json({ error: '无效的榜单 ID' });
        }

        const validation = validateListPayload(req.body, { partial: true });
        if (!validation.ok) {
            return res.status(400).json({ error: validation.error });
        }

        const current = await pool.query('SELECT id, name, sort_order FROM lists WHERE id = $1', [id]);
        if (current.rowCount === 0) {
            return res.status(404).json({ error: '榜单不存在' });
        }

        const nextName = validation.data.name ?? current.rows[0].name;
        const nextOrder = validation.data.sortOrder ?? current.rows[0].sort_order;

        const result = await pool.query(
            `UPDATE lists SET name = $1, sort_order = $2, updated_at = NOW()
             WHERE id = $3 RETURNING id, name, sort_order AS "sortOrder"`,
            [nextName, nextOrder, id]
        );

        const count = await pool.query('SELECT COUNT(*)::int AS count FROM list_items WHERE list_id = $1', [id]);
        return res.json({ ...result.rows[0], count: count.rows[0].count });
    } catch (error) {
        if (error.code === '23505') {
            return res.status(409).json({ error: '已存在同名榜单' });
        }
        return next(error);
    }
});

// 删除榜单只解除关联，店本身保留（下架一家店请走 DELETE /api/options/:id）
app.delete('/api/lists/:id', requireAdmin, async (req, res, next) => {
    try {
        const id = parseId(req.params.id);
        if (!id) {
            return res.status(400).json({ error: '无效的榜单 ID' });
        }

        const result = await pool.query('DELETE FROM lists WHERE id = $1', [id]);
        if (result.rowCount === 0) {
            return res.status(404).json({ error: '榜单不存在' });
        }

        return res.status(204).send();
    } catch (error) {
        return next(error);
    }
});

//  membership 变更：{ optionIds: [1,2,3], mode: 'add' | 'remove' | 'replace' }
app.post('/api/lists/:id/membership', requireAdmin, async (req, res, next) => {
    try {
        const listId = parseId(req.params.id);
        if (!listId) {
            return res.status(400).json({ error: '无效的榜单 ID' });
        }

        const listExists = await pool.query('SELECT id FROM lists WHERE id = $1', [listId]);
        if (listExists.rowCount === 0) {
            return res.status(404).json({ error: '榜单不存在' });
        }

        const body = req.body || {};
        const mode = ['add', 'remove', 'replace'].includes(body.mode) ? body.mode : '';
        if (!mode) {
            return res.status(400).json({ error: "mode 必须是 'add' / 'remove' / 'replace'" });
        }

        if (!Array.isArray(body.optionIds)) {
            return res.status(400).json({ error: 'optionIds 必须是数组' });
        }

        const optionIds = [...new Set(body.optionIds.map((item) => parseId(item)).filter(Boolean))];

        if (optionIds.length !== body.optionIds.length) {
            return res.status(400).json({ error: 'optionIds 含非法 ID' });
        }

        const client = await pool.connect();
        try {
            await client.query('BEGIN');

            if (mode === 'replace') {
                await client.query('DELETE FROM list_items WHERE list_id = $1', [listId]);
            }

            const sql = mode === 'remove'
                ? 'DELETE FROM list_items WHERE list_id = $1 AND option_id = ANY($2::bigint[])'
                : 'INSERT INTO list_items(list_id, option_id) SELECT $1, id FROM unnest($2::bigint[]) AS t(id) ON CONFLICT DO NOTHING';

            await client.query(sql, [listId, optionIds]);
            await client.query('COMMIT');
        } catch (error) {
            await client.query('ROLLBACK');
            throw error;
        } finally {
            client.release();
        }

        const result = await pool.query('SELECT COUNT(*)::int AS count FROM list_items WHERE list_id = $1', [listId]);
        return res.json({ listId, mode, count: result.rows[0].count });
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
            `${OPTIONS_SELECT} WHERE o.id = $1 GROUP BY o.id`,
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

app.post('/api/options', requireAdmin, async (req, res, next) => {
    try {
        const validation = validatePayload(req.body, { partial: false });
        if (!validation.ok) {
            return res.status(400).json({ error: validation.error });
        }

        // 可选 listIds：把新店同时挂进多个榜单；不给则进默认榜单
        const rawListIds = req.body && Array.isArray(req.body.listIds) ? req.body.listIds : null;
        const listIds = rawListIds ? [...new Set(rawListIds.map((item) => parseId(item)).filter(Boolean))] : null;

        if (rawListIds && listIds.length !== rawListIds.length) {
            return res.status(400).json({ error: 'listIds 含非法榜单 ID' });
        }

        const client = await pool.connect();
        try {
            await client.query('BEGIN');

            const inserted = await client.query(
                'INSERT INTO food_options(name, emoji) VALUES ($1, $2) RETURNING id, name, emoji',
                [validation.data.name, validation.data.emoji]
            );
            const option = inserted.rows[0];

            let targets = listIds;

            if (!targets || targets.length === 0) {
                const fallback = await client.query(
                    'SELECT id FROM lists ORDER BY (name = $1) DESC, sort_order ASC, id ASC LIMIT 1',
                    [DEFAULT_LIST_NAME]
                );
                targets = fallback.rowCount ? [fallback.rows[0].id] : [];
            }

            for (const listId of targets) {
                await client.query(
                    `INSERT INTO list_items(list_id, option_id)
                     SELECT $1, $2 FROM lists WHERE id = $1
                     ON CONFLICT DO NOTHING`,
                    [listId, option.id]
                );
            }

            await client.query('COMMIT');

            const lists = await client.query(
                `SELECT l.id, l.name FROM lists l
                 JOIN list_items li ON li.list_id = l.id
                 WHERE li.option_id = $1 ORDER BY l.sort_order, l.id`,
                [option.id]
            );

            return res.status(201).json({ ...option, lists: lists.rows });
        } catch (error) {
            await client.query('ROLLBACK');
            throw error;
        } finally {
            client.release();
        }
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

        const result = await pool.query(
            `
                UPDATE food_options
                SET name = $1, emoji = $2, updated_at = NOW()
                WHERE id = $3
                RETURNING id, name, emoji
            `,
            [validation.data.name, validation.data.emoji, id]
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
            'SELECT id, name, emoji FROM food_options WHERE id = $1',
            [id]
        );

        if (currentResult.rowCount === 0) {
            return res.status(404).json({ error: '选项不存在' });
        }

        const current = currentResult.rows[0];
        const nextName = validation.data.name ?? current.name;
        const nextEmoji = validation.data.emoji ?? current.emoji;

        const updatedResult = await pool.query(
            `
                UPDATE food_options
                SET name = $1, emoji = $2, updated_at = NOW()
                WHERE id = $3
                RETURNING id, name, emoji
            `,
            [nextName, nextEmoji, id]
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
        const mode = body.mode === 'append' ? 'append' : 'replace';
        const rawItems = Array.isArray(body.items) ? body.items : [];
        const rawListId = body.listId === undefined ? null : body.listId;
        const listId = rawListId === null ? null : parseId(rawListId);

        if (rawListId !== null && !listId) {
            return res.status(400).json({ error: '无效的榜单 ID' });
        }

        const items = dedupeByName(rawItems.map(normalizeImportItem).filter(Boolean));

        if (items.length === 0) {
            return res.status(400).json({ error: '没有可导入的有效选项' });
        }

        const client = await pool.connect();
        let inTransaction = false;
        let created = 0;

        try {
            await client.query('BEGIN');
            inTransaction = true;

            let targetListId = listId;

            if (mode === 'replace') {
                // list_items 通过外键引用 food_options，必须一起截断，
                // 否则 Postgres 会以 22665 拒绝截断被引用的表
                await client.query('TRUNCATE food_options, list_items RESTART IDENTITY CASCADE');
            }

            if (!targetListId) {
                const fallback = await client.query(
                    'SELECT id FROM lists ORDER BY (name = $1) DESC, sort_order ASC, id ASC LIMIT 1',
                    [DEFAULT_LIST_NAME]
                );
                if (fallback.rowCount === 0) {
                    const created_list = await client.query(
                        'INSERT INTO lists(name, sort_order) VALUES ($1, $2) RETURNING id',
                        [DEFAULT_LIST_NAME, 1]
                    );
                    targetListId = created_list.rows[0].id;
                } else {
                    targetListId = fallback.rows[0].id;
                }
            } else {
                const exists = await client.query('SELECT id FROM lists WHERE id = $1', [listId]);
                if (exists.rowCount === 0) {
                    return res.status(404).json({ error: '榜单不存在' });
                }
            }

            for (const item of items) {
                // 重名不新建行，而是复用已有那一家 —— 否则榜单里会出现同一家店的两份真相
                const found = await client.query(
                    'SELECT id FROM food_options WHERE LOWER(name) = LOWER($1) ORDER BY id LIMIT 1',
                    [item.name]
                );

                let optionId;

                if (found.rowCount > 0) {
                    optionId = found.rows[0].id;
                } else {
                    const inserted = await client.query(
                        'INSERT INTO food_options(name, emoji) VALUES ($1, $2) RETURNING id',
                        [item.name, item.emoji]
                    );
                    optionId = inserted.rows[0].id;
                    created += 1;
                }

                await client.query(
                    'INSERT INTO list_items(list_id, option_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
                    [targetListId, optionId]
                );
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

        const result = await pool.query(`${OPTIONS_SELECT} GROUP BY o.id ORDER BY o.id ASC`);
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
