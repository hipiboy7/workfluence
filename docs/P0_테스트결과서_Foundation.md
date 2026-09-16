# P0_테스트결과서_Foundation — Phase 0 공통 기반 테스트 결과

- 상위 문서: [`docs/P0_요구사항정의서_Foundation.md`](P0_요구사항정의서_Foundation.md), [`docs/P0_설계서_Foundation.md`](P0_설계서_Foundation.md)
- 규칙: [`CLAUDE.md`](../CLAUDE.md) 4절 4단계 산출물 — **등급별 커버리지·실호출·빌드 기록 수치 필수**
- 실행일: 2026-09-16 / 작성 LLM: Claude Opus 5
- 결과: **개발 환경 전 항목 통과. Linux 빌드 검증만 미완** (7절)

## 1. 실행 환경

| 항목 | 값 |
|---|---|
| 개발 PC | Windows Server 2022, D 드라이브 (여유 10.3GB) |
| Node.js | v24.14.0 |
| pnpm | 12.4.1 |
| PostgreSQL | 17.10 (임베디드, `.local/pgdata`) |
| 브라우저 | Chromium (Playwright 1.63, `.local/ms-playwright`) |
| 환경변수 | 12개 키 (`.env`) |

실행 명령:

```bash
pnpm dev:db
pnpm db:migrate
pnpm check:env
pnpm build
pnpm start
pnpm check
pnpm test:cov
pnpm test:e2e
pnpm licenses:check
```

## 2. 테스트 결과 요약

| 구분 | 파일 | 테스트 | 결과 | skip |
|---|---|---|---|---|
| 등급 A — `packages/shared` | 5 | **52** | 전부 통과 | 0 |
| 등급 B — `apps/api` | 4 | **18** | 전부 통과 | 0 |
| 등급 B — `apps/web` | 0 | 0 | — (Phase 0 화면은 E2E로 검증) | 0 |
| 등급 C — E2E | 1 | **4** | 전부 통과 | 0 |
| **합계** | **10** | **74** | **PASS** | **0** |

실패·에러 0건. **skip 0건** — skip은 통과가 아니다 (`CLAUDE.md` 1.3절).

## 3. 등급별 커버리지

### 3.1 등급 A — 목표 ≥ 90% (NFR-01)

```
File            | % Stmts | % Branch | % Funcs | % Lines | Uncovered
----------------|---------|----------|---------|---------|----------
All files       |   98.72 |    98.12 |  100.00 |   99.01 |
 document.ts    |   97.70 |    97.61 |  100.00 |   97.40 | 78-79
 security.ts    |   97.36 |    92.30 |  100.00 |  100.00 | 50
 (constants·env·permissions·schemas) |  100 |  100 |  100 |  100 |
```

→ 목표 90% 대비 **+9%p (라인 99.01%)**. 관문 통과.

미커버 2곳은 방어적 분기다: `document.ts` 78-79는 오류 20건 초과 시 조기 종료, `security.ts` 50은 생성된 임시 비밀번호가 정책을 위반할 경우의 예외(정상 경로에서는 도달 불가).

### 3.2 등급 B — `apps/api` 목표 ≥ 70%

```
File               | % Stmts | % Branch | % Funcs | % Lines | Uncovered
-------------------|---------|----------|---------|---------|----------
All files          |   98.11 |    90.00 |   94.11 |  100.00 |
 common/           |   97.77 |    88.88 |   93.33 |  100.00 |
  rate-limit.guard |   96.42 |    85.71 |   80.00 |  100.00 | 13,29
 health/           |  100.00 |   100.00 |  100.00 |  100.00 |
```

→ 목표 70% 대비 **+30%p (라인 100%)**. 관문 통과.

**측정 대상은 `src/common/**`·`src/health/**`로 한정했다.** 따라서 위 수치는 **api 코드 전체의 커버리지가 아니다.** 제외한 것과 이유:

