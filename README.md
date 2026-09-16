# workfluence

금융 폐쇄망 내부용 위키·문서 협업 시스템 (Confluence 대체).

**현재 단계**: Phase 0 (공통 기반). Linux 서버 이미지 빌드 검증만 남았다.

## 처음 온 사람이 읽는 순서

| 순서 | 문서 | 왜 |
|---|---|---|
| 1 | [`docs/학습가이드_시스템이해.md`](docs/학습가이드_시스템이해.md) | 개발 용어 없이 전체 그림을 잡는다. 30분 |
| 2 | [`docs/scope-definition.md`](docs/scope-definition.md) | 무엇을 왜 만드는가, 어디까지가 범위인가 |
| 3 | [`docs/설계서_Architecture.md`](docs/설계서_Architecture.md) | 구조·데이터 모델·확장점. 코드를 읽기 전에 본다 |
| 4 | [`CLAUDE.md`](CLAUDE.md) | 이 저장소에서 코드·문서를 만드는 규칙 |
| 5 | [`docs/P0_설계서_Foundation.md`](docs/P0_설계서_Foundation.md) | Phase 0이 만든 것의 요구사항과 설계 |
| 6 | 아래 "개발 환경 준비"를 직접 실행 | 문서를 믿지 말고 돌려 본다 |

그다음 필요할 때 보는 문서다.

| 상황 | 문서 |
|---|---|
| 장애가 났다 | [`docs/운영가이드_장애대응.md`](docs/운영가이드_장애대응.md) |
| 새 기능을 넣고 싶다 | [`docs/기능백로그.md`](docs/기능백로그.md) |
| 이 오류 본 적 있나 | [`docs/internal/검토서_트러블슈팅.md`](docs/internal/검토서_트러블슈팅.md) |
| 무엇을 어떻게 검증했나 | [`docs/P0_검증기록_Foundation.md`](docs/P0_검증기록_Foundation.md) |
| 왜 이런 작업 방식인가 | [`docs/internal/검토서_방법론개정.md`](docs/internal/검토서_방법론개정.md) |

## 구조

```
apps/api/          NestJS API (빌드된 SPA도 함께 서빙)
apps/web/          React + Vite SPA
packages/shared/   서버·클라이언트 공유 계약 (환경 스키마·상수·문서 검증·권한·DTO)
e2e/               Playwright
deploy/            Dockerfile · compose · nginx (Linux 서버에서 빌드)
scripts/           check-env · dev-db · verify-docs · e2e (tsx, OS 무관)
docs/              운영·인수인계 산출물 / docs/internal 작업 기록 / docs/prompts 요청 원문
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
pnpm dev:db          # 터미널 1: 임베디드 PostgreSQL (첫 실행 시 초기화까지). Ctrl+C로 종료
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
pnpm check           # lint + typecheck + test + verify:docs (CI와 같은 검사)
pnpm test:cov        # 커버리지
pnpm test:e2e        # Playwright (api가 떠 있어야 한다)
```

## 배포

Linux 서버에서 이미지를 빌드해 폐쇄망으로 반입한다. 경로는 [`docs/설계서_Architecture.md`](docs/설계서_Architecture.md) 9절, Phase 0 검증 명령은 [`docs/P0_검증기록_Foundation.md`](docs/P0_검증기록_Foundation.md) 6.1절에 있다. 운영 이관용 상세 가이드는 Phase 5에서 작성한다.
