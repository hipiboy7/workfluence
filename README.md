# workfluence

금융 폐쇄망 내부용 위키·문서 협업 시스템 (Confluence 대체).

- **무엇을/왜**: [`docs/scope-definition.md`](docs/scope-definition.md)
- **어떻게**: [`docs/설계서_Architecture.md`](docs/설계서_Architecture.md)
- **작업 규칙**: [`CLAUDE.md`](CLAUDE.md)
- **현재 단계**: Phase 0 (공통 기반) — [`docs/P0_요구사항정의서_Foundation.md`](docs/P0_요구사항정의서_Foundation.md)

## 구조

```
apps/api/          NestJS API (빌드된 SPA도 함께 서빙)
apps/web/          React + Vite SPA
packages/shared/   서버·클라이언트 공유 계약 (환경 스키마·상수·문서 검증·권한·DTO)
e2e/               Playwright
deploy/            Dockerfile · compose · nginx (Linux 서버에서 빌드)
scripts/           check-env · dev-db · verify-docs · e2e (tsx, OS 무관)
docs/              산출물 / docs/internal 작업 기록 / docs/prompts 요청 기록
.local/            (git 무시) PostgreSQL 데이터·pnpm store·Playwright 브라우저 — 전부 D 드라이브
```

## 개발 환경 준비

Node 24와 pnpm 12가 필요하다. 프로젝트 데이터는 전부 저장소 안 `.local/`에 생긴다.

```bash
pnpm install
pnpm setup:env
```

## 실행

터미널 두 개를 쓴다.

```bash
pnpm dev:db          # 터미널 1: 임베디드 PostgreSQL (첫 실행 시 초기화까지)
```

```bash
pnpm db:migrate      # 터미널 2: 마이그레이션 적용
pnpm check:env       # 마지막 줄에 READY 확인
pnpm dev             # 개발 서버 (web http://127.0.0.1:5173, api :3000)
```

운영과 같은 단일 프로세스로 확인하려면 `.env`에 `WF_SERVE_WEB=true`를 두고:

```bash
pnpm build
pnpm start           # http://127.0.0.1:3000
```

## 검사

```bash
pnpm check           # lint + typecheck + test + verify:docs (CI와 동일)
pnpm test:cov        # 커버리지
pnpm test:e2e        # Playwright (api가 떠 있어야 한다)
```

## 배포

Linux 서버에서 이미지를 빌드해 폐쇄망으로 반입한다. 절차는 [`docs/설계서_Architecture.md`](docs/설계서_Architecture.md) 9절, 상세 가이드는 Phase 5에서 작성한다.