| 제외 | 이유 | 무엇으로 검증하나 |
|---|---|---|
| `main.ts` | 부트스트랩. 프로세스를 띄워야 의미가 있다 | 실제 기동 + E2E (4절) |
| `app.module.ts` | 모듈 조립·정적 서빙 설정 | E2E 3·4번, SPA 경로 오류 재현 (4.5절) |
| `config/` | `.env`와 파일 시스템에 의존 | `check:env` 실행, 스키마 자체는 A등급 `env.spec.ts` |
| `db/` | 실제 PostgreSQL이 있어야 한다 | 마이그레이션·시드 실행 (4.2절) |

Phase 1에서 **실제 PostgreSQL을 쓰는 통합 테스트**를 도입하면 `db/`와 기능 모듈이 분모에 들어온다. 그때 측정 범위를 넓히고 이 표를 갱신한다.

### 3.3 A+B 가중 평균 — 목표 ≥ 80%

| 구분 | 라인 커버리지 |
|---|---|
| A (`packages/shared`) | 99.01% |
| B (`apps/api` 측정 대상) | 100.00% |
| **가중 평균** | **약 99%** |

→ 목표 80% 대비 큰 폭 초과. 단 3.2절의 측정 범위 한정을 함께 읽어야 한다.

## 4. 실제 동작 검증 (CLAUDE.md 1.3절)

**문서가 아니라 동작으로 확인한다.** 아래는 전부 실행한 결과를 그대로 옮긴 것이다.

### 4.1 환경 확인 — `pnpm check:env`

```
OK   Node 24 — node 24.14.0
OK   pnpm 버전 = packageManager — pnpm 12.4.1, 요구 12.4.1
OK   .env 존재 — D:\claude\workfluence\.env
OK   .env 스키마 (WF_* strict) — 12개 키
OK   .local/ 존재 — D:\claude\workfluence\.local
OK   WF_PG_EMBEDDED_DIR이 .local/ 아래 — D:\claude\workfluence\.local\pgdata
OK   데이터가 시스템 드라이브가 아닌 곳에 있음 — 프로젝트 d: / 시스템 c:
OK   드라이브 여유 ≥ 3GB — 10.3GB 여유 (D:)
OK   PostgreSQL 연결 — PostgreSQL 17.10 on x86_64-windows
OK   마이그레이션 적용 — 적용 1개 / 파일 1개

READY
```

### 4.2 DB 초기화·마이그레이션·시드 — 멱등성 포함

프로토타입 데이터를 지우고 처음부터 만들었다 (프롬프트 5절 쟁점 3 확정 사항).

```
$ rm -rf .local/pgdata && pnpm dev:db
[dev-db] initdb → D:\claude\workfluence\.local\pgdata
[dev-db] 데이터베이스 workfluence: 생성
[dev-db] 데이터베이스 workfluence_test: 생성
[dev-db] READY. Ctrl+C로 종료.
```

**재실행(멱등)**: 같은 명령을 다시 실행하면 만들지 않고 "있음"으로 지나간다.

```
[dev-db] 데이터베이스 workfluence: 있음
[dev-db] 데이터베이스 workfluence_test: 있음
[dev-db] READY. Ctrl+C로 종료.
```

**마이그레이션 2회** — 같은 출력, 중복 적용 없음:

```
$ pnpm db:migrate
[migrate] D:\claude\workfluence\apps\api\drizzle → postgres://***@127.0.0.1:5433/workfluence
[migrate] 1개 마이그레이션 적용 상태
$ pnpm db:migrate
[migrate] D:\claude\workfluence\apps\api\drizzle → postgres://***@127.0.0.1:5433/workfluence
[migrate] 1개 마이그레이션 적용 상태
```

**시드 2회** — 같은 출력:

```
$ pnpm db:seed
[seed] Phase 0 — 시드할 데이터가 없다 (계정·카테고리는 Phase 1)
$ pnpm db:seed
[seed] Phase 0 — 시드할 데이터가 없다 (계정·카테고리는 Phase 1)
```

**테스트 DB 배선 확인** (FR-030). `WF_ENV=test`면 테스트 DB로 붙는다:

