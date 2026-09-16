# P0_설계서_Foundation — Phase 0 공통 기반 설계

- 상위 문서: [`docs/P0_요구사항정의서_Foundation.md`](P0_요구사항정의서_Foundation.md) (FR 번호 대응), [`docs/설계서_Architecture.md`](설계서_Architecture.md)
- 규칙: [`CLAUDE.md`](../CLAUDE.md) 4절 2단계 산출물. 다음 산출물은 코드 + 테스트
- 작성일: 2026-09-16 / 작성 LLM: Claude Opus 5

## 0. 모듈 구성과 등급

```
packages/shared/src/
├── env.ts            [A] WF_* 스키마·파싱                     ← zod만 import
├── constants.ts      [A] 설계 고정값                          ← 없음
├── security.ts       [A] 마스킹·임시 비밀번호·식별자 생성      ← constants, permissions
├── permissions.ts    [A] 권한 판정·비밀번호 정책 판정          ← constants
├── document.ts       [A] 문서 JSON 검증·텍스트 추출            ← 없음
└── schemas.ts        [A] API DTO·응답 뷰 타입                 ← constants, document, permissions

apps/api/src/
├── config/config.module.ts   [B] .env 로딩 → APP_ENV 제공
├── db/db.module.ts           [B] 풀·Drizzle 인스턴스
├── db/schema.ts              [B] 테이블 정의 (P0: settings)
├── db/migrate.ts             [B] 마이그레이션 실행 (CLI 겸용)
├── db/seed.ts                [B] 멱등 시드 (P0: 틀만)
├── common/zod.pipe.ts        [B] 요청 검증
├── common/logger.ts          [B] pino JSON stdout
├── common/rate-limit.guard.ts[B] IP별 요청 제한
├── health/health.controller.ts [B] /api/health
├── app.module.ts             [B] 모듈 조립 + SPA 정적 서빙
└── main.ts                   [B] 부트스트랩·보안 헤더

apps/web/src/                 [B] SPA 셸 (기동 확인 화면)
scripts/                      [—] check-env · dev-db · verify-docs · e2e
e2e/                          [C] 기동 확인 시나리오
```

등급은 `CLAUDE.md` 3절. A는 테스트 먼저, ≥90%. `[—]`는 개발 보조 스크립트로 커버리지 측정 대상이 아니며 **실행 자체가 검증**이다.

### 0.1 의존 방향 규칙

- `shared`는 zod 외에 아무것도 import하지 않는다. Node 전용 API(`fs`·`crypto`)를 쓰지 않는다 — 브라우저 번들에 들어간다.
  - 예외: `env.spec.ts`는 `.env.example`을 읽으므로 `node:fs`를 쓴다. **테스트 파일은 번들되지 않는다.**
- api 기능 모듈끼리 순환 import를 만들지 않는다. 두 모듈이 함께 쓰는 변환 함수는 제3의 파일로 뺀다 (`설계서_Architecture.md` 2.1절).

## 1. 환경 설정 (FR-010 ~ FR-017)

### 1.1 설정 항목 표 — Phase 0 전량

**이 표에 없는 `WF_*`는 코드에 존재할 수 없다** (NFR-10). Phase 1 이후 키가 늘면 그 Phase 설계서에 표를 추가한다.

| 키 | 타입 | 기본값 | 용도 |
|---|---|---|---|
| `WF_ENV` | `development`\|`test`\|`production` | `development` | 실행 환경. 운영 제약 판정에 쓴다 |
| `WF_PORT` | 정수 1~65535 | `3000` | HTTP 수신 포트 |
| `WF_LOG_LEVEL` | pino 레벨 | `info` | 로그 수준 |
| `WF_DATABASE_URL` | URL | (필수) | PostgreSQL 연결 문자열 |
| `WF_DATABASE_URL_TEST` | URL | (선택) | 테스트 DB. `WF_ENV=test`에서 사용 |
| `WF_DB_AUTO_MIGRATE` | `true`\|`false` | `false` | 기동 시 마이그레이션 자동 적용. **운영에서 `true`면 기동 실패** |
| `WF_PG_EMBEDDED_DIR` | 경로 | `.local/pgdata` | 개발용 임베디드 PostgreSQL 데이터 |
| `WF_PG_EMBEDDED_PORT` | 정수 1024~65535 | `5433` | 임베디드 PostgreSQL 포트. 기본 설치본(5432)과 겹치지 않게 |
| `WF_PG_EMBEDDED_PASSWORD` | 문자열 | `workfluence` | 개발 전용. 운영 컨테이너에는 넘기지 않는다 |
| `WF_TRUST_PROXY` | `true`\|`false` | `false` | nginx 뒤에서 `X-Forwarded-*` 신뢰 |
| `WF_SERVE_WEB` | `true`\|`false` | `false` | api가 빌드된 SPA를 함께 서빙 |
| `WF_WEB_DIST` | 경로 | `../web/dist` | SPA 산출물 경로 (api 기준 상대) |

