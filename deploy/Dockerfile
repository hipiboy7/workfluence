# workfluence app 이미지 — Nest API + 빌드된 SPA를 한 프로세스가 서빙 (CLAUDE.md 0.2절·8.2절)
# 빌드: Linux 서버에서  docker build -f deploy/Dockerfile -t workfluence-app:<git-sha> .
# 실행: deploy/compose.yml
#
# 프로토타입 단계: 이 파일은 Windows 개발 PC에서는 빌드할 수 없다(Docker 없음). Linux 서버에서 실측 후 조정한다.

# ---------- 1) 빌드 ----------
FROM node:24-bookworm-slim AS build
ENV CI=true
RUN npm install -g pnpm@12.4.1
WORKDIR /src

# 의존성 레이어 캐시: 매니페스트만 먼저
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN pnpm install --frozen-lockfile

COPY . .
RUN pnpm build \
 && pnpm --filter @workfluence/api deploy --legacy --prod /out/api \
 && mkdir -p /out/web && cp -r apps/web/dist /out/web/dist

# ---------- 2) 런타임 ----------
FROM node:24-bookworm-slim
ENV NODE_ENV=production \
    WF_ENV=production \
    WF_SERVE_WEB=true \
    WF_WEB_DIST=../web/dist \
    WF_PORT=3000
# 레이아웃: /app/api/dist/main.js 가 WF_WEB_DIST를 `resolve(__dirname, '..', WF_WEB_DIST)`로 푼다.
#   __dirname=/app/api/dist → 기준 /app/api → `../web/dist` = /app/web/dist
# `../../web/dist`로 두면 /web/dist가 되어 SPA가 통째로 404인데 /api/health는 200이라
# **헬스체크가 healthy를 보고한다.** 조용히 잘못되는 유형이라 주석으로 남긴다.
WORKDIR /app/api
COPY --from=build /out/api /app/api
COPY --from=build /out/web /app/web
# non-root (CLAUDE.md 7절)
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "--enable-source-maps", "dist/main.js"]