```
$ WF_ENV=test pnpm db:migrate
[migrate] D:\claude\workfluence\apps\api\drizzle → postgres://***@127.0.0.1:5433/workfluence_test
[migrate] 1개 마이그레이션 적용 상태
```

두 DB의 테이블을 직접 조회해 확인했다.

```
workfluence      → drizzle.__drizzle_migrations, public.settings
workfluence_test → drizzle.__drizzle_migrations, public.settings
```

`WF_ENV=test`인데 `WF_DATABASE_URL_TEST`가 비어 있으면 **개발 DB로 대체하지 않고 실패한다** (종료 코드 1). 통합 테스트가 개발 데이터를 지우는 사고를 막는다.

### 4.3 헬스체크 실호출 (FR-040)

```
$ curl -i http://127.0.0.1:3000/api/health
HTTP/1.1 200 OK
X-Content-Type-Options: nosniff
Referrer-Policy: same-origin
Content-Security-Policy: default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'
Cache-Control: no-store
Content-Type: application/json; charset=utf-8
Content-Length: 59
ETag: W/"3b-9hd2m53WGE2IfSD4VpYUaC3BrRk"
Date: Wed, 16 Sep 2026 02:31:35 GMT
Connection: keep-alive
Keep-Alive: timeout=5

{"status":"ok","db":"ok","time":"2026-09-16T02:31:35.016Z"}
```

### 4.4 정적 자산 캐시 (FR-063)

```
$ curl -i http://127.0.0.1:3000/assets/index-B3pKotSU.js
HTTP/1.1 200 OK
Cache-Control: public, max-age=31536000, immutable
```

해시 파일명만 `immutable`, 나머지와 `/api/*`는 `no-store`임을 확인했다.

### 4.5 SPA 경로가 틀리면 기동이 멈춘다 (FR-070)

경로를 잘못 두면 화면은 통째로 404인데 `/api/health`는 200이라 **헬스체크가 healthy를 보고한다.** 조용히 잘못되는 유형이라 기동 시점에 실패시킨다.

```
$ WF_WEB_DIST=../../web/dist node dist/main.js
Error: WF_SERVE_WEB=true인데 SPA 산출물이 없다: D:\claude\workfluence\web\dist
  WF_WEB_DIST=../../web/dist (기준 D:\claude\workfluence\apps\api)
  개발이면 'pnpm build'를, 컨테이너면 이미지 레이아웃과 WF_WEB_DIST를 확인한다.
```

### 4.6 브라우저 화면 (FR-071)

`http://127.0.0.1:3000/`에서 기동 확인 화면이 뜨고 API·데이터베이스가 각각 `ok`, 서버 시각이 표시된다. Phase 0의 인수 기준(`scope-definition.md` 5절)을 화면으로 충족한다.

### 4.7 E2E (등급 C) — 4건 통과

| # | 시나리오 | 확인 내용 |
|---|---|---|
| 1 | 헬스체크 | 200, `status`·`db` = ok, 시각 파싱 가능, `Cache-Control: no-store` |
| 2 | 보안 응답 헤더 | `nosniff`, CSP `default-src 'self'`·`frame-ancestors 'none'`, `X-Powered-By` 없음 |
| 3 | SPA 셸 | 제목·기동 확인 영역 표시, 배지 `ok`, 데이터베이스 항목 노출 |
| 4 | 딥링크 폴백 | 임의 경로는 200 text/html, `/api/unknown`은 404 JSON |

### 4.8 설정 항목 추적성 (NFR-10)

코드가 읽는 `WF_*`와 설계서 1.1절 표, `.env.example`을 대조했다.

| 집합 | 키 수 | 결과 |
|---|---|---|
| 환경 스키마 (`packages/shared/src/env.ts`) | 12 | 기준 |
| `.env.example` | 12 | **일치** (테스트가 강제 — FR-015) |
| 설계서 1.1절 표 | 12 | **일치** |