**Phase 1에서 추가 예정**: `WF_SESSION_SECRET`, `WF_COOKIE_SECURE`, `WF_SESSION_IDLE_MINUTES`, `WF_SESSION_ABSOLUTE_HOURS`, `WF_ROOT_USERNAME`, `WF_ROOT_INITIAL_PASSWORD`, `WF_ROOT_EMAIL`, `WF_OIDC_*`.

> **왜 Phase 1 키를 미리 넣지 않는가.** 스키마가 strict라 선언만 하고 코드가 읽지 않는 키는 "값을 바꿔도 아무 일이 없는" 상태가 된다. 그것이 바로 strict로 잡으려던 실패 유형이다. 반면 `schemas.ts`의 미사용 DTO는 **자기 테스트로 동작이 검증되는 타입 계약**이라 성격이 다르다.

### 1.2 파싱 설계

```
process.env + .env 파일 ──▶ WF_로 시작하는 키만 추출 ──▶ zod strict 파싱 ──▶ AppEnv
                                                            │
                                                 실패 시 EnvValidationError (기동 중단)
```

- **빈 문자열은 제외**한다(FR-013). `.env`에 `WF_PORT=`처럼 값을 비운 경우 기본값을 쓴다.
- `.strict()`로 미지의 `WF_` 키를 거부한다(FR-011).
- 파싱 후 **교차 검증**: `WF_ENV=production` && `WF_DB_AUTO_MIGRATE=true` → 거부(FR-014).
- `ENV_KEYS`를 export해 `.env.example` 대조 테스트가 쓴다(FR-015).

> **zod 4 주의**: `.default()`는 입력 문자열이 아니라 **출력 타입** 값을 받고, 값이 없으면 파싱을 건너뛴다. 따라서 `intString(min, max, 기본값:number)`처럼 변환 뒤 기본값을 붙인다. `z.email()`은 검증만 하므로 정규화(`trim`·`toLowerCase`)를 앞에 두고 `.pipe()`로 잇는다.

### 1.3 로딩 위치

`ConfigModule`이 저장소 루트의 `.env`를 찾아 읽고 `process.env`를 덮어쓴다(`process.env` 우선, FR-017). 컨테이너는 compose가 환경변수를 주입한다.

`app.module.ts`는 SPA 서빙 여부를 모듈 구성 시점에 알아야 해서 같은 로더를 한 번 더 호출한다. 두 번 읽어도 결과가 같다(순수 함수).

## 2. 공유 계약 (FR-020 ~ FR-027)

### 2.1 `constants.ts`

값 배치 기준은 `CLAUDE.md` 5절이다. 여기 두는 것은 **바꾸면 데이터·마이그레이션을 다시 만들어야 하는 값**이다.

| 상수 | 내용 | 왜 여기인가 |
|---|---|---|
| `ROLES` | `root`·`admin`·`member` | DB `role` 컬럼 값. 바꾸면 데이터 이행 필요 |
| `USER_STATUSES` | `pending`·`active` | 같음. `잠김`은 저장하지 않고 파생 |
| `SPACE_KINDS` / `SPACE_STATUSES` | `personal`·`team` / `active`·`suspended` | 같음 |
| `SPACE_MEMBER_ROLES` | `owner`·`editor`·`viewer` | 같음 |
| `AUDIT_ACTIONS` | 감사 이벤트 종류 | 기록된 값이라 이름을 바꾸면 과거 로그와 어긋난다 |
| `DOCUMENT_SCHEMA_VERSION` | 문서 스키마 버전 | 저장된 문서에 박힌다 |
| `PAGE_TREE_MAX_DEPTH` | 트리 최대 깊이 | 경로 계산 비용 상한 |
| `CSRF_HEADER` / `_VALUE` | 상태 변경 요청에 요구하는 헤더 | 서버·클라이언트가 같아야 한다 |
| `PASSWORD_POLICY` | 8자·2종·5회·15분 | **기본값**. 운영 조절은 Phase 4에서 `settings`로 |
| `RATE_LIMITS` | 엔드포인트별 제한 | 기본값 |
| `TEMP_PASSWORD_LENGTH` | 12 | 기본값 |

