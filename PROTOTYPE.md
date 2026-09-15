# workfluence 프로토타입 (`exp/prototype`)

- 작성: 2026-09-15 / 브랜치 `exp/prototype` (탐색 브랜치, `CLAUDE.md` 12.1절)
- 목적: Phase 0 정식 착수 전에 **스택 전체가 한 줄로 이어지는지**를 실제로 동작시켜 확인한다.
  모노레포 → shared 계약 → NestJS API → PostgreSQL → React/TipTap 편집기 → 버전 이력·충돌 감지 → 한글 검색 → 감사로그 → 브라우저 E2E.
- 요청 기록: [`docs/prompts/prototype-v1.md`](docs/prompts/prototype-v1.md)
- 규칙서: [`CLAUDE.md`](CLAUDE.md). 이 문서 5절에 규칙서 대비 편차를 적었다.

## 1. 무엇이 들어 있나

| 영역 | 구현 | 위치 |
|---|---|---|
| 공유 계약 | `WF_*` 환경 스키마(strict), 상수, **문서 JSON 허용 목록 검증·텍스트 추출**, 권한 판정 `can()`, 비밀번호 정책, API DTO(zod) | `packages/shared/src` |
| API | 로컬 로그인(argon2id, 5회 실패 잠금), PG 세션(유휴·절대 타임아웃), CSRF 헤더, 보안 헤더, 스페이스 CRUD, 페이지 트리, **append-only 버전·409 충돌**, 버전 복원, 이동(순환·깊이 검사), soft delete, 한글 검색(ILIKE + pg_trgm), 사용자 관리, **append-only 감사로그**, `/api/health`, SPA 정적 서빙(해시 자산 immutable) | `apps/api/src` |
| 웹 | 로그인, 스페이스 목록·생성, 페이지 트리, 읽기 화면, **TipTap 편집기**(제목·목록·인용·코드·표·링크), 저장 충돌 안내, 버전 이력·복원, 검색, 관리(사용자·감사로그) | `apps/web/src` |
| DB | Drizzle 스키마 + SQL 마이그레이션 2개(`0000_init`, `0001_search_trgm`: pg_trgm·GIN·감사로그 불변 트리거), 멱등 시드 | `apps/api/src/db`, `apps/api/drizzle` |
| 개발 DB | 임베디드 PostgreSQL 17.10을 `.local/pgdata`에서 기동 (`pnpm dev:db`) | `scripts/dev-db.ts` |
| E2E | Playwright(Chromium, `.local/ms-playwright`) 3 시나리오 | `e2e/` |
| 배포(미검증) | 멀티스테이지 Dockerfile, compose(postgres·api·nginx), nginx.conf | `deploy/` |

들어 있지 않은 것: OIDC(Phase 1), 첨부·댓글·라벨(Phase 3), 스페이스별 권한·휴지통 UI·템플릿·알림(Phase 4), lint·`verify:docs`·CI·gitleaks(Phase 0 정식), 실시간 동시 편집(Phase 6).

## 2. 실행 방법 (Windows 개발 PC)

명령은 전부 `pnpm` 스크립트다 (`CLAUDE.md` 4.1절). 데이터는 전부 `.local/` 아래(D 드라이브)에 생긴다.

```bash
pnpm install                    # store·cache는 .local/ (pnpm-workspace.yaml)
cp .env.example .env            # WF_SESSION_SECRET(32자 이상), WF_ADMIN_INITIAL_PASSWORD 채우기
pnpm dev:db                     # 터미널 1: 임베디드 PostgreSQL (첫 실행 시 initdb + DB 2개 생성)
pnpm db:migrate                 # 터미널 2
pnpm db:seed                    # 관리자 계정 + (development) DEMO 스페이스
pnpm check:env                  # READY 확인
```

개발 모드(핫 리로드): `pnpm dev` → web `http://127.0.0.1:5173` (`/api`는 3000으로 프록시).
통합 모드(운영과 같은 단일 프로세스): `.env`에 `WF_SERVE_WEB=true` → `pnpm build` → `pnpm start` → `http://127.0.0.1:3000`.

테스트: `pnpm test` (A·B), `pnpm test:cov`, `pnpm test:e2e` (통합 모드 api가 떠 있어야 함), `pnpm typecheck`.

## 3. 검증 결과 (2026-09-15, 이 PC)

