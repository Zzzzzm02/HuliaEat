# 狐狸今天吃什么

一个可上线的餐饮随机选择应用，支持完整 CRUD（增删改查）并使用 PostgreSQL 持久化，适合部署到任意服务器。

## 关键特性

- 随机抽取餐饮选项（前端动画）
- 管理页支持新增、编辑、删除、批量导入
- 后端完整 REST API，**写接口受管理密钥保护**
- PostgreSQL 持久化（跨服务器、跨重启不丢）
- 首次启动可从 `data/options.json` 做一次性初始化
- Docker / Docker Compose 部署
- `scripts/smoke.sh` 一键安全与接口冒烟测试

## 安全模型

| 能力 | 暴露面 |
|---|---|
| 读接口（`GET /api/health`、`GET /api/options`、`GET /api/options/:id`） | 公开，任何人可抽一次吃的；跨域读取也开放 |
| 写接口（`POST/PUT/PATCH/DELETE`、`POST /api/options/import`） | 需要管理密钥；`replace` 模式会 `TRUNCATE` 整表，务必保管好密钥 |
| 静态资源 | 仅 `/`、`/styles.css`、`/script.js`、`/image1/*`，其余（源码、`data/`、`.git/`）返回 404 |

写接口密钥通过 `x-admin-token: <ADMIN_TOKEN>` 或 `Authorization: Bearer <ADMIN_TOKEN>` 头传递。管理页首次触发写操作时会弹窗索取密钥，输入后保存在浏览器 `localStorage`，可在「管理选项」页顶部重新设置或清除。

另外四条默认策略：

- **跨域写白名单**：非白名单来源的跨域写请求直接 403（即使密钥正确）。前后端同源部署时无需配置 `CORS_ALLOWED_ORIGINS`。
- **爆破限流**：同一 IP 在 5 分钟内错 20 次密钥后返回 429。注意这是 **IP 级锁定**：窗口期内即使携带正确密钥也会被挡，需等窗口过期（约 5 分钟）自动恢复。放在 Nginx 等反代后面时务必设 `TRUST_PROXY=true`，否则所有访客共用同一个计数桶，容易互相误伤。
- **fail-closed 启动**：`NODE_ENV=production` 且未设置 `ADMIN_TOKEN` 时服务拒绝启动；开发模式不设密钥也能跑，但会在启动日志打印警告。
- **基础安全响应头**：所有响应带 `X-Content-Type-Options: nosniff`、`Referrer-Policy`，以及 `X-Frame-Options: SAMEORIGIN` —— 后者意味着**本页面不能被其他站点用 iframe 嵌入**（同源内嵌不受影响）。

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
| `PORT` | 服务端口 | `3000` |
| `DATABASE_URL` | PostgreSQL 连接串（**必填**） | — |
| `DATABASE_SSL` | 是否启用数据库 SSL，`true` / `false` | `false` |
| `SEED_FILE` | 首次初始化种子文件路径 | `./data/options.json` |
| `NODE_ENV` | `production` 时强制要求 `ADMIN_TOKEN` | — |
| `ADMIN_TOKEN` | 写接口管理密钥；留空 = 开发模式（不鉴权） | 空 |
| `CORS_ALLOWED_ORIGINS` | 允许跨域写操作的来源，逗号分隔 | 空（仅同域） |
| `TRUST_PROXY` | 反向代理后取真实客户端 IP，`true` / `false` | `false` |

参考：`.env.example`

> 注意：本项目不依赖 `dotenv`，直接 `node server.js` 时请用下面的内联写法，或先 `export`。

## 本地开发

```bash
npm install

ADMIN_TOKEN=dev-secret \
DATABASE_URL=postgresql://huliaeat:huliaeat@localhost:5432/huliaeat \
npm start
```

访问 `http://localhost:3000`（端口被占用时前面加 `PORT=3210`）。

只想快速跑起来、不关心鉴权，去掉 `ADMIN_TOKEN` 即可 —— 写接口会开放，但启动日志会给出警告，且这种配置不要暴露到公网。

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

### 1) 健康检查
- `GET /api/health`　公开

### 2) 查询全部选项
- `GET /api/options`　公开

### 3) 查询单个选项
- `GET /api/options/:id`　公开

### 4) 新增选项
- `POST /api/options`　需要密钥
- Body:
```json
{
  "name": "螺蛳粉",
  "emoji": "🍜"
}
```

### 5) 全量更新选项
- `PUT /api/options/:id`　需要密钥

### 6) 部分更新选项
- `PATCH /api/options/:id`　需要密钥

### 7) 删除选项
- `DELETE /api/options/:id`　需要密钥

### 8) 批量导入
- `POST /api/options/import`　需要密钥
- Body: `{ "mode": "append" | "replace", "items": [{ "name": "楼外楼", "emoji": "🍜" }] }`
- `append` 跳过重名；`replace` 先 `TRUNCATE` 整表再写入，**不可撤销**

## 测试

```bash
npm run smoke
```

`scripts/smoke.sh` 会在一个**临时 PostgreSQL schema** 中跑完 56 项断言（鉴权、静态越界读取、跨域写、爆破限流、启动策略、CRUD 与导入往返），结束即 `drop schema`，不触碰 `public.food_options` 的正式数据。需要本机 PostgreSQL 可用且账号有建 schema 的权限；连接信息可用 `SMOKE_PGHOST` / `SMOKE_PGPORT` / `SMOKE_PGDATABASE` / `SMOKE_PGUSER` / `SMOKE_PGPASSWORD` 覆盖。

## 持久化说明

- 持久化由 PostgreSQL 保证；只要 `DATABASE_URL` 指向同一个库，换服务器也是同一份数据。
- `SEED_FILE` 只在表为空时生效（一次性初始化），之后修改种子文件不会影响已有数据。

## 已知待办

- `name` 尚无唯一约束，单条 `POST` 重名仍会成功（只有导入路径做了去重）
- 默认名单里仍有部分餐厅使用通用 `🍽️` 占位 Emoji
- 暂无 CI 与单元测试框架，目前只有 `scripts/smoke.sh`
- 权限模型是**单一共享密钥**（存在浏览器 `localStorage`），足以防止路人误改/清空菜单，但没有多用户账号与操作审计；若将来要开放多人分别管理，需要改造成 session / 用户表方案
- HTTPS 不在应用层强制，需由反向代理（Nginx / Caddy）或托管平台提供

## 项目结构

```text
.
├── index.html          # 单页前端
├── styles.css          # 暖色「狐狸食堂」主题
├── script.js           # 前端逻辑 + 管理密钥处理
├── server.js           # Express API + 鉴权 / CORS / 静态白名单
├── scripts/
│   └── smoke.sh        # 安全与接口冒烟测试
├── Dockerfile          # 非 root 运行 + 健康检查
├── docker-compose.yml  # app + postgres
├── .dockerignore
├── .env.example
├── data/
│   └── options.json    # 首次初始化的种子名单
└── README.md
```
