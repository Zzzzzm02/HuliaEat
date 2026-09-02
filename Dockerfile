FROM node:20-alpine

ENV NODE_ENV=production \
    PORT=3000

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY --chown=node:node . .

# 以非 root 运行：即使应用被攻破，容器内也没有 root 权限
USER node

EXPOSE 3000

# busybox wget 由 alpine 自带，无需额外安装 curl
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD wget -qO- "http://127.0.0.1:${PORT}/api/health" > /dev/null 2>&1 || exit 1

CMD ["node", "server.js"]
