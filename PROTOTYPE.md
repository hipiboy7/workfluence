# workfluence 프로토타입 (`exp/prototype`)

- 작성: 2026-09-15 (v1) / 갱신: 2026-09-15 (v2) — 브랜치 `exp/prototype` (탐색 브랜치, `CLAUDE.md` 12.1절)
- 목적: Phase 0 정식 착수 전에 **스택 전체가 한 줄로 이어지는지**를 실제로 동작시켜 확인하고, 사용자가 직접 실행해 화면 흐름을 검토한다.
- 요청 기록: [`docs/prompts/prototype-v1.md`](docs/prompts/prototype-v1.md), [`docs/prompts/prototype-v2.md`](docs/prompts/prototype-v2.md) (v2의 해석·가정 표 포함)
- 규칙서: [`CLAUDE.md`](CLAUDE.md). 이 문서 5절에 규칙서 대비 편차를 적었다.

## 1. 무엇이 들어 있나

| 영역 | 구현 | 위치 |
|---|---|---|
| 공유 계약 | `WF_*` 환경 스키마(strict), 상수(역할 3단계·스페이스 종류/상태·Crew 역할·감사 이벤트), **문서 JSON 허용 목록 검증·텍스트 추출**, 권한 판정 `can()`·`spaceAccess()`·`canAssignRole()`, 비밀번호 정책(8자·2종), ID·email 마스킹, 임시 비밀번호 생성, API DTO(zod) | `packages/shared/src` |
| 인증·계정 | 로그인(rate limit), **신규 가입 → 승인 대기**, **ID 찾기**(email+이름 → 마스킹 ID), **PWD 찾기**(ID+email → 임시 비밀번호, 변경 강제), 비밀번호 변경, **담당자 확인**(안내문 + admin 이름), PG 세션(유휴·절대 타임아웃), CSRF 헤더, 보안 헤더 | `apps/api/src/auth` |
| 사용자 관리 | 목록(ID·이름·역할·email·생성일자·상태), 직접 생성, **승인**, **잠금 해제**, **비밀번호 초기화(임시 비밀번호 1회 표시)**, 역할 변경(root만 root 부여) | `apps/api/src/users` |
| 스페이스 | **개인/팀**, **카테고리**(사용자가 생성), 자동 식별자, **상태 활성/중지**(중지 = 읽기 전용), **삭제 규칙**(생성자는 Crew 혼자일 때, admin은 중지 상태일 때), **Crew**(owner·editor·viewer 추가·역할 변경·제외), 승인 시 개인 스페이스 자동 생성 | `apps/api/src/spaces` |
| 페이지 | 트리, append-only 버전·409 충돌, 복원, 이동(순환·깊이 검사), soft delete. 읽기·쓰기는 스페이스 접근 판정을 따른다 | `apps/api/src/pages` |
| 검색 | ILIKE + pg_trgm, **내가 볼 수 있는 스페이스로 제한** | `apps/api/src/search` |
| 감사·설정·시스템 | append-only 감사로그(트리거), 담당자 안내문 설정, root 시스템 정보 | `audit`, `settings`, `system` |
| 웹 | 첫 페이지(로그인 + 신규 가입·ID 찾기·PWD 찾기·담당자 확인), **눈 아이콘 비밀번호 입력**, 스페이스 목록 **개인↔팀 토글**, 새 스페이스(종류·분류 드롭다운 + "+ 새 카테고리 만들기"·스페이스 명), 스페이스 화면(**Crew 버튼**·중지/재개·삭제), TipTap 편집기, 이력, 검색, **관리 대시보드(5건씩 3구역)** → 사용자·스페이스(행 선택 → 상세+사용자 목록+상태 변경하기)·감사로그 페이지, root 시스템 페이지 | `apps/web/src` |
| DB | Drizzle 스키마 + 마이그레이션 4개(`0000_init`, `0001_search_trgm`, `0002_v2_accounts_spaces`, `0003_v2_backfill`), 멱등 시드 | `apps/api/src/db`, `apps/api/drizzle` |
| 개발 DB | 임베디드 PostgreSQL 17.10을 `.local/pgdata`에서 기동 (`pnpm dev:db`) | `scripts/dev-db.ts` |
| E2E | Playwright(Chromium, `.local/ms-playwright`) 9 시나리오 | `e2e/` |
| 배포(미검증) | 멀티스테이지 Dockerfile, compose(postgres·api·nginx), nginx.conf | `deploy/` |

들어 있지 않은 것: OIDC(Phase 1), 첨부·댓글·라벨(Phase 3), 페이지 단위 권한·휴지통 UI·템플릿·알림(Phase 4), lint·`verify:docs`·CI·gitleaks(Phase 0 정식), 실시간 동시 편집(Phase 6). root 화면은 최소 구성(시스템 정보·안내문 편집)이다.