대조 중 발견해 고친 것: `deploy/compose.yml`이 프로토타입 시절의 세션·계정 키(`WF_SESSION_SECRET`·`WF_ROOT_*`·`WF_COOKIE_SECURE`)를 여전히 넘기고 있었다. **strict 스키마라 그대로 두면 운영 컨테이너가 기동에 실패한다.** 제거하고 Phase 1 주석으로 대체했다. Playwright의 `WF_E2E_BASE_URL`은 앱 환경변수가 아니므로 `E2E_BASE_URL`로 바꿨다 — `WF_` 접두사는 앱 환경변수만을 뜻한다.

compose 전용 변수 3개(`WF_PG_PASSWORD`·`WF_APP_IMAGE`·`WF_HTTPS_PORT`)는 앱에 전달되지 않으므로 앱 스키마에 넣지 않고 설계서 1.1절에 따로 표로 두었다.

### 4.9 검사 관문

| 검사 | 결과 |
|---|---|
| `pnpm lint` | 통과 (0건) |
| `pnpm typecheck` | 3개 패키지 통과 |
| `pnpm verify:docs` | **문서 13개 검사**, 위반 0건 |
| `pnpm licenses:check` | production 의존성 **129개**, 허용 라이선스만 사용 (MIT 116 · ISC 7 · Apache-2.0 3 · BSD-3-Clause 2 · 0BSD 1) |

### 4.10 빌드 산출물

빌드 산출물 디렉토리는 커밋하지 않으므로 경로를 코드 표기 없이 적는다 (`pnpm verify:docs`의 경로 검사는 커밋된 파일만 대상으로 한다).

| 산출물 | 크기 |
|---|---|
| web SPA 번들 (apps/web 아래 dist) | 225KB (JS 221KB / gzip 69KB, CSS 1.2KB) |
| api 컴파일 결과 (apps/api 아래 dist) | 117KB |

### 4.11 CI 실제 실행 (2026-09-16)

워크플로를 작성만 하고 "돌 것이다"라고 적지 않는다. `impl-phase0`에 push해 실제로 돌린 결과다.

| 작업 | 단계 | 결과 |
|---|---|---|
| `check` | 의존성 설치(lockfile 고정) · lint · typecheck · 단위·통합 테스트 · 문서 검사 · 취약점 점검 · 라이선스 검사 · 빌드 · 빌드 산출물의 외부 URL 참조 검사 | 9단계 전부 success |
| `gitleaks` | 전체 이력 스캔 | success |

- 대상 커밋: `271653b` (2026-09-16). 실행 번호 35049151021.
- **세 번 실패한 뒤의 성공이다.** 실패 원인은 순서대로 ① `shared`의 빌드 산출물이 개발 PC에만 있던 것(6.4절), ② `verify:docs`가 한글 파일명을 건너뛴 것(6.5절), ③ 문서의 경로 검사가 디스크 상태를 물은 것(6.8절). 셋 다 **개발 PC에는 있고 갓 클론한 곳에는 없는 것**이 원인이다.
- CI 단계를 쪼갠 덕에 세 번째 실패는 어느 관문인지 즉시 보였다. 한 덩어리였다면 로그를 뒤져야 했다.


## 5. 요구사항 대응

