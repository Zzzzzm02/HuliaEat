# 狐狸今天吃什么

一个可上线的餐饮随机选择应用，支持完整 CRUD（增删改查）并使用 PostgreSQL 持久化，适合部署到任意服务器。

## 关键特性

- 随机抽取餐饮选项（前端动画）
- **多榜单**：一家店可同时属于多个榜单（杭州榜 / 日常食堂 / 请客榜…），首页顶部一键切换
- 抽到不想吃的店可「最近不想吃」当场排除，**只影响本机**，不波及他人；有密钥的人可直接下架
- 管理页支持新增、编辑、删除、批量导入、榜单增删改名与店铺归类
- 后端完整 REST API，**写接口受管理密钥保护**
- PostgreSQL 持久化（跨服务器、跨重启不丢），**启动时自动按序执行 `migrations/` 里的 SQL**
- `data/options.json` 既是空库种子，也是**当前数据的版本化快照**（`npm run export` 生成）
- Docker / Docker Compose 部署
- `scripts/smoke.sh` 一键安全与接口冒烟测试，GitHub Actions 每次推送自动跑

## 安全模型

| 能力 | 暴露面 |
|---|---|
| 读接口（`GET /api/health`、`GET /api/options`、`GET /api/options/:id`、`GET /api/lists`） | 公开，任何人可抽一次吃的；跨域读取也开放 |
| 写接口（`POST/PUT/PATCH/DELETE /api/options*`、`POST/PATCH/DELETE /api/lists*`、`POST /api/lists/:id/membership`） | 需要管理密钥；`import` 的 `replace` 模式会 `TRUNCATE` 整表，务必保管好密钥 |
| 静态资源 | 仅 `/`、`/styles.css`、`/script.js`、`/image1/*`，其余（源码、`data/`、`.git/`）返回 404 |

写接口密钥通过 `x-admin-token: <ADMIN_TOKEN>` 或 `Authorization: Bearer <ADMIN_TOKEN>` 头传递。管理页首次触发写操作时会弹窗索取密钥，输入后保存在浏览器 `localStorage`，可在「管理选项」页顶部重新设置或清除。

「最近不想吃」与「下架」是两件事，界面刻意分开：

| 动作 | 谁做 | 效果 | 存储位置 |
|---|---|---|---|
| 🙅 最近不想吃 | 任何访客 | 本机不再抽到这家，可随时「恢复全部」 | 浏览器 `localStorage` |
| 🗑️ 从菜单下架 | 只有已填密钥的设备才看得到这个按钮 | 全库删除这家店（所有榜单都没了） | PostgreSQL |

另外五条默认策略：

- **跨域写白名单**：非白名单来源的跨域写请求直接 403（即使密钥正确）。前后端同源部署时无需配置 `CORS_ALLOWED_ORIGINS`。
- **爆破限流**：同一 IP 在 5 分钟内错 20 次密钥后返回 429。注意这是 **IP 级锁定**：窗口期内即使携带正确密钥也会被挡，需等窗口过期（约 5 分钟）自动恢复。放在 Nginx 等反代后面时务必设 `TRUST_PROXY=true`，否则所有访客共用同一个计数桶，容易互相误伤。
- **fail-closed 启动**：`NODE_ENV=production` 且未设置 `ADMIN_TOKEN` 时服务拒绝启动；开发模式不设密钥也能跑，但会在启动日志打印警告。
- **基础安全响应头**：所有响应带 `X-Content-Type-Options: nosniff`、`Referrer-Policy`，以及 `X-Frame-Options: SAMEORIGIN` —— 后者意味着**本页面不能被其他站点用 iframe 嵌入**（同源内嵌不受影响）。
- **默认只绑回环**：`HOST` 未设置时监听 `127.0.0.1`，误启动不会把服务泄露给整个局域网。要对外提供服务必须显式写 `HOST=0.0.0.0`，此时启动日志会打印一行醒目告警（Dockerfile / compose 已代为显式设置，那是容器内的预期行为）。

生成一个足够随机的密钥：

```bash
node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"
```

### 密钥忘了怎么办

密钥只保存在服务端环境变量里，因此不存在"永久锁死"：

1. 服务器上重新生成一个 `ADMIN_TOKEN` 并重启服务；
2. 浏览器里旧的密钥会失效，下次触发写操作时收到 401，页面会自动弹窗索取新密钥；
3. 也可以主动在「管理选项」页点「清除」再重新设置。

数据（PostgreSQL）不受影响，读接口全程可用。

## 环境变量