## 2. 실행 방법 (Windows 개발 PC)

명령은 전부 `pnpm` 스크립트다 (`CLAUDE.md` 4.1절). 데이터는 전부 `.local/` 아래(D 드라이브)에 생긴다.

```bash
pnpm install                    # store·cache는 .local/ (pnpm-workspace.yaml)
cp .env.example .env            # WF_SESSION_SECRET(32자 이상), WF_ROOT_INITIAL_PASSWORD(8자·2종) 채우기. WF_SERVE_WEB=true 권장
pnpm dev:db                     # 터미널 1: 임베디드 PostgreSQL (첫 실행 시 initdb + DB 2개 생성)
pnpm db:migrate                 # 터미널 2
pnpm db:seed                    # root + (development) admin1·member1·pending1, 카테고리 3개, DEMO 팀 스페이스, 개인 스페이스
pnpm check:env                  # READY 확인
pnpm build && pnpm start        # http://127.0.0.1:3000
```

개발 모드(핫 리로드): `pnpm dev` → web `http://127.0.0.1:5173` (`/api`는 3000으로 프록시).

**시드 계정** (전부 합성. 비밀번호는 `.env`의 `WF_ROOT_INITIAL_PASSWORD`와 같다)

| ID | 역할 | 상태 | 용도 |
|---|---|---|---|
| `root` (`WF_ROOT_USERNAME`) | root | 활성 | 시스템 관리자. `시스템` 메뉴 |
| `admin1` | admin | 활성 | 사용자·스페이스 관리. `관리` 메뉴 |
| `member1` | member | 활성 | 일반 사용자. DEMO 팀 스페이스 편집(editor), 개인 스페이스 1개 |
| `pending1` | member | 승인 대기 | 승인 흐름 확인용. 로그인하면 "승인 대기" 안내 |

테스트: `pnpm test` (A·B), `pnpm test:cov`, `pnpm test:e2e` (통합 모드 api가 떠 있어야 함), `pnpm typecheck`.

## 3. 검증 결과 (2026-09-15, 이 PC)

| 항목 | 결과 |
|---|---|
| `packages/shared` 테스트 | 5 파일 49건 통과. 커버리지 라인 99% / 브랜치 98% / 함수 100% (A등급 관문 90% 통과). 권한 판정·삭제 규칙·비밀번호 정책·마스킹·임시 비밀번호 생성 포함 |
| E2E (Chromium) 9/9 | ① 첫 페이지 5요소 + 담당자 확인 ② 눈 아이콘 토글(password↔text) ③ 승인 대기 계정 로그인 차단 ④ root: 개인→팀 토글·DEMO·Crew 패널(생성자/편집)·편집 저장 v+1·검색 ⑤ 새 카테고리 → 팀 스페이스 생성 → 분류 배지 ⑥ 가입 요청 → 로그인 차단 → admin1 승인 → 로그인 → 개인 스페이스 자동 생성·관리 메뉴 없음 ⑦ PWD 찾기 → 임시 비밀번호 → 변경 강제 → 새 비밀번호 ⑧ admin1 대시보드 3구역(5건) → 스페이스 행 선택 → 상세·사용자 목록 → 상태 변경하기 중지↔활성 ⑨ member는 /admin 접근 시 홈으로 |
| v1 API 시나리오 (curl 21단계) | 401 미인증, 403 CSRF 누락, 401 비밀번호 오류(사유 비노출), stale 저장 409, iframe 노드 400, 복원, 약한 비밀번호 400, 역할별 403, 로그아웃 후 401 — v2에서도 유지 |
| 한글 (Node fetch, v1) | 제목·본문 왕복, 2글자 질의 "배포"·"결재" 적중, `javascript:` 링크 400 |
| SPA 서빙 | `/`·딥링크 200 + `no-store`, `assets/*-<hash>.*` → `immutable`, `/api/*` → `no-store` |
| 빌드 | api tsc 통과, web Vite 8 빌드 836KB(gzip 258KB) |
| DB | PostgreSQL 17.10 임베디드, 마이그레이션 4개 적용. v1 `admin` → `root` 이행, 기존 스페이스 → 카테고리 '일반'·owner Crew 백필 |

curl로 한글을 보내면 Windows 콘솔 인코딩 때문에 `??`로 저장됐다. 앱 문제가 아니라 셸 문제이며, 한글 검증은 Node 스크립트와 Playwright로 했다.

## 4. 실측으로 알게 된 것 (Phase 0에 가져갈 교훈)

