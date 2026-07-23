# 狐狸今天吃什么

一个可上线的餐饮随机选择应用，支持完整 CRUD（增删改查）并使用 PostgreSQL 持久化，适合部署到任意服务器。

## 关键特性

- 随机抽取餐饮选项（前端动画）
- 管理页支持新增、编辑、删除
- 后端完整 REST API
- PostgreSQL 持久化（跨服务器、跨重启不丢）
- 首次启动可从 `data/options.json` 做一次性初始化
- Docker / Docker Compose 部署

## 技术栈

- 前端：HTML + CSS + JavaScript
- 后端：Node.js + Express
- 数据库：PostgreSQL

## 环境变量

- `PORT`：服务端口，默认 `3000`
- `DATABASE_URL`：PostgreSQL 连接串（必填）
- `DATABASE_SSL`：是否启用数据库 SSL，`true` / `false`，默认 `false`
- `SEED_FILE`：首次初始化种子文件路径，默认 `./data/options.json`

参考：`.env.example`

## 本地开发

### 方式一：你本机已有 PostgreSQL

```bash
npm install
cp .env.example .env
npm start
```

确保 `.env` 里的 `DATABASE_URL` 能连接你的数据库。

### 方式二：Docker Compose（推荐）

```bash
docker compose up -d --build
```

访问：`http://localhost:3000`

## API

### 1) 健康检查
- `GET /api/health`

### 2) 查询全部选项
- `GET /api/options`

### 3) 查询单个选项
- `GET /api/options/:id`

### 4) 新增选项
- `POST /api/options`
- Body:
```json
{
  "name": "螺蛳粉",
  "emoji": "🍜"
}
```

### 5) 全量更新选项
- `PUT /api/options/:id`

### 6) 部分更新选项
- `PATCH /api/options/:id`

### 7) 删除选项
- `DELETE /api/options/:id`

## 持久化说明

- 现在持久化由 PostgreSQL 保证。
- 只要 `DATABASE_URL` 指向同一个数据库，换服务器部署也会看到同一份数据。
- `SEED_FILE` 只在数据库表为空时生效（一次性初始化）。

## 项目结构

```text
.
├── index.html
├── styles.css
├── script.js
├── server.js
├── Dockerfile
├── docker-compose.yml
├── .dockerignore
├── .env.example
├── data/
│   ├── .gitkeep
│   └── options.json
└── README.md
```