| 항목 | 결과 |
|---|---|
| `packages/shared` 테스트 | 4 파일 27건 통과. 커버리지 라인 98.5% / 브랜치 98.2% / 함수 100% (A등급 관문 90% 통과) |
| API 시나리오 (curl 21단계) | 401 미인증, 403 CSRF 헤더 누락, 401 비밀번호 오류(사유 비노출), 로그인·me, 스페이스·트리, 페이지 생성, v1→v2 저장 200, **stale 저장 409**(currentVersionNo 반환), **iframe 노드 400**, 이력 목록, v1 복원→v3, 사용자 생성 201, 약한 비밀번호 400(사유 2건), 감사로그 6종, member의 감사로그 403·페이지 200, 로그아웃 204 후 401 |
| 한글 (Node fetch) | 제목·본문 한글 왕복 정상. 2글자 질의 "배포"·"결재" 검색 적중, 스니펫 생성, `javascript:` 링크 400, 삭제 후 404 |
| SPA 서빙 | `/`·딥링크 200 text/html + `no-store`, `assets/*-<hash>.js` → `public, max-age=31536000, immutable`, `/api/*` → `no-store` |
| E2E (Chromium) | 3/3 통과: 로그인→DEMO→페이지→편집기에 타이핑→저장(v+1)→이력(이전 버전 열기·복원 버튼)→검색 / 비로그인 리다이렉트 / 관리 화면 |
| 빌드 | api tsc 통과, web Vite 8 빌드 805KB(gzip 251KB) 단일 청크 |
| DB | PostgreSQL 17.10 임베디드, 마이그레이션 2개 적용, 감사로그 UPDATE/DELETE 트리거로 차단 |

curl로 한글을 보내면 Windows 콘솔 인코딩 때문에 `??`로 저장됐다. 앱 문제가 아니라 셸 문제이며, 한글 검증은 Node 스크립트로 했다. **문서에 적는 검증 명령은 OS 인코딩에 영향받지 않는 형태(pnpm 스크립트·Node)로 둔다.**

## 4. 실측으로 알게 된 것 (Phase 0에 가져갈 교훈)

| # | 실측 | 반영 |
|---|---|---|
| 1 | pnpm 12는 `.npmrc`의 `store-dir`를 무시한다. `pnpm-workspace.yaml`의 `storeDir`만 먹는다. `stateDir`은 프로젝트 단위 설정 불가 | `CLAUDE.md` 8.1절 갱신 완료 |
| 2 | pnpm 12는 설치 스크립트 허용을 `allowBuilds:` 맵으로 받는다 (`onlyBuiltDependencies` 아님) | `pnpm-workspace.yaml` |
| 3 | zod 4의 `.default()`는 출력 타입 값을 받고 파싱을 건너뛴다. `.partial()`은 default를 유지한다 | `env.ts`, `schemas.ts` |
| 4 | NestJS 가드(`AuthGuard`)의 의존성은 가드를 쓰는 **컨트롤러의 모듈**에서 해석된다. `UsersModule`·`AuditModule`을 `@Global()`로 | `users.module.ts`, `audit.module.ts` |
| 5 | TypeScript 7이 latest지만 데코레이터 메타데이터 호환 위험이 있어 5.9로 고정 | 루트 `package.json` |
| 6 | PostgreSQL 서버는 관리자 권한 셸에서 기동을 거부한다. 이 PC의 작업 셸은 비상승이라 임베디드 PG가 뜬다 | `CLAUDE.md` 8.1절 |
| 7 | jsonb는 키 순서를 정규화해 저장 전후 `JSON.stringify`가 다르다. 동등성 비교는 deep-equal로 | 테스트 작성 시 주의 |
| 8 | Vite 해시 파일명은 `name-<base64url 8자>.ext` 형식. 16진수 정규식으로는 못 잡는다 | `app.module.ts` |
| 9 | 페이지 제목 h1과 본문 h1이 공존해 접근성 로케이터가 중복된다 | E2E는 영역 한정 로케이터 |

## 5. 규칙서(`CLAUDE.md`) 대비 편차 — 탐색 브랜치라 허용, 정식 Phase에서 해소

| 편차 | 이유 | 해소 Phase |
|---|---|---|
| 요구사항정의서·설계서·테스트결과서 4단계를 생략하고 이 문서 하나로 기록 | 프로토타입은 "이어지는가"를 보는 것이 목적 | Phase 0에서 정식 문서로 재작성 |
| api B등급 통합 테스트 없음 (수동 시나리오만) | 시간 대비 검증 가치가 E2E에 있었다 | Phase 0~1 |
| lint·`verify:docs`·CI·gitleaks 없음 | | Phase 0 |
| Docker 파일 미검증 | 이 PC에 Docker 없음 | Linux 서버 첫 빌드 |
| 운영 조절값이 아직 상수·`.env`에만 | | Phase 4 |
| `deploy/compose.yml`이 `.env`의 `WF_PG_*` 임베디드 키와 이름 공간을 공유하지 않음 (`WF_PG_PASSWORD`는 compose 전용) | strict 스키마 때문에 컨테이너에는 임베디드 키를 넘기지 않는다 | Phase 0 설계서에서 정리 |

## 6. 다음 단계 제안

1. `impl-phase0`에서 정식 Phase 0: 이 프로토타입의 `packages/shared`·`apps/api/src/{config,db,common}`·`scripts/`·`deploy/`는 그대로 승격 후보. 요구사항정의서·설계서·테스트결과서를 붙이고 lint·verify:docs·CI·gitleaks를 추가한다.
2. Linux 서버에서 `docker build -f deploy/Dockerfile` 실측 → 이미지 크기·`df -h` 기록 (Phase 0 완료 기준).
3. Phase 1에서 OIDC 붙일 때 `AuthGuard`·세션 구조는 그대로 쓰고 로그인 진입점만 추가한다.
