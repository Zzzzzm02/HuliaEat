const express = require('express');
const path = require('path');
const fs = require('fs/promises');
const crypto = require('crypto');
const { Pool } = require('pg');

const app = express();
const PORT = Number(process.env.PORT) || 3000;
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
    ['/script.js', { file: 'script.js', type: 'application/javascript; charset=utf-8' }]
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

function normalizeImportItem(item) {
    if (!item || typeof item !== 'object') return null;

    const name = normalizeText(item.name);
    if (!name || name.length > MAX_NAME_LENGTH) return null;

    let emoji = normalizeText(item.emoji);
    if (!emoji || emoji.length > MAX_EMOJI_LENGTH) emoji = '🍽️';

    return { name, emoji };
}

async function loadSeedOptions() {
    try {
        const content = await fs.readFile(SEED_FILE, 'utf8');
        const parsed = JSON.parse(content);

        if (!Array.isArray(parsed)) {
            throw new Error('种子文件格式错误，必须为数组');
        }

        const normalized = parsed
            .map(normalizeSeedOption)
            .filter(Boolean);

        if (normalized.length === 0) {
            throw new Error('种子文件没有有效数据');
        }

        return dedupeByName(normalized);
    } catch (error) {
        console.warn(`读取种子文件失败，将回退默认菜单。原因: ${error.message}`);
        return [...DEFAULT_OPTIONS];
    }
}

async function initDb() {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS food_options (
            id BIGSERIAL PRIMARY KEY,
            name VARCHAR(${MAX_NAME_LENGTH}) NOT NULL,
            emoji VARCHAR(${MAX_EMOJI_LENGTH}) NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
    `);

    const countResult = await pool.query('SELECT COUNT(*)::int AS count FROM food_options');
    const existingCount = countResult.rows[0].count;

    if (existingCount > 0) return;

    const seedOptions = await loadSeedOptions();

    const client = await pool.connect();
    let inTransaction = false;

    try {
        await client.query('BEGIN');
        inTransaction = true;

        for (const option of seedOptions) {
            await client.query(
                'INSERT INTO food_options(name, emoji) VALUES ($1, $2)',
                [option.name, option.emoji]
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

app.get('/api/options', async (req, res, next) => {
    try {
        const result = await pool.query('SELECT id, name, emoji FROM food_options ORDER BY id ASC');
        res.json(result.rows);
    } catch (error) {
        next(error);
    }
});

app.get('/api/options/:id', async (req, res, next) => {
    try {
        const id = parseId(req.params.id);
        if (!id) {
            return res.status(400).json({ error: '无效的选项 ID' });
        }

        const result = await pool.query(
            'SELECT id, name, emoji FROM food_options WHERE id = $1',
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

        const result = await pool.query(
            'INSERT INTO food_options(name, emoji) VALUES ($1, $2) RETURNING id, name, emoji',
            [validation.data.name, validation.data.emoji]
        );

        return res.status(201).json(result.rows[0]);
    } catch (error) {
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

        const items = dedupeByName(rawItems.map(normalizeImportItem).filter(Boolean));

        if (items.length === 0) {
            return res.status(400).json({ error: '没有可导入的有效选项' });
        }

        const client = await pool.connect();
        let inTransaction = false;

        try {
            await client.query('BEGIN');
            inTransaction = true;

            if (mode === 'replace') {
                await client.query('TRUNCATE food_options RESTART IDENTITY');
            }

            for (const item of items) {
                if (mode === 'append') {
                    await client.query(
                        `INSERT INTO food_options(name, emoji)
                         SELECT $1::text, $2::text
                         WHERE NOT EXISTS (
                             SELECT 1 FROM food_options WHERE LOWER(name) = LOWER($1::text)
                         )`,
                        [item.name, item.emoji]
                    );
                } else {
                    await client.query(
                        'INSERT INTO food_options(name, emoji) VALUES ($1, $2)',
                        [item.name, item.emoji]
                    );
                }
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

        const result = await pool.query('SELECT id, name, emoji FROM food_options ORDER BY id ASC');
        return res.json({
            mode,
            imported: items.length,
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

    server = app.listen(PORT, () => {
        console.log(`服务器运行在 http://localhost:${PORT}`);
        console.log('数据存储: PostgreSQL');
        console.log(`运行环境: ${IS_PRODUCTION ? 'production' : 'development'}`);
        console.log(`写接口鉴权: ${ADMIN_TOKEN ? '已启用（x-admin-token / Authorization: Bearer）' : '未启用（开发模式）'}`);
        console.log(`跨域写白名单: ${CORS_ALLOWED_ORIGINS.size ? [...CORS_ALLOWED_ORIGINS].join(', ') : '（仅同域）'}`);
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