### 2.2 `document.ts` (FR-021, FR-022)

- **허용 목록 방식**: `ALLOWED_NODES`(노드 → 허용 속성 키), `ALLOWED_MARKS`. 목록 밖이면 거부. 차단 목록 방식은 새 위험이 생길 때마다 뚫린다.
- 속성 값은 원시값 또는 원시값 배열만 허용한다. 중첩 객체를 허용하면 검증 표면이 무한해진다.
- 링크는 `ALLOWED_LINK_HREF = /^(https?:\/\/|\/(?!\/)|#)/i`. `//evil.example`(프로토콜 상대)을 막기 위해 `/` 뒤에 `/`가 오는 것을 제외한다.
- 상한: 노드 50,000개·깊이 64. 오류는 20건에서 멈춘다 — 전부 모으면 응답이 비대해진다.
- `extractText()`는 블록 경계에 줄바꿈을 넣고 인라인은 이어 붙인다. 연속 3줄 이상 줄바꿈은 2줄로 줄인다.

### 2.3 `permissions.ts` (FR-023, FR-024)

```
can(principal, action)                                   → boolean   시스템 행위
spaceAccess(principal, space, membership, memberCount)   → SpaceAccess
canAssignRole(actor, role) / canManageUser(actor, target) → boolean   역할 간 우열
checkPasswordPolicy(password, policy)                    → string[]  위반 사유 목록
```

- `GRANTS`는 역할 → 허용 행위 집합. **없는 조합은 전부 거부**. 알 수 없는 역할도 거부한다.
- `spaceAccess`는 **읽기·쓰기·구성원 관리·상태 변경·삭제**를 한 번에 판정해 돌려준다. 호출부가 개별 규칙을 다시 조합하지 않게 한다.
- 삭제 규칙: 생성자는 `memberCount < 2`일 때만, 관리자는 `status !== 'active'`일 때만. 중지가 예고 단계 역할을 한다.
- 중지 상태는 **누구도 쓰기 불가**. 관리자도 예외가 아니다 — "얼렸다"가 관리자에게만 녹으면 상태의 의미가 흐려진다.

### 2.4 `security.ts` (FR-025, FR-026)

- 난수 소스를 `RandomInt = (maxExclusive: number) => number`로 주입받는다. 서버는 `node:crypto.randomInt`, 테스트는 결정적 수열.
- 임시 비밀번호: 4종(소문자·대문자·숫자·특수)을 각 1자 이상 보장한 뒤 Fisher–Yates로 섞는다. 섞지 않으면 앞 4자리 종류 순서가 항상 같아 예측 가능해진다. 생성 후 정책을 다시 검사해 **계약 위반이면 예외**를 던진다.
- 혼동 문자(`0 O 1 l I i o`)를 제외한다. 화면에서 읽어 옮겨 적는 값이다.
- `maskUsername`: 앞 2자 + (길이 5 이상이면) 뒤 1자만 남긴다.

### 2.5 `schemas.ts` (FR-027)

- 요청 DTO는 zod, 응답은 타입만. 응답을 런타임 검증하지 않는 이유는 서버가 만든 값이고 검증 비용이 이득보다 크기 때문이다.
- `documentSchema`는 `z.unknown().superRefine(...)`로 `document.ts` 검증기를 감싼다. `z.custom`은 오류 메시지 조립이 어렵다.
- DTO에 기본값이 필요하면 `.default()`를, 부분 수정 DTO는 `.partial()` 대신 **명시적으로 optional 필드를 나열**한다. zod 4의 `.partial()`은 default를 유지해 "보내지 않은 필드가 빈 값으로 덮이는" 사고를 낸다.