| FR/NFR | 검증 방법 | 결과 |
|---|---|---|
| FR-001~004 | 기반 파일 존재, `pnpm install` 성공, `pnpm store path`가 `.local/` | PASS |
| FR-010~014 | `env.spec.ts` — 미지 키·타입·범위·빈 문자열·운영 자동 마이그레이션 거부 | PASS |
| FR-015 | `.env.example` ↔ 스키마 키 집합 테스트 | PASS |
| FR-016 | `.env.example`에 placeholder만, 실제 값 없음 | PASS |
| FR-017 | `loadEnv`가 파일+`process.env` 병합, `process.env` 우선 | PASS |
| FR-020~027 | `constants`·`document`·`permissions`·`security`·`schemas` 테스트 49건 | PASS |
| FR-030~032 | 마이그레이션 실행·재실행 2회 동일 출력, 테스트 DB 분기 확인 (4.2절) | PASS |
| FR-033 | `settings` 테이블 생성 확인 | PASS |
| FR-034 | 시드 2회 실행 결과 동일 (4.2절) | PASS |
| FR-040, 041 | `health.controller.spec.ts` + 실호출 | PASS |
| FR-050~052 | `logger.spec.ts` — JSON 한 줄·redact·레벨·Nest 위임 | PASS |
| FR-060 | `zod.pipe.spec.ts` — 400 + 위반 목록·중첩 경로 | PASS |
| FR-061 | `rate-limit.guard.spec.ts` — 상한·IP/핸들러 분리·창 만료 | PASS |
| FR-062~064 | 실호출 헤더 확인 (4.3절) | PASS |
| FR-070 | SPA 경로 오류 시 기동 중단 확인 (4.5절) | PASS |
| FR-070~072 | E2E 3·4번, 빌드 산출물에 외부 URL 없음 | PASS |
| FR-080~084 | `check:env` READY, `dev:db` 초기화, `verify:docs` 0건, `test:e2e` 4건, `check` | PASS |
| FR-090 | ESLint 대소문자 검사 규칙 적용, lint 통과 | PASS |
| FR-091~094 | GitHub Actions 실제 실행 — 12단계 + gitleaks 전부 success (4.11절) | PASS |
| FR-100~104 | Dockerfile·compose·nginx 작성 | **미검증** (7절) |
| FR-110, 111 | 에이전트 2 + 스킬 1 + `설계서_Agents.md` | PASS |
| NFR-01, 02 | 3절 커버리지, skip 0 | PASS |
| NFR-03, 04 | 이미지 크기·기동 시간 | **미측정** (7절) |
| NFR-05 | CI의 외부 URL 검사 단계 통과 (4.11절) | PASS |
| NFR-06 | Windows에서 전 명령 동작 확인. Linux는 7절 | 부분 |
| NFR-07 | CI의 의존성 설치 단계가 lockfile 고정으로 통과 (4.11절) | PASS |
| NFR-08 | `verify:docs` 0건 | PASS |
| NFR-09 | `.env` 미커밋 확인 + CI gitleaks 작업 success (4.11절) | PASS |
| NFR-10 | 4.8절 대조 | PASS |

## 6. 재작업·특이사항

### 6.1 `verify:docs`가 첫 실행에서 14건을 잡았다

만들자마자 자기 저장소에서 위반을 찾아냈다. 내역: 존재하지 않는 파일 참조 5건(Phase 5 산출물인 배포가이드·운영이관 가이드 등), 자리표시자 `pnpm <script>`를 명령으로 오인 4건, 아직 없는 Phase 3 스크립트 1건, 범위 표기(`prototype-v1~v3.md`) 1건, 이번 Phase에서 만들 문서 3건.

조치: 검사기는 자리표시자(`<`·`>`·`{`·`}` 포함)를 명령으로 보지 않도록 고쳤고, **문서 쪽은 "아직 없는 산출물은 백틱 경로로 쓰지 않는다"** 는 규칙으로 표기를 바꿨다. 검사를 느슨하게 하는 대신 문서 표기를 정돈한 것이다 — 무시되는 관문은 없는 것보다 나쁘다.

### 6.2 pino 출력은 `process.stdout.write` 감시로 잡히지 않는다

로그 redact 테스트가 빈 문자열을 받았다. pino는 파일 디스크립터에 직접 쓴다. `createLogger(level, destination?)`로 출력 대상을 주입받게 바꿔 테스트가 실제 출력을 확인하도록 했다. 난수 소스를 주입받는 `security.ts`와 같은 방식이다.

### 6.3 `unrs-resolver` 설치 스크립트 차단

`eslint-import-resolver-typescript`의 네이티브 리졸버가 pnpm의 설치 스크립트 차단에 걸려 `pnpm install`이 실패했다. `allowBuilds`에 명시적으로 추가했다. 전체 허용으로 우회하지 않았다 — 차단은 공급망 공격 완화가 목적이다.