| 变量 | 说明 | 默认 |
|---|---|---|
| `HOST` | 监听地址；`0.0.0.0` = 对所有网卡开放（会打告警） | `127.0.0.1` |
| `PORT` | 服务端口 | `3000` |
| `DATABASE_URL` | PostgreSQL 连接串（**必填**） | — |
| `DATABASE_SSL` | 是否启用数据库 SSL，`true` / `false` | `false` |
| `SEED_FILE` | 空库首次初始化的种子（同时也是快照落点） | `./data/options.json` |
| `NODE_ENV` | `production` 时强制要求 `ADMIN_TOKEN` | — |
| `ADMIN_TOKEN` | 写接口管理密钥；留空 = 开发模式（不鉴权） | 空 |
| `CORS_ALLOWED_ORIGINS` | 允许跨域写操作的来源，逗号分隔 | 空（仅同域） |
| `TRUST_PROXY` | 反向代理后取真实客户端 IP，`true` / `false` | `false` |

参考：`.env.example`

> `server.js`、`scripts/smoke.sh`、`scripts/export-snapshot.js` 都会自动读取仓库根目录的 `.env`（各自约 15 行手写解析，未引入 `dotenv`）。规则是**只补缺失项**：已存在的环境变量优先，所以容器与 CI 里显式传参不会被本地文件干扰。`.env` 已在 `.gitignore` 里。

## 本地开发

```bash
npm install
cp .env.example .env      # 填入本机数据库口令与 ADMIN_TOKEN
npm start
```

访问 `http://localhost:3000`（端口取决于 `.env` 里的 `PORT`；被占用时改 `.env`，或前面加 `PORT=3210`）。

启动时若 `public` 里还没有表，会自动跑完 `migrations/` 再用种子灌数据。只想快速跑起来、不关心鉴权，把 `ADMIN_TOKEN` 留空即可 —— 写接口会开放，启动日志会警告，且这种配置绝对不要 `HOST=0.0.0.0` 暴露到公网。

## Docker Compose 部署（推荐）

```bash
cp .env.example .env
# 编辑 .env，至少填好 ADMIN_TOKEN 与 POSTGRES_PASSWORD
docker compose up -d --build
```

`ADMIN_TOKEN` / `POSTGRES_PASSWORD` 缺失时 compose 会直接报错退出，不会带着默认口令上线。数据库端口刻意不对宿主机发布，只有 app 容器能访问它。

如果服务放在 Nginx 之后，记得在 `.env` 里设 `TRUST_PROXY=true`；前后端不同源时把对外域名写进 `CORS_ALLOWED_ORIGINS`。

## API

写接口示例（`PUT` / `PATCH` / `DELETE` 同理）：

```bash
curl -X POST http://localhost:3000/api/options \
  -H 'Content-Type: application/json' \
  -H "x-admin-token: $ADMIN_TOKEN" \
  -d '{"name":"螺蛳粉","emoji":"🍜"}'
```

### 店铺

| 接口 | 鉴权 | 说明 |
|---|---|---|
| `GET /api/health` | 公开 | 健康检查，含当前店铺总数 |
| `GET /api/options` | 公开 | 全量店铺，每条含 `lists: [{id,name}]`；`?list=<榜单id>` 可按榜过滤 |
| `GET /api/options/:id` | 公开 | 单条 |
| `POST /api/options` | 密钥 | Body `{name, emoji, listIds?: [1,2]}`；不给 `listIds` 时归入默认榜单 |
| `PUT /api/options/:id` | 密钥 | 全量更新 name / emoji |
| `PATCH /api/options/:id` | 密钥 | 部分更新 |
| `DELETE /api/options/:id` | 密钥 | **删除店铺本身**，连带解除它在所有榜单里的关联 |
| `POST /api/options/import` | 密钥 | Body `{mode:"append"\|"replace", items:[{name,emoji}], listId?}`；重名不新建行而是复用并挂进目标榜；`replace` 会 `TRUNCATE` 店铺与全部关联，**不可撤销** |

### 榜单

| 接口 | 鉴权 | 说明 |
|---|---|---|
| `GET /api/lists` | 公开 | 榜单列表，含每个榜的店铺数 |
| `POST /api/lists` | 密钥 | Body `{name}`；同名返回 409 |
| `PATCH /api/lists/:id` | 密钥 | Body `{name?, sortOrder?}` —— 改名与排序 |
| `DELETE /api/lists/:id` | 密钥 | 只删榜单与关联，**店铺本身保留** |
| `POST /api/lists/:id/membership` | 密钥 | Body `{mode:"add"\|"remove"\|"replace", optionIds:[...]}` |

非法 id / 非法 mode 一律 400，不存在的资源 404；`GET /api/options?list=<已删除的榜>` 返回空数组而不是报错。

## 测试

```bash
npm run smoke
```