## 3. DB (FR-030 ~ FR-034)

### 3.1 연결

`PG_POOL`(pg `Pool`) → `DB`(Drizzle 인스턴스) 두 토큰을 제공한다. 세션 저장소(Phase 1)가 같은 풀을 써야 해서 풀을 따로 노출한다. `OnModuleDestroy`에서 풀을 닫는다.

연결 문자열은 `WF_ENV=test`면 `WF_DATABASE_URL_TEST`, 아니면 `WF_DATABASE_URL`.

### 3.2 스키마 — Phase 0

| 테이블 | 컬럼 | 비고 |
|---|---|---|
| `settings` | `key` text PK, `value` jsonb NOT NULL, `updated_by` uuid, `updated_at` timestamptz | 운영 조절값. `updated_by`는 Phase 1에서 `users`를 참조하도록 제약을 추가한다 |

나머지 테이블은 `설계서_Architecture.md` 3.1절에 그려 두고 각 Phase에서 만든다.

> `updated_by`에 지금 FK를 걸지 않는 이유: `users` 테이블이 Phase 1에 생긴다. 참조 무결성은 Phase 1 마이그레이션에서 `ALTER TABLE ... ADD CONSTRAINT`로 추가한다.

### 3.3 마이그레이션

- `apps/api/drizzle/`에 SQL 파일과 메타데이터를 커밋한다.
- `migrate.ts`는 **모듈로도 CLI로도** 동작한다. 기동 시 자동 적용(개발)과 배포 절차의 명시적 단계(운영)가 같은 코드를 쓴다.
- 파일명은 Drizzle 생성 규칙(`NNNN_<name>.sql`)을 따르고, 손으로 쓰는 SQL은 `--custom`으로 빈 파일을 만들어 채운다. 문장 구분은 `--> statement-breakpoint`.

### 3.4 시드

Phase 0은 만들 것이 없다. **틀만** 둔다: 로더 → 연결 → (비어 있음) → 종료. Phase 1이 root 계정과 기본 카테고리를 넣는다.

멱등 규칙: "있으면 건너뜀"으로 끝내지 않고 **빠진 필드를 채우는 것**까지 포함한다. 스키마가 늘어난 뒤 기존 행이 비어 있는 상태를 시드가 고쳐야 한다.

## 4. 헬스체크 (FR-040, FR-041)

```
GET /api/health
  → select 1 성공: 200 {"status":"ok","db":"ok","time":"..."}
  → 실패:          503 {"status":"degraded","db":"unreachable"}
```

DB까지 확인하는 이유: 앱 프로세스는 살아 있는데 DB를 못 쓰는 상태가 가장 흔한 장애다. 이때 200을 주면 로드밸런서·compose가 "정상"으로 보고 트래픽을 계속 보낸다.

컨테이너 헬스체크는 이 엔드포인트를 `node -e "fetch(...)"`로 호출한다. `curl`을 이미지에 넣지 않기 위해서다(이미지 크기·공격 표면).

## 5. 로깅 (FR-050 ~ FR-052)

- pino, JSON 한 줄, stdout. `base: { service }`, ISO 시각.
- `redact`: 쿠키·인증 헤더·`password`·`passwordHash`.
- `PinoNestLogger`가 Nest의 `LoggerService`를 구현해 프레임워크 로그도 같은 형식으로 낸다. `NestFactory.create(..., { bufferLogs: true })`로 로거 준비 전 로그를 버퍼링한다.

## 6. 공통 요청 처리 (FR-060 ~ FR-064)

| 항목 | 설계 |
|---|---|
| 검증 | `ZodPipe<T>` — 실패 시 400 + `issues[{path, message}]`. 어느 필드가 왜 틀렸는지 화면이 보여줄 수 있어야 한다 |
| 요청 제한 | `RateLimitGuard` + `@RateLimit({max, windowSec})`. 키는 `컨트롤러.핸들러:IP`. 메모리 맵이며 주기적으로 오래된 항목을 정리한다. 이중화 시 공유 저장소로 옮긴다 |
| 보안 헤더 | 전역 미들웨어. CSP `default-src 'self'`, `img-src 'self' data:`, `style-src 'self' 'unsafe-inline'`(에디터·인라인 스타일), `frame-ancestors 'none'`, `base-uri 'self'`, `form-action 'self'`. `WF_ENV=production`일 때 HSTS |
| 캐시 | `/api/*` → `no-store`. 정적 자산은 해시 파일명(`assets/<name>-<8자 이상>.<ext>`)만 `immutable`. **Vite 해시는 base64url이라 16진수 정규식으로는 못 잡는다** |
| 프록시 | `WF_TRUST_PROXY=true`면 `app.set('trust proxy', 1)` |
| 본문 크기 | JSON 2MB. 첨부는 Phase 3에서 별도 경로 |

