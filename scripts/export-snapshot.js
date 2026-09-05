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

const OUT_FILE = process.env.SEED_FILE
    ? path.resolve(ROOT, process.env.SEED_FILE)
    : path.join(ROOT, 'data', 'options.json');

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
    const options = await pool.query(`
        SELECT o.name, o.emoji, o.latitude, o.longitude, o.address, o.tags
        FROM food_options o
        ORDER BY o.id ASC
    `);

    const document = {
        version: 3,
        exportedAt: new Date().toISOString(),
        options: options.rows.map((row) => {
            const option = {
                name: row.name,
                emoji: row.emoji
            };

            // 类型标签：有才写，保持快照干净
            if (row.tags && row.tags.length) {
                option.tags = row.tags;
            }
            // 已定位的店把地理信息一起带走；没定位的省略这几个键
            if (row.latitude !== null && row.longitude !== null) {
                option.latitude = row.latitude;
                option.longitude = row.longitude;
            }
            if (row.address) {
                option.address = row.address;
            }

            return option;
        })
    };

    fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
    fs.writeFileSync(OUT_FILE, `${JSON.stringify(document, null, 2)}\n`, 'utf8');

    console.log(`已导出快照 → ${path.relative(ROOT, OUT_FILE)}`);
    console.log(`  餐厅 ${document.options.length} 家`);

    const missingEmoji = document.options.filter((row) => row.emoji === '🍽️').length;
    if (missingEmoji > 0) {
        console.warn(`  ⚠️  仍有 ${missingEmoji} 家使用通用占位 🍽️。`);
    }
    const noTags = document.options.filter((row) => !(row.tags && row.tags.length)).length;
    if (noTags > 0) {
        console.warn(`  ⚠️  有 ${noTags} 家还没有任何类型标签，不会出现在「今天想吃X」筛选里。`);
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