### 6.4 CI가 첫 실행에서 "로컬에만 있는 전제"를 잡았다

개발 PC에서 `pnpm check`가 통과했는데 같은 커밋의 CI가 실패했다. `apps/api`가 `@workfluence/shared`의 **빌드된 `dist`**를 참조하는데, 개발 PC에는 이전 작업의 산출물이 남아 있었고 갓 클론한 CI에는 없었다.

`build:shared` 스크립트를 두고 `typecheck`·`test`·`test:cov`가 먼저 실행하도록 고쳤다. **각 명령이 자기 전제를 스스로 만든다.** 확인은 `rm -rf packages/shared/dist && pnpm check`로 갓 클론 상태를 재현해서 했다. 상세는 `docs/internal/검토서_트러블슈팅.md` T-007.

이것이 CI를 Phase 0에 넣은 이유다. 개발 PC는 항상 이전 작업의 잔재를 갖고 있어서, 문서에 적은 절차를 처음부터 밟아 본 적 없는 상태로 "된다"고 믿게 된다.

### 6.5 `verify:docs`가 자기 자신을 통과시키고 있었다

`verify:docs — 문서 12개, 위반 없음`이라고 출력했지만 **실제로 검사한 문서는 5개**였다. `git ls-files`가 한글 파일명을 8진 이스케이프로 내놓아 파일을 열지 못했고, 코드가 그것을 조용히 건너뛰었다. 출력의 숫자는 검사한 수가 아니라 목록의 길이였다.

읽지 못한 문서를 **위반으로 보고**하도록 고치고, 파일명 인코딩을 끄고 읽게 했다. 그러자 한글 문서에서 위반 3건이 새로 드러났다(존재하지 않는 경로 참조 2건, 표 열 수 불일치 1건). 부수로 인라인 코드 안의 파이프를 표 구분자로 오인하던 것과 pnpm 내장 명령 오탐도 고쳤다. 상세는 `docs/internal/검토서_트러블슈팅.md` T-008.

**관문이 조용히 통과하면 없는 것보다 나쁘다.** "위반 없음"을 믿고 문서를 고치지 않게 되기 때문이다.

### 6.6 독립 검토가 운영 이미지의 화면 장애를 잡았다

`self-reviewer` 정의를 따르는 에이전트가 별도 컨텍스트에서 검토해 **결함 25건**을 보고했다. 그중 하나는 Linux 빌드에 가서야 드러났을 것이고, 그것도 오진하기 쉬운 형태였다.

`deploy/Dockerfile`과 `deploy/compose.yml`이 `WF_WEB_DIST=../../web/dist`를 넘겼다. 컨테이너 레이아웃에서 이 값은 `/web/dist`로 풀린다(정답은 `/app/web/dist`). **화면은 통째로 404인데 `/api/health`는 200이라 컨테이너 헬스체크가 healthy를 보고한다.** 로그에도 아무것도 남지 않는다.

값을 고치는 데 그치지 않고 **기동 시점에 실패**하도록 했다. `WF_SERVE_WEB=true`인데 산출물 디렉토리가 없으면 경로를 찍고 멈춘다 (4.5절). 조용한 실패를 시끄러운 실패로 바꾼 것이다.

같은 검토에서 CI의 외부 URL 검사가 **항상 실패할 상태**임도 드러났다. React 19 프로덕션 번들이 오류 안내 문구로 `https://react.dev/errors/`를 담는데 제외 목록에 없었다. 네트워크 요청이 아니므로 제외하되, 제외 목록에 **왜 요청이 아닌지**를 항목마다 적었다. 이유 없이 넓히면 관문이 무의미해진다.

전체 25건의 처리 내역은 `docs/internal/P0_검토서_SelfReview.md` 5절.

### 6.7 `apps/web` 커버리지 관문 없음

`CLAUDE.md` 3절대로 web에는 관문을 두지 않았다. Phase 0의 화면은 단일 컴포넌트라 E2E가 더 정확한 검증이다. 상태·분기가 늘어나는 Phase 1부터 컴포넌트 테스트를 붙인다.

