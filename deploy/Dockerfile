# workfluence app 이미지 — Nest API + 빌드된 SPA를 한 프로세스가 서빙 (CLAUDE.md 0.2절·8.2절)
# 빌드: Linux 서버에서  docker build -f deploy/Dockerfile -t workfluence-app:<git-sha> .
# 실행: deploy/compose.yml
#
# 개발과 빌드는 같은 Linux 서버에서 한다 (CLAUDE.md 0.3절, 2026-09-21 통합).

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
 && mkdir -p /out/web && cp -r apps/web/dist /out/web/dist \
 # 의존성이 함께 들여온 **소스맵과 README를 지운다** (P7 FR-804). 실행에 쓰이지 않는데
 # 합쳐서 11MB이고, app 이미지 예산 400MB에 여유가 0이던 상태였다.
 # **런타임 스테이지가 아니라 여기서 지운다** — 뒤에서 지우면 앞 레이어에 그대로 남는다.
 # `LICENSE`는 남긴다 (7절 라이선스 목록). 우리 `dist`의 소스맵도 남긴다 — 장애 때 필요하다
 && find /out/api/node_modules -type f \( -name '*.map' -o -name '*.md' -o -name '*.markdown' \) -delete

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
# 첨부 저장 경로를 **이미지 안에 미리 만들고 node 소유로 둔다.**
# 이름 있는 볼륨은 마운트 지점이 이미지에 없으면 root 소유로 새로 만들어지고, 그러면
# non-root로 도는 앱이 첫 업로드에서 EACCES로 막힌다. 미리 있으면 도커가 그 소유·권한을 옮긴다
RUN mkdir -p /data/attachments && chown -R node:node /data
# non-root (CLAUDE.md 7절)
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "--enable-source-maps", "dist/main.js"]