`scripts/smoke.sh` 会在一个**临时 PostgreSQL schema** 中跑完 75 项断言（鉴权、静态越界读取、跨域写、爆破限流、启动策略、CRUD、批量导入、多榜单语义），结束即 `drop schema`，不触碰 `public` 的正式数据。需要本机 PostgreSQL 可用且账号有建 schema 的权限。

连接信息一律来自环境，**脚本里不内置任何默认口令**：优先读仓库根目录的 `.env`，也可用 `SMOKE_PGHOST` / `SMOKE_PGPORT` / `SMOKE_PGDATABASE` / `SMOKE_PGUSER` / `SMOKE_PGPASSWORD` 覆盖；拿不到就退出码 2。测试用密钥每次随机生成，不落盘。

CI：`.github/workflows/smoke.yml` 用一次性 `postgres:16-alpine` 服务容器跑同一个脚本。

## 数据模型、迁移与快照

三张表，多对多：

```text
food_options(id, name, emoji, ...)      ← 一家店的唯一真相
lists(id, name, sort_order, ...)        ← 榜单
list_items(list_id, option_id, ...)     ← 关联（两家榜可同时含同一店）
schema_migrations(name, applied_at)     ← 已执行的迁移
```

- 店只存一份，所以改 emoji 不会因它出现在多个榜单而分裂。
- `list_items` 两个外键都是 `ON DELETE CASCADE`：删店自动清关联，删榜也自动清关联。
- **加字段就新增一个 `migrations/NNN_名字.sql`**，服务启动时按文件名顺序执行，每个迁移单独包一层事务（失败回滚且不记录，下次重试）。老库里 `food_options` 早就存在，所以 001 用 `IF NOT EXISTS` 做成无害的空操作基线。
- 迁移只在启动时跑，没有独立的 CLI 步骤 —— `docker restart` / `npm start` 即可完成升级。

### 快照：`npm run export`

把当前数据库导出成受 git 跟踪的 `data/options.json`。这份文件同时是：

1. 空库首次启动的种子（`SEED_FILE` 直接读它，v1 裸数组与 v2 多榜单两种格式都认）；
2. 菜单历史的版本化副本 —— 提交后 `git log -p data/options.json` 就能看菜单演变；
3. 唯一的离线副本 —— 跑迁移或做批量替换前的安全垫。

改完榜单顺手 `npm run export` 一次并提交即可。另有一份 `pg_dump` 级的紧急备份放在 `data/backups/`（**已 gitignore**，不进仓库）。

## 已知待办

- `name` 尚无唯一约束，单条 `POST` 重名仍会成功（导入路径已按名去重复用）
- 暂无单元测试框架，只有 `scripts/smoke.sh`（CI 已接入，跑的是接口级冒烟）
- 权限模型是**单一共享密钥**（存在浏览器 `localStorage`），足以防止路人误改/清空菜单，但没有多用户账号与操作审计；若将来要开放多人分别管理，需要改造成 session / 用户表方案
- HTTPS 不在应用层强制，需由反向代理（Nginx / Caddy）或托管平台提供。**在没有 HTTPS 的地址上使用管理密钥 = 密钥明文过网**，公网部署务必先套 TLS
- Emoji 关键词规则目前只写在前端的 `EMOJI_RULES` 里，后端 `import` 的兜底是通用 `🍽️`；若将来出现不带前端的导入调用方，需要把规则挪到共享位置
- 本机 Homebrew PostgreSQL 用 `trust` 认证且只监听回环，因此 `ALTER USER ... PASSWORD` 在本地不起实际门禁作用（口令轮换的意义在于别把跟仓库示例相同的值带上线）

## 项目结构

```text
.
├── index.html              # 单页前端（首页 / 结果 / 管理三屏）
├── styles.css              # 暖色「狐狸食堂」主题
├── script.js               # 前端逻辑 + 榜单切换 + 本机排除 + 管理密钥处理
├── server.js               # Express API + 鉴权 / CORS / 静态白名单 + 迁移执行
├── migrations/
│   ├── 001_init.sql        # 基线结构（幂等）
│   └── 002_lists.sql       # 多榜单 + 存量数据回填
├── scripts/
│   ├── smoke.sh            # 安全与接口冒烟测试（75 项断言）
│   └── export-snapshot.js  # 数据库 → data/options.json 快照
├── .github/workflows/
│   └── smoke.yml           # CI：一次性 postgres:16 服务容器跑冒烟
├── Dockerfile              # 非 root 运行 + 健康检查（容器内 HOST=0.0.0.0）
├── docker-compose.yml      # app + postgres（数据库端口不对宿主机发布）
├── .dockerignore
├── .env.example
├── data/
│   ├── options.json        # 种子 = 快照（受 git 跟踪）
│   └── backups/            # pg_dump 紧急备份（已 gitignore）
└── README.md
```
