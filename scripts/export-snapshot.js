#!/usr/bin/env node
/*
 * 把当前数据库导出成受 git 跟踪的 JSON 快照：data/options.json
 *
 *   npm run export
 *
 * 这份文件同时承担三个角色（见 README「数据快照」）：
 *   1. 空库首次启动的种子（server.js 的 SEED_FILE 直接读它）
 *   2. 菜单历史的版本化副本 —— 提交进 git 后可 diff、可回溯
 *   3. 唯一的离线副本 —— 迁移或误操作时的安全垫
 *
 * 连接信息来自环境变量 DATABASE_URL（会自动读取仓库根目录的 .env）。
 */

const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const ROOT = path.join(__dirname, '..');
const OUT_FILE = process.env.SEED_FILE
    ? path.resolve(ROOT, process.env.SEED_FILE)
    : path.join(ROOT, 'data', 'options.json');

function loadEnvFile() {
    const envPath = path.join(ROOT, '.env');
    if (!fs.existsSync(envPath)) return;

    for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
        const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
        if (!match) continue;

        const key = match[1];
        let value = match[2].trim();

        if (/^".*"$/.test(value) || /^'.*'$/.test(value)) {
            value = value.slice(1, -1);
        }

        if (value && process.env[key] === undefined) {
            process.env[key] = value;
        }
    }
}

loadEnvFile();

const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
    console.error('导出失败：缺少 DATABASE_URL（可放在 .env 里）。');
    process.exit(1);
}

const pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : undefined
});

async function main() {
    const lists = await pool.query(`
        SELECT id, name, sort_order AS "sortOrder"
        FROM lists ORDER BY sort_order ASC, id ASC
    `);

    const options = await pool.query(`
        SELECT o.id, o.name, o.emoji,
               COALESCE(
                   array_agg(l.name ORDER BY l.sort_order, l.id)
                   FILTER (WHERE l.id IS NOT NULL), '{}'
               ) AS lists
        FROM food_options o
        LEFT JOIN list_items li ON li.option_id = o.id
        LEFT JOIN lists l ON l.id = li.list_id
        GROUP BY o.id
        ORDER BY o.id ASC
    `);

    const orphanCount = options.rows.filter((row) => row.lists.length === 0).length;

    const document = {
        version: 2,
        exportedAt: new Date().toISOString(),
        lists: lists.rows.map((row) => ({ name: row.name, sortOrder: Number(row.sortOrder) })),
        options: options.rows.map((row) => ({
            name: row.name,
            emoji: row.emoji,
            lists: row.lists.length ? row.lists : ['默认榜单']
        }))
    };

    // 保证快照里声明过的榜单都被 seed 认可：孤儿行会被挂到默认榜单，
    // 因此默认榜单必须存在于 lists 声明中
    if (!document.lists.some((list) => list.name === '默认榜单')) {
        document.lists.push({ name: '默认榜单', sortOrder: 999 });
    }

    fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
    fs.writeFileSync(OUT_FILE, `${JSON.stringify(document, null, 2)}\n`, 'utf8');

    console.log(`已导出快照 → ${path.relative(ROOT, OUT_FILE)}`);
    console.log(`  榜单 ${document.lists.length} 个，餐厅 ${document.options.length} 家`);

    if (orphanCount > 0) {
        console.warn(`  ⚠️  有 ${orphanCount} 家店不属于任何榜单，已在快照中挂到「默认榜单」。`);
    }

    const missingEmoji = document.options.filter((row) => row.emoji === '🍽️').length;
    if (missingEmoji > 0) {
        console.warn(`  ⚠️  仍有 ${missingEmoji} 家使用通用占位 🍽️。`);
    }
}

main()
    .catch((error) => {
        console.error('导出失败:', error.message);
        process.exitCode = 1;
    })
    .finally(() => {
        pool.end();
    });
