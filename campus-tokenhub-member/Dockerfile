# ---- 依赖层 ----
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

# ---- 构建层 ----
FROM node:22-alpine AS builder
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
# 门户挂载路径前缀（线上 /tokenhub/portal）。basePath 是构建期配置，改动必须重建镜像。
ARG PORTAL_BASE_PATH=""
ENV PORTAL_BASE_PATH=${PORTAL_BASE_PATH}
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# 构建上下文必须是唯一的门户根。历史上出现过把部署包解到已有部署目录里、形成
# `campus-tokenhub/campus-tokenhub/...` 嵌套副本的情况：Next 的类型检查会把副本里的
# 网关源码一起扫进来，用门户的 `@/*`（指向 ./src）解析管理台的 `@/lib/auth`，
# 报一堆与门户无关的 "Cannot find module"。这里提前拦住，避免又慢又难读的假报错。
RUN if [ -d campus-tokenhub ]; then \
		echo "构建上下文里存在嵌套副本 campus-tokenhub/：请删除该目录，或在正确的门户根目录重新构建" >&2; \
		exit 1; \
	fi
RUN npm run build

# ---- 运行层：只留 standalone 产物，非 root ----
FROM node:22-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0

RUN addgroup -g 1001 -S nodejs && adduser -S nextjs -u 1001

COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
# 接入指南里的操作截图等静态资源（standalone 产物不会自动带上 public）
COPY --from=builder --chown=nextjs:nodejs /app/public ./public

# 成员账号申请单的落盘目录：命名卷首次挂载到镜像内已存在的路径时才继承这里的属主。
# 不预建的话，Docker 会以 root 创建挂载点，非 root 的 nextjs 进程写盘直接 EACCES。
RUN mkdir -p /app/.data && chown nextjs:nodejs /app/.data

USER nextjs
EXPOSE 3000

# 启动时 instrumentation 会校验环境变量，缺关键项直接退出
CMD ["node", "server.js"]
