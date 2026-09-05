# 狐狸今天吃什么

[![冒烟测试](https://github.com/Zzzzzm02/HuliaEat/actions/workflows/smoke.yml/badge.svg)](https://github.com/Zzzzzm02/HuliaEat/actions/workflows/smoke.yml)

一个可上线的餐饮随机选择应用，支持完整 CRUD（增删改查）并使用 PostgreSQL 持久化，适合部署到任意服务器。

## 关键特性

- 随机抽取餐饮选项（前端动画）
- **地图页**：已定位的店标在高德地图上（emoji 圆形标记 + 详情气泡），按榜单筛选；地理信息可选，但填了就必须合法
- **多榜单**：一家店可同时属于多个榜单（杭州榜 / 日常食堂 / 请客榜…），首页顶部一键切换
- 抽到不想吃的店可「最近不想吃」当场排除，**只影响本机**，不波及他人；有密钥的人可直接下架
- 管理页支持新增、编辑、删除、批量导入、榜单增删改名与店铺归类
- **店名全库唯一**：单条新增与批量导入都按名去重，不会出现两行同一家店
- 后端完整 REST API，**写接口受管理密钥保护**
- **PWA**：手机浏览器「添加到主屏幕」后以独立窗口打开，图标齐全；断网时至少能打开上次的界面
- PostgreSQL 持久化（跨服务器、跨重启不丢），**启动时自动按序执行 `migrations/` 里的 SQL**
- `data/options.json` 既是空库种子，也是**当前数据的版本化快照**（`npm run export` 生成）
- Docker / Docker Compose 部署
- `scripts/smoke.sh` 一键安全与接口冒烟测试，GitHub Actions 每次推送自动跑

## 安全模型

| 能力 | 暴露面 |
|---|---|
| 读接口（`GET /api/health`、`GET /api/options`、`GET /api/options/:id`、`GET /api/lists`、`GET /api/config`） | 公开，任何人可抽一次吃的；跨域读取也开放。`/api/config` 只含高德 JSAPI key 与安全密钥（本来就是给浏览器用的公开值，建议在高德控制台配域名白名单） |
| 写接口（`POST/PUT/PATCH/DELETE /api/options*`、`POST/PATCH/DELETE /api/lists*`、`POST /api/lists/:id/membership`） | 需要管理密钥；`import` 的 `replace` 模式会 `TRUNCATE` 整表，务必保管好密钥 |
| 静态资源 | 仅 `/`、`/styles.css`、`/script.js`、`/map.js`、`/emoji-rules.js`、`/sw.js`、`/manifest.webmanifest`、`/icons/*`、`/image1/*`，其余（源码、`data/`、`.git/`）返回 404 |

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
| `AMAP_JSAPI_KEY` | 高德「Web端 (JS API)」key，前端地图用，随 `/api/config` 公开下发 | 空（地图页显示配置指引） |
| `AMAP_SECURITY_CODE` | 上面对应的安全密钥（jscode），一并下发给前端 | 空 |
| `AMAP_WEB_KEY` | 高德「Web 服务」key，只给 `npm run geocode` 批量查坐标用，不下发前端 | 空 |

参考：`.env.example`

> `server.js`、`scripts/smoke.sh`、`scripts/export-snapshot.js` 都会自动读取仓库根目录的 `.env`（各自约 15 行手写解析，未引入 `dotenv`）。规则是**只补缺失项**：已存在的环境变量优先，所以容器与 CI 里显式传参不会被本地文件干扰。`.env` 已在 `.gitignore` 里。

## 本地开发

```bash
npm install
cp .env.example .env      # 填入本机数据库口令与 ADMIN_TOKEN
npm start
```

访问 `http://localhost:3000`（端口取决于 `.env` 里的 `PORT`；被占用时改 `.env`，或前面加 `PORT=3210`）。

启动时若数据库 `public` schema 里还没有表，会自动跑完 `migrations/` 再用种子灌数据。只想快速跑起来、不关心鉴权，把 `ADMIN_TOKEN` 留空即可 —— 写接口会开放，启动日志会警告，且这种配置绝对不要 `HOST=0.0.0.0` 暴露到公网。

## Docker Compose 部署（推荐）

```bash
cp .env.example .env
# 编辑 .env，至少填好 ADMIN_TOKEN 与 POSTGRES_PASSWORD
docker compose up -d --build
```

`ADMIN_TOKEN` / `POSTGRES_PASSWORD` 缺失时 compose 会直接报错退出，不会带着默认口令上线。数据库端口刻意不对宿主机发布，只有 app 容器能访问它。

如果服务放在 Nginx 之后，记得在 `.env` 里设 `TRUST_PROXY=true`；前后端不同源时把对外域名写进 `CORS_ALLOWED_ORIGINS`。

### 上线前检查清单

- [ ] `.env` 里的 `ADMIN_TOKEN` 和 `POSTGRES_PASSWORD` 都换成了随机长值（生成命令见上），与任何示例/文档里的字面值都不同
- [ ] `APP_PORT` 按需调整（默认 3000）
- [ ] **HTTPS 已就位**（Nginx / Caddy 证书或托管平台自带）—— 没有它，管理密钥就是明文过网，Service Worker 也不会生效
- [ ] 反代之后设 `TRUST_PROXY=true`，否则限流把所有访客算成同一个 IP
- [ ] 首次 `docker compose up -d --build` 后看一眼 app 容器日志：空库应出现 4 条「已应用迁移」+ 1 条种子初始化
- [ ] `curl https://你的域名/api/health` 返回 `"status":"ok"`，且手机能打开页面

## 升级与数据安全

升级一个已部署的实例：

```bash
git pull
docker compose up -d --build    # 容器启动时自动把新迁移跑完，无需手动步骤
```

- 迁移**只进不退**：`migrations/NNN_*.sql` 没有 down 版本。回滚代码前先确认旧代码与当前表结构兼容；大改前先 `npm run export` 留快照就是这个原因。
- 定期从宿主机备份数据库（compose 的 5432 刻意不对宿主机发布，所以走 `docker compose exec`）：

```bash
docker compose exec -T db pg_dump -U huliaeat huliaeat > backup-$(date +%F).sql
```

恢复（会覆盖现库，先想三秒）：

```bash
cat backup-2026-09-03.sql | docker compose exec -T db psql -U huliaeat -d huliaeat
```

- 只是手滑改坏了菜单、不想碰数据库？把 git 历史里任意一版 `data/options.json` 的内容，通过管理页「批量导入 → 替换全部」灌回去即可。

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
| `GET /api/options` | 公开 | 全量店铺，每条含 `lists: [{id,name}]` 与可选的 `latitude` / `longitude` / `address`；`?list=<榜单id>` 可按榜过滤 |
| `GET /api/options/:id` | 公开 | 单条 |
| `GET /api/config` | 公开 | 地图页配置 `{ amap: { key, securityCode } }`；未配置 key 时 `amap: null` |
| `POST /api/options` | 密钥 | Body `{name, emoji, listIds?: [1,2], latitude?, longitude?, address?}`；不给 `listIds` 时归入默认榜单；重名返回 **409** |
| `PUT /api/options/:id` | 密钥 | 全量更新 name / emoji；改成已有店名返回 **409**；不带坐标字段时坐标保留 |
| `PATCH /api/options/:id` | 密钥 | 部分更新；同上 |
| `DELETE /api/options/:id` | 密钥 | **删除店铺本身**，连带解除它在所有榜单里的关联 |
| `POST /api/options/import` | 密钥 | Body `{mode:"append"\|"replace", items:[{name,emoji,latitude?,longitude?,address?}], listId?}`；重名不新建行而是复用并挂进目标榜；`replace` 会 `TRUNCATE` 店铺与全部关联，**不可撤销** |

### 榜单

| 接口 | 鉴权 | 说明 |
|---|---|---|
| `GET /api/lists` | 公开 | 榜单列表，含每个榜的店铺数 |
| `POST /api/lists` | 密钥 | Body `{name}`；同名返回 409 |
| `PATCH /api/lists/:id` | 密钥 | Body `{name?, sortOrder?}` —— 改名与排序 |
| `DELETE /api/lists/:id` | 密钥 | 只删榜单与关联，**店铺本身保留** |
| `POST /api/lists/:id/membership` | 密钥 | Body `{mode:"add"\|"remove"\|"replace", optionIds:[...]}` |

非法 id / 非法 mode 一律 400，不存在的资源 404；`GET /api/options?list=<已删除的榜>` 返回空数组而不是报错。

### 地理信息（可选字段）的严格校验

坐标是「有则必须合法」的可选元数据，任何一条不合法整个请求 400：

- `latitude` ∈ [-90, 90]、`longitude` ∈ [-180, 180]，必须是数字（不是字符串 `"30.1"` 也不行）
- **成对语义**：POST/PUT 必须同时给或同时不给；PATCH 改完之后不允许出现「有 lat 没 lng」的半对状态，成对传 `null` 才是清除
- `address` 最长 200 字，空串等价于清除
- 种子/快照里的坐标坏了不会挡住启动（宽松解析，丢坐标保店铺）；接口请求则严格拒绝

## 测试

```bash
npm run smoke
```

`scripts/smoke.sh` 会在一个**临时 PostgreSQL schema** 中跑完 109 项断言（鉴权、静态越界读取、跨域写、爆破限流、启动策略、CRUD、批量导入、多榜单语义、地理信息校验、PWA 静态资源），结束即 `drop schema`，不触碰 `public` 的正式数据。需要本机 PostgreSQL 可用且账号有建 schema 的权限。

连接信息一律来自环境，**脚本里不内置任何默认口令**：优先读仓库根目录的 `.env`，也可用 `SMOKE_PGHOST` / `SMOKE_PGPORT` / `SMOKE_PGDATABASE` / `SMOKE_PGUSER` / `SMOKE_PGPASSWORD` 覆盖；拿不到就退出码 2。测试用密钥每次随机生成，不落盘。

CI：`.github/workflows/smoke.yml` 用一次性 `postgres:16-alpine` 服务容器跑同一个脚本。

## 数据模型、迁移与快照

三张表，多对多：

```text
food_options(id, name, emoji, latitude, longitude, address, ...)  ← 一家店的唯一真相（地理字段可空）
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

## 地图页：高德标注

「地图」屏把已定位的店标在高德地图上（emoji 圆形标记，点击弹店名 / 地址 / 榜单气泡），顶部的榜单筛选与首页共用同一个选中态。需要两把免费的高德 key（[lbs.amap.com](https://lbs.amap.com) 注册个人开发者）：

| Key 类型 | 环境变量 | 用途 |
|---|---|---|
| Web端 (JS API) | `AMAP_JSAPI_KEY` + `AMAP_SECURITY_CODE` | 前端画地图；随 `GET /api/config` 公开下发，建议在高德控制台配域名白名单 |
| Web 服务 | `AMAP_WEB_KEY` | 只在 `npm run geocode` 里批量查坐标，不下发前端 |

批量定位：`npm run geocode`（先 `--dry-run` 看一遍）。脚本对没坐标的店调高德关键字搜索，命中才写库；拿不准的列在「待人工复核」清单里，可在管理页编辑里手工补坐标。跑完记得 `npm run export` 更新快照。

没配置 key 时地图页显示配置指引，其余功能完全不受影响。

## PWA：添加到主屏幕

- 手机浏览器打开站点 → 分享/菜单 → **添加到主屏幕**，之后从桌面图标进入就是独立窗口（无地址栏），图标用的是狐狸头像。
- 缓存策略（详见 `sw.js` 头部注释）：`/api/*` 永不缓存；图标与大图缓存优先；页面和脚本网络优先、断网回退上次缓存。
- **发版后想让访客立刻拿到新前端**：把 `sw.js` 里的 `CACHE = 'huliaeat-v2'` 版本号 +1，旧缓存整体作废；普通改动（改店铺数据）不涉及缓存，无需动它。
- Service Worker 只在 **HTTPS 或 localhost** 生效；纯 HTTP 的 IP 地址上自动降级成普通网页，功能不受影响，只是没有离线兜底和桌面图标。
- 图标在 `icons/`（192/512/180 三张），由 `image1/eateat.jpg` 居中裁切生成，想换独立设计直接替换这三张 PNG 即可。

## 已知待办

- 暂无单元测试框架，只有 `scripts/smoke.sh`（CI 已接入，跑的是接口级冒烟）
- 权限模型是**单一共享密钥**（存在浏览器 `localStorage`），足以防止路人误改/清空菜单，但没有多用户账号与操作审计；若将来要开放多人分别管理，需要改造成 session / 用户表方案
- HTTPS 不在应用层强制，需由反向代理（Nginx / Caddy）或托管平台提供。**在没有 HTTPS 的地址上使用管理密钥 = 密钥明文过网**，公网部署务必先套 TLS；Service Worker 也只在 HTTPS / localhost 生效
- 本机 Homebrew PostgreSQL 用 `trust` 认证且只监听回环，因此 `ALTER USER ... PASSWORD` 在本地不起实际门禁作用（口令轮换的意义在于别把跟仓库示例相同的值带上线）

## 项目结构

```text
.
├── index.html              # 单页前端（首页 / 地图 / 结果 / 管理四屏）
├── styles.css              # 暖色「狐狸食堂」主题
├── script.js               # 前端逻辑 + 榜单切换 + 本机排除 + 管理密钥处理
├── map.js                  # 地图屏：高德 JSAPI 动态加载 + emoji 标注（按需加载）
├── emoji-rules.js          # 关键词→Emoji 规则，前后端共用唯一一份
├── sw.js                   # Service Worker（缓存策略写在文件头注释里）
├── manifest.webmanifest    # PWA 清单
├── icons/                  # 应用图标 192/512/180（由 image1/eateat.jpg 居中裁切，可自行替换）
├── server.js               # Express API + 鉴权 / CORS / 静态白名单 + 迁移执行
├── migrations/
│   ├── 001_init.sql        # 基线结构（幂等）
│   ├── 002_lists.sql       # 多榜单 + 存量数据回填
│   ├── 003_unique_name.sql # 店名唯一 + 既有重名行合并
│   └── 004_add_location.sql# 地理信息（经纬度 + 地址，可空）
├── scripts/
│   ├── smoke.sh            # 安全与接口冒烟测试（109 项断言）
│   ├── export-snapshot.js  # 数据库 → data/options.json 快照
│   ├── geocode-options.js  # 高德关键字搜索批量查坐标（需 AMAP_WEB_KEY）
│   └── geocode-hints.json  # 易撞名店铺的地址提示词
├── .github/workflows/
│   └── smoke.yml           # CI：一次性 postgres:16 服务容器跑冒烟
├── Dockerfile              # 非 root 运行 + 健康检查（容器内 HOST=0.0.0.0）
├── docker-compose.yml      # app + postgres（数据库端口不对宿主机发布）
├── .dockerignore
├── .env.example
├── data/
│   ├── options.json        # 种子 = 快照（受 git 跟踪）
│   └── backups/            # pg_dump 紧急备份（gitignore，也不进镜像）
└── README.md
```

## 更新记录

- **2026-09-05（地图页）** — 第四屏「地图」：高德 JSAPI 动态加载 + emoji 标注 + 榜单筛选；`004` 迁移给 `food_options` 加 `latitude` / `longitude` / `address`（可空）；所有写接口对坐标做严格校验（成对、范围、null 清除，非法整单 400）；`GET /api/config` 公开下发地图 key；`npm run geocode` 用「Web 服务」key 批量查坐标（提示词在 `scripts/geocode-hints.json`）；快照与种子支持坐标回灌；冒烟扩到 109 项
- **2026-09-05 · `3de9b91`** — 依赖安全:在 `package.json` 加 `overrides` 把 `qs` 锁到 `^6.16.0`,修掉经由 express/body-parser 传递进来的 3 个 qs DoS 公告(修复版超出上游声明的 `~` 范围,`npm audit fix` 自动够不着);express 随之升至 4.22.1,90 项冒烟全过
- **2026-09-03 · `a7181ca`** — 导入与校验加固:批量导入的 `mode` 必须显式传值,非法值直接 400(不再默认当 `replace`);新建店铺挂榜 / membership 关联增加存在性预检,引用不存在的榜单或店铺返回 404 而非数据库外键错误;ID 解析改为严格整数校验;冒烟断言扩到 90 项;`.env.example` 补齐 compose 所需的 `POSTGRES_*` 三项
- **2026-09-03 · `51c777c`** — 店名唯一约束（`003` 迁移合并既有重名行 + 单条/编辑重名一律 409）；`emoji-rules.js` 让关键词→Emoji 表前后端共用一份，纯 API 导入也能自动配图；PWA（manifest + Service Worker + 三张图标）；`.dockerignore` 补漏（备份目录不再进镜像）
- **2026-09-02 · `8bc7e38`** — 修 CI 暴露的可移植性问题（`mktemp -t` 是 BSD 写法，GNU 下导致服务起不来）；运行时 Node 20（已 EOL）→ 22；checkout/setup-node 升 v7；冒烟失败细节改为 `::error::` annotation，公开 API 可读
- **2026-09-02 · `cfaeee3`** — 多榜单：`lists` / `list_items` 多对多 + 首页榜单切换 + 管理页建榜/改名/移店；`migrations/` 启动时自动执行（001 基线、002 多榜单 + 存量回填）；结果页「最近不想吃」本机排除与「下架」分离；`HOST` 默认只绑回环；`npm run export` 快照（兼作空库种子）；18 家占位 🍽️ 全部配上手挑图标
- **2026-09-02 · `27e4481`** — 安全加固：全部写接口要求管理密钥（常数时间比较 + IP 级爆破限流）、静态资源白名单、跨域写白名单、production 缺密钥拒绝启动；冒烟测试上线（后扩到 83 项）并接入 GitHub Actions
- **2026-07-23 · `90e6184`** — PostgreSQL 持久化 + Docker 部署 + 界面重做 + 必吃榜批量导入
- **2026-03-31 · `e3b54d7` / `df55154`** — 初始版本：前端三屏 + 后端雏形