> CSRF 헤더 검사와 세션은 **Phase 1**에서 붙인다. 보호할 세션이 없는 상태에서 CSRF 미들웨어만 두면 의미 없는 관문이 된다.

## 7. 웹 셸 (FR-070 ~ FR-072)

- Vite + React. `@workfluence/shared`는 **소스를 직접 별칭**으로 번들한다(api는 빌드된 `dist`를 쓴다). 개발 중 shared를 고치면 바로 반영된다.
- 개발 서버는 `/api`를 api로 프록시한다. 같은 출처처럼 동작해 쿠키·CSRF 흐름이 운영과 같아진다.
- Phase 0 화면: 앱 이름·버전과 `/api/health` 결과(성공/실패)를 보여준다. 실패 시 원인을 그대로 표시한다.
- 스타일은 시스템 폰트, 아이콘은 인라인 SVG. 외부 요청 0.

## 8. 스크립트 (FR-080 ~ FR-084)

| 스크립트 | 설계 |
|---|---|
| `check-env.ts` | 검사 항목을 배열로 모아 전부 출력한 뒤 판정한다. 첫 실패에서 멈추면 사용자가 문제를 한 번에 못 본다. 통과 시 마지막 줄 `READY`, 실패 시 종료 코드 1 |
| `dev-db.ts` | `embedded-postgres`로 `.local/pgdata`에 기동. 최초 실행이면 `initdb` + DB 2개(개발·테스트) 생성. `SIGINT`/`SIGTERM`에서 정상 종료 |
| `verify-docs.ts` | 6종 검사(FR-082). 검사 대상은 `README.md`·`CLAUDE.md`·`PROTOTYPE.md`·`docs/**/*.md`. `history/`는 제외 — 과거 기록을 사후에 고치면 기록 위조다 |
| `e2e.ts` | `PLAYWRIGHT_BROWSERS_PATH`를 저장소 안 경로로 설정해 Playwright를 실행. OS별 환경변수 문법을 문서에서 없앤다 |

`check-env.ts`는 `statfsSync`로 드라이브 여유를 보고 3GB 미만이면 실패로 처리한다. 디스크 부족은 빌드·DB 쓰기를 **옆에서** 깨뜨려 원인 추적이 어렵다.

## 9. 검사와 CI (FR-090 ~ FR-094)

### 9.1 ESLint

flat config. TypeScript 파서 + `import-x` 플러그인.

| 규칙 | 이유 |
|---|---|
| `import-x/no-unresolved` (대소문자 포함) | Linux는 파일명 대소문자를 구분한다. Windows에서만 통과하는 import를 잡는다 |
| `@typescript-eslint/no-unused-vars` | 죽은 코드 |
| `no-restricted-syntax`: `import type`으로 주입 대상 클래스 가져오기 금지 | `import type`은 런타임에 사라져 Nest DI가 `undefined`를 받는다 |

### 9.2 CI (GitHub Actions)

| 단계 | 내용 | 실패 시 |
|---|---|---|
| setup | Node 24 + pnpm, `--frozen-lockfile` | 중단 |
| check | `pnpm check` (lint·typecheck·test·verify:docs) | 중단 |
| audit | `pnpm audit --audit-level high` | 중단 |
| license | 허용 라이선스 목록 검사 | 중단 |
| gitleaks | 시크릿 검사 | 중단 |
| build | `pnpm build` 후 산출물의 외부 URL(`http(s)://` 절대 주소) 참조 검사 | 중단 |

이미지 빌드는 CI에서 하지 않는다. Docker가 필요한 작업은 Linux 서버에서 수동으로 하고, 안정되면 self-hosted runner를 검토한다 (`CLAUDE.md` 보류 5).

## 10. 컨테이너·배포 (FR-100 ~ FR-104)