| # | 실측 | 반영 |
|---|---|---|
| 1 | pnpm 12는 `.npmrc`의 `store-dir`를 무시한다. `pnpm-workspace.yaml`의 `storeDir`만 먹는다. `stateDir`은 프로젝트 단위 설정 불가 | `CLAUDE.md` 8.1절 |
| 2 | pnpm 12는 설치 스크립트 허용을 `allowBuilds:` 맵으로 받는다 | `pnpm-workspace.yaml` |
| 3 | zod 4: `.default()`는 출력 타입 값을 받고 파싱을 건너뛴다. `.partial()`은 default를 유지한다. `z.email()`은 검증만 하므로 trim·소문자는 `.pipe()` 앞에서. TLD 1자 email은 거부된다 | `env.ts`, `schemas.ts` |
| 4 | NestJS 가드의 의존성은 가드를 쓰는 **컨트롤러의 모듈**에서 해석된다 → `UsersModule`·`AuditModule`·`SettingsModule`을 `@Global()` | 각 module.ts |
| 5 | CJS 순환 import(`pages.service` ↔ `spaces.module`)는 타입체크를 통과하지만 런타임에 클래스가 `undefined`가 되어 DI가 실패한다. 공용 변환 함수는 별도 파일로 | `pages/page-view.ts` |
| 6 | TypeScript 7이 latest지만 데코레이터 메타데이터 호환 위험이 있어 5.9로 고정 | 루트 `package.json` |
| 7 | PostgreSQL 서버는 관리자 권한 셸에서 기동을 거부한다. 이 PC의 작업 셸은 비상승이라 임베디드 PG가 뜬다 | `CLAUDE.md` 8.1절 |
| 8 | jsonb는 키 순서를 정규화한다. 동등성 비교는 deep-equal로 | 테스트 작성 시 |
| 9 | Vite 해시 파일명은 `name-<base64url 8자>.ext`. 16진수 정규식으로는 못 잡는다 | `app.module.ts` |
| 10 | 접근성 로케이터는 화면 문구가 겹치면 여러 개에 걸린다("관리"가 "관리자 하나의 개인 스페이스"에도). E2E는 `exact: true`나 영역 한정 | `e2e/` |
| 11 | 시드가 "있으면 건너뜀"이면 스키마가 늘어난 뒤(email 추가) 기존 행이 비어 있다. 멱등 시드는 **빠진 필드를 채우는 것**까지 포함해야 한다 | `seed.ts` |

## 5. 규칙서(`CLAUDE.md`) 대비 편차 — 탐색 브랜치라 허용, 정식 Phase에서 해소

| 편차 | 이유 | 해소 Phase |
|---|---|---|
| 요구사항정의서·설계서·테스트결과서 4단계를 생략하고 이 문서 + `docs/prompts/prototype-v*.md`로 기록 | 프로토타입은 "이어지는가"와 "화면 흐름이 맞는가"를 보는 것이 목적 | Phase 0~1에서 정식 문서로 재작성 |
| api B등급 통합 테스트 없음 (E2E와 수동 시나리오) | 검증 가치가 E2E에 있었다 | Phase 0~1 |
| lint·`verify:docs`·CI·gitleaks 없음 | | Phase 0 |
| Docker 파일 미검증 | 이 PC에 Docker 없음 | Linux 서버 첫 빌드 |
| 운영 조절값이 상수·`.env`에만 (담당자 안내문만 DB settings) | | Phase 4 |
| 요청 제한이 프로세스 메모리 | 단일 인스턴스 | 이중화(보류 6) 시 |
| E2E가 시드 계정 비밀번호를 바꾼다(member1 복구 흐름). 마지막 테스트가 원래 값으로 되돌린다 | 실제 복구 흐름을 그대로 검증 | Phase 1에서 전용 테스트 계정 |

## 6. 다음 단계 제안

1. 사용자가 직접 실행해 v2 화면 흐름(가입·승인·복구·개인/팀·Crew·관리 3페이지)을 검토하고, `docs/prompts/prototype-v2.md` 2절의 가정 16개 중 바꿀 것을 정한다.
2. `impl-phase0`에서 정식 Phase 0: `packages/shared`·`apps/api/src/{config,db,common}`·`scripts/`·`deploy/`는 승격 후보. 요구사항정의서·설계서·테스트결과서를 붙이고 lint·verify:docs·CI·gitleaks를 추가한다.
3. Linux 서버에서 `docker build -f deploy/Dockerfile` 실측 → 이미지 크기·`df -h` 기록 (Phase 0 완료 기준).
4. Phase 1에서 OIDC를 붙일 때 `AuthGuard`·세션·역할 구조는 그대로 쓰고 로그인 진입점만 추가한다. root 화면의 시스템 항목을 설계한다.
