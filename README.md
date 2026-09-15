# workfluence

금융 폐쇄망 내부용 위키·문서 협업 시스템 (Confluence 대체).

- **작업 규칙**: [`CLAUDE.md`](CLAUDE.md) — 이 저장소에서 코드·문서를 만들 때 지키는 단일 규칙서
- **무엇을/왜**: `docs/scope-definition.md` (Phase 0 산출물, 작성 예정)
- **어떻게**: `docs/설계서_Architecture.md` (Phase 0 산출물, 작성 예정)
- **프로토타입**: [`PROTOTYPE.md`](PROTOTYPE.md) — `exp/prototype` 브랜치. 실행 방법·검증 결과·교훈

## 구조

```
apps/api/          NestJS API (빌드된 SPA도 함께 서빙)
apps/web/          React + Vite + TipTap SPA
packages/shared/   서버·클라이언트 공유 계약 (환경 스키마·상수·문서 검증·권한·DTO)
e2e/               Playwright E2E
deploy/            Dockerfile · compose · nginx (Linux 서버에서 빌드)
scripts/           check:env · dev:db · e2e 실행 스크립트 (OS 무관, tsx)
docs/              운영 이관 산출물 / docs/internal/ 작업 기록 / docs/prompts/ 요청 기록
.local/            (git 무시) PostgreSQL 데이터·pnpm store·Playwright 브라우저 — 전부 D 드라이브
```

## 빠른 시작

`PROTOTYPE.md` 2절. 요약: `pnpm install` → `.env` 작성 → `pnpm dev:db` → `pnpm db:migrate` → `pnpm db:seed` → `pnpm build && pnpm start` → `http://127.0.0.1:3000`.
시드 계정(root·admin1·member1·pending1)과 비밀번호 규칙은 `PROTOTYPE.md` 2절 표.