```
FROM node:24-bookworm-slim AS build   # 의존성 설치 → pnpm build → deploy --prod
FROM node:24-bookworm-slim            # 산출물 + production 의존성만, USER node
```

- 매니페스트만 먼저 복사해 의존성 레이어를 캐시한다.
- `HEALTHCHECK`는 `node -e "fetch('http://127.0.0.1:3000/api/health')..."`.
- compose: `postgres`(healthcheck, 볼륨) → `api`(`depends_on: service_healthy`) → `nginx`(TLS, 포트 매핑). 전부 `restart: unless-stopped`.
- nginx: `absolute_redirect off`(호스트 매핑 포트 유실 방지), `X-Forwarded-*`, WebSocket `Upgrade` 프록시, `client_max_body_size`.
- 개발 전용 키(`WF_PG_EMBEDDED_*`)는 컨테이너에 넘기지 않는다. 스키마가 strict라도 **선언된 키**이므로 넘겨도 기동은 되지만, 쓰이지 않는 값을 운영 환경에 두지 않는다.

## 11. 에이전트·스킬 (FR-110, FR-111)

| 이름 | 형태 | 모델 | 왜 그 형태인가 |
|---|---|---|---|
| `doc-consistency` | 에이전트 | sonnet | 문서 전체를 읽어야 해서 컨텍스트가 무겁고(무거운 읽기), 결과가 "어긋난 곳 목록"이라 닫힌 범위다. **읽기 전용** — 고치는 판단은 메인이 한다. 자주 돌아 비용을 아낄 자리 |
| `self-reviewer` | 에이전트 | fable | 작성자가 자기 실수를 못 보므로 독립된 시각이 결과를 바꾼다. Phase당 1회라 최고 모델을 쓴다 |
| `troubleshoot` | 스킬 | (메인) | **트러블이 터진 순간의 맥락을 아는 것은 메인**이다. 에이전트에 넘기면 기록으로 재구성해야 해서 부정확하다 |

근거·모델 배정·실행 기록은 `docs/internal/설계서_Agents.md`에 남긴다.

## 12. 구현 순서

A등급은 테스트를 먼저 쓴다 (`CLAUDE.md` 3절).

| 순서 | 작업 | 등급 |
|---|---|---|
| 1 | 모노레포 기반 — `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `.gitattributes`, `.gitignore`, `.env.example` | — |
| 2 | `shared`: `constants` → `permissions` → `security` → `document` → `env` → `schemas` (각각 테스트 먼저) | A |
| 3 | `api/config` → `api/db` → `api/common` → `api/health` → `app.module`·`main` | B |
| 4 | 마이그레이션 `0000_foundation` (settings) | B |
| 5 | `apps/web` 셸 | B |
| 6 | `scripts/*` | — |
| 7 | ESLint·`pnpm check`·CI | — |
| 8 | `deploy/*` | — |
| 9 | E2E 기동 확인 | C |
| 10 | 에이전트·스킬 정의 + `설계서_Agents.md` | — |
| 11 | 실측 → `P0_테스트결과서_Foundation.md` | — |

## 13. Phase 1 인계 사항

| 항목 | 내용 |
|---|---|
| 환경변수 | 세션·계정·OIDC 키를 1.1절 표에 추가하고 `.env.example`·compose를 같은 커밋에서 갱신 |
| `settings.updated_by` | `users` 생성 후 FK 제약 추가 |
| 세션 | `connect-pg-simple`이 `PG_POOL`을 재사용. 쿠키는 `HttpOnly; Secure; SameSite=Lax`, 유휴는 `rolling` maxAge, 절대 타임아웃은 가드에서 |
| CSRF | 상태 변경 요청에 `CSRF_HEADER` 요구. 상수는 이미 `shared`에 있다 |
| 시드 | root 계정·기본 카테고리. 개발 환경 전용 계정은 `WF_ENV=development`에서만 |
| 가드 | `AuthGuard`가 `UsersService`를 쓰므로 해당 모듈을 `@Global()`로 둔다 — 가드의 의존성은 **가드를 쓰는 컨트롤러의 모듈**에서 해석된다 |
| E2E | 시나리오는 **자기 계정을 직접 만든다.** 시드 계정 상태를 전제하지 않는다 |