### 6.8 문서의 경로 검사가 "환경의 상태"를 묻고 있었다

세 번째 CI 실패는 문서 검사 단계에서 났다. 같은 명령이 개발 PC에서는 "위반 없음"이었다. 이 4.10절이 빌드 산출물 디렉토리를 백틱 경로로 적었고, 검사기는 그 경로가 **디스크에 있는가**를 물었다. 빌드해 둔 개발 PC에는 있고 갓 클론한 CI에는 없다.

앞서 같은 원인을 런타임 데이터 디렉토리에서 한 번 겪고 **접두 목록에서 빼는 식으로** 넘겼던 것이 화근이다. 예외는 증상만 지우고 원인을 남겨 다음 실패를 예약한다. 그래서 이번에는 기준 자체를 바꿨다 — 경로가 `git ls-files` 결과(상위 디렉토리 포함)에 있는지 본다. 커밋된 것만 통과하므로 어느 환경에서 돌려도 결과가 같고, 덤으로 **대소문자까지 대조**해 Windows에서 통과하고 Linux에서 깨지는 오타를 잡는다. 기록은 `docs/internal/검토서_트러블슈팅.md` T-010.

## 7. 미완 항목 — Linux 빌드 검증

**Phase 0은 아직 닫히지 않았다.** 완료 기준의 마지막 항목이 남아 있다.

| 항목 | 상태 | 수행 주체 |
|---|---|---|
| Linux 서버에서 `git pull` → 이미지 빌드 | 미수행 | 사용자 (프롬프트 5절 쟁점 1 확정) |
| `docker compose up -d` → `/api/health` 200 | 미수행 | 사용자 |
| 이미지 크기 실측 (목표 ≤400MB) | 미측정 | 사용자 |
| 기동 시간 (목표 ≤30초) | 미측정 | 사용자 |
| 재부팅 후 자동 기동 | 미확인 | 사용자 |
| Docker 버전·디스크 여유 (확인 필요 D) | 미기록 | 사용자 |
| ~~CI 실제 실행 (gitleaks·라이선스·외부 URL)~~ | **완료 2026-09-16** (4.11절) | — |

### 7.1 Linux 서버에서 실행할 명령

```bash
git clone https://github.com/hipiboy7/workfluence.git   # 또는 git pull
cd workfluence
git checkout impl-phase0

df -h /                    # 여유 5GB 미만이면 정리 후 진행 (CLAUDE.md 8.2절)
docker --version && docker compose version

pnpm setup:env             # .env 생성. 여기에 WF_PG_PASSWORD 추가 (compose 전용, P0_설계서 1.1절)
echo "WF_PG_PASSWORD=$(openssl rand -hex 16)" >> .env

docker compose -f deploy/compose.yml --env-file .env build api
docker images workfluence-app                                   # 크기 기록
docker compose -f deploy/compose.yml --env-file .env up -d postgres api
docker compose -f deploy/compose.yml --env-file .env run --rm api node dist/db/migrate.js
curl -i http://127.0.0.1:3000/api/health                        # api 포트를 노출한 경우
docker compose -f deploy/compose.yml ps                         # healthy 확인
```

결과(이미지 크기·기동 시간·`/api/health` 응답 원문·Docker 버전·디스크 여유)를 이 문서 7절에 채우면 Phase 0을 닫는다.

> nginx는 인증서(deploy/certs 아래 cert.pem·key.pem)가 있어야 뜬다. Phase 0 검증에서는 `postgres`·`api`만 올려 확인하고, TLS 종단은 Phase 5 배포가이드에서 다룬다.

## 8. 다음 Phase 인계

`P0_설계서_Foundation.md` 13절 참고. 요약:

- 환경변수 표에 세션·계정·OIDC 키 추가, `.env.example`·compose 동시 갱신
- `settings.updated_by`에 `users` FK 제약 추가
- `AuthGuard`가 쓰는 모듈은 `@Global()`
- E2E는 자기 계정을 직접 만든다
