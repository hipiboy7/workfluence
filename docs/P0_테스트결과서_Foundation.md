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
| 등급 A — `packages/shared` | 5 | **49** | 전부 통과 | 0 |
| 등급 B — `apps/api` | 4 | **17** | 전부 통과 | 0 |
| 등급 B — `apps/web` | 0 | 0 | — (Phase 0 화면은 E2E로 검증) | 0 |
| 등급 C — E2E | 1 | **4** | 전부 통과 | 0 |
| **합계** | **10** | **70** | **PASS** | **0** |

실패·에러 0건. **skip 0건** — skip은 통과가 아니다 (`CLAUDE.md` 1.3절).

## 3. 등급별 커버리지

### 3.1 등급 A — 목표 ≥ 90% (NFR-01)

```
File            | % Stmts | % Branch | % Funcs | % Lines | Uncovered
----------------|---------|----------|---------|---------|----------
All files       |   98.71 |    98.10 |  100.00 |   99.00 |
 document.ts    |   97.64 |    97.56 |  100.00 |   97.33 | 72-73
 security.ts    |   97.36 |    92.30 |  100.00 |  100.00 | 50
 (constants·env·permissions·schemas) |  100 |  100 |  100 |  100 |
```

→ 목표 90% 대비 **+8.7%p (라인 99%)**. 관문 통과.

미커버 2곳은 방어적 분기다: `document.ts` 72-73은 오류 20건 초과 시 조기 종료, `security.ts` 50은 생성된 임시 비밀번호가 정책을 위반할 경우의 예외(정상 경로에서는 도달 불가).

### 3.2 등급 B — `apps/api` 목표 ≥ 70%

```
File               | % Stmts | % Branch | % Funcs | % Lines | Uncovered
-------------------|---------|----------|---------|---------|----------
All files          |   98.03 |    88.88 |   94.11 |  100.00 |
 common/           |   97.77 |    88.88 |   93.33 |  100.00 |
  rate-limit.guard |   96.42 |    85.71 |   80.00 |  100.00 | 13,29
 health/           |  100.00 |   100.00 |  100.00 |  100.00 |
```

→ 목표 70% 대비 **+28%p (라인 100%)**. 관문 통과.

측정 대상은 `src/common/**`·`src/health/**`다. 부트스트랩(`main.ts`)·모듈 조립(`app.module.ts`)·DB 연결·마이그레이션 실행은 **단위 테스트로 검증할 수 없는 배선**이라 E2E와 실제 기동으로 확인한다 (4절).

### 3.3 A+B 가중 평균 — 목표 ≥ 80%

| 구분 | 라인 커버리지 |
|---|---|
| A (`packages/shared`) | 99.00% |
| B (`apps/api` 측정 대상) | 100.00% |
| **가중 평균** | **약 99%** |

→ 목표 80% 대비 큰 폭 초과.

## 4. 실제 동작 검증 (CLAUDE.md 1.3절)

**문서가 아니라 동작으로 확인한다.** 아래는 전부 실행한 결과다.

### 4.1 환경 확인 — `pnpm check:env`

```
OK   pnpm 버전 = packageManager — pnpm 12.4.1, 요구 12.4.1
OK   .env 존재 — D:\claude\workfluence\.env
OK   .env 스키마 (WF_* strict) — 12개 키
OK   데이터 경로 = 이 디렉토리의 .local/ — D:\claude\workfluence\.local
OK   WF_PG_EMBEDDED_DIR이 .local/ 아래 — D:\claude\workfluence\.local\pgdata
OK   드라이브 여유 ≥ 3GB — 10.3GB 여유 (D:)
OK   PostgreSQL 연결 — PostgreSQL 17.10 on x86_64-windows
OK   마이그레이션 테이블 — 적용 이력 있음

READY
```

### 4.2 DB 초기화·마이그레이션·시드

프로토타입 데이터를 지우고 처음부터 만들었다 (프롬프트 5절 쟁점 3 확정 사항).

```
$ rm -rf .local/pgdata && pnpm dev:db
[dev-db] initdb → D:\claude\workfluence\.local\pgdata
[dev-db] 데이터베이스 생성: workfluence, workfluence_test
[dev-db] READY. Ctrl+C로 종료.

$ pnpm db:migrate
[migrate] D:\claude\workfluence\apps\api\drizzle → postgres://***@127.0.0.1:5433/workfluence
[migrate] 1개 마이그레이션 적용 상태

$ pnpm db:seed
[seed] Phase 0 — 시드할 데이터가 없다 (계정·카테고리는 Phase 1)
```

### 4.3 헬스체크 실호출 (FR-040)

```
$ curl -i http://127.0.0.1:3000/api/health
HTTP/1.1 200 OK
X-Content-Type-Options: nosniff
Referrer-Policy: same-origin
Content-Security-Policy: default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'
Cache-Control: no-store
Content-Type: application/json; charset=utf-8

{"status":"ok","db":"ok","time":"2026-09-16T01:56:30.000Z"}
```

### 4.4 정적 자산 캐시 (FR-063)

```
$ curl -i http://127.0.0.1:3000/assets/index-B3pKotSU.js
HTTP/1.1 200 OK
Cache-Control: public, max-age=31536000, immutable
```

해시 파일명만 `immutable`, 나머지와 `/api/*`는 `no-store`임을 확인했다.

### 4.5 브라우저 화면 (FR-071)

`http://127.0.0.1:3000/`에서 기동 확인 화면이 뜨고 API·데이터베이스가 각각 `ok`, 서버 시각이 표시된다. Phase 0의 인수 기준(`scope-definition.md` 5절)을 화면으로 충족한다.

### 4.6 E2E (등급 C) — 4건 통과

| # | 시나리오 | 확인 내용 |
|---|---|---|
| 1 | 헬스체크 | 200, `status`·`db` = ok, 시각 파싱 가능, `Cache-Control: no-store` |
| 2 | 보안 응답 헤더 | `nosniff`, CSP `default-src 'self'`·`frame-ancestors 'none'`, `X-Powered-By` 없음 |
| 3 | SPA 셸 | 제목·기동 확인 영역 표시, 배지 `ok`, 데이터베이스 항목 노출 |
| 4 | 딥링크 폴백 | 임의 경로는 200 text/html, `/api/unknown`은 404 JSON |

### 4.7 설정 항목 추적성 (NFR-10)

코드가 읽는 `WF_*`와 설계서 1.1절 표, `.env.example`을 대조했다.

| 집합 | 키 수 | 결과 |
|---|---|---|
| 환경 스키마 (`packages/shared/src/env.ts`) | 12 | 기준 |
| `.env.example` | 12 | **일치** (테스트가 강제 — FR-015) |
| 설계서 1.1절 표 | 12 | **일치** |

대조 중 발견해 고친 것: `deploy/compose.yml`이 프로토타입 시절의 세션·계정 키(`WF_SESSION_SECRET`·`WF_ROOT_*`·`WF_COOKIE_SECURE`)를 여전히 넘기고 있었다. **strict 스키마라 그대로 두면 운영 컨테이너가 기동에 실패한다.** 제거하고 Phase 1 주석으로 대체했다. Playwright의 `WF_E2E_BASE_URL`은 앱 환경변수가 아니므로 `E2E_BASE_URL`로 바꿨다 — `WF_` 접두사는 앱 환경변수만을 뜻한다.

### 4.8 검사 관문

| 검사 | 결과 |
|---|---|
| `pnpm lint` | 통과 (0건) |
| `pnpm typecheck` | 3개 패키지 통과 |
| `pnpm verify:docs` | 문서 위반 0건 |
| `pnpm licenses:check` | production 의존성 **129개**, 허용 라이선스만 사용 |

### 4.9 빌드 산출물

| 산출물 | 크기 |
|---|---|
| `apps/web/dist` | 225KB (JS 221KB / gzip 69KB, CSS 1.2KB) |
| `apps/api/dist` | 117KB |

프로토타입 대비 web 번들이 837KB → 221KB로 줄었다. Phase 0 셸에는 편집기·라우터가 없기 때문이며, Phase 2에서 다시 늘어난다.

## 5. 요구사항 대응

| FR/NFR | 검증 방법 | 결과 |
|---|---|---|
| FR-001~004 | 기반 파일 존재, `pnpm install` 성공, `pnpm store path`가 `.local/` | PASS |
| FR-010~014 | `env.spec.ts` — 미지 키·타입·범위·빈 문자열·운영 자동 마이그레이션 거부 | PASS |
| FR-015 | `.env.example` ↔ 스키마 키 집합 테스트 | PASS |
| FR-016 | `.env.example`에 placeholder만, 실제 값 없음 | PASS |
| FR-017 | `loadEnv`가 파일+`process.env` 병합, `process.env` 우선 | PASS |
| FR-020~027 | `constants`·`document`·`permissions`·`security`·`schemas` 테스트 49건 | PASS |
| FR-030~032 | 마이그레이션 실행·재실행(멱등) 확인 | PASS |
| FR-033 | `settings` 테이블 생성 확인 | PASS |
| FR-034 | 시드 2회 실행 결과 동일 | PASS |
| FR-040, 041 | `health.controller.spec.ts` + 실호출 | PASS |
| FR-050~052 | `logger.spec.ts` — JSON 한 줄·redact·레벨·Nest 위임 | PASS |
| FR-060 | `zod.pipe.spec.ts` — 400 + 위반 목록·중첩 경로 | PASS |
| FR-061 | `rate-limit.guard.spec.ts` — 상한·IP/핸들러 분리·창 만료 | PASS |
| FR-062~064 | 실호출 헤더 확인 (4.3절) | PASS |
| FR-070~072 | E2E 3·4번, 빌드 산출물에 외부 URL 없음 | PASS |
| FR-080~084 | `check:env` READY, `dev:db` 초기화, `verify:docs` 0건, `test:e2e` 4건, `check` | PASS |
| FR-090 | ESLint 대소문자 검사 규칙 적용, lint 통과 | PASS |
| FR-091~094 | CI 워크플로 작성 | **미검증** (7절) |
| FR-100~104 | Dockerfile·compose·nginx 작성 | **미검증** (7절) |
| FR-110, 111 | 에이전트 2 + 스킬 1 + `설계서_Agents.md` | PASS |
| NFR-01, 02 | 3절 커버리지, skip 0 | PASS |
| NFR-03, 04 | 이미지 크기·기동 시간 | **미측정** (7절) |
| NFR-05 | 빌드 산출물 외부 URL 검사 (CI 단계) | **미검증** (7절) |
| NFR-06 | Windows에서 전 명령 동작 확인. Linux는 7절 | 부분 |
| NFR-07 | `pnpm install --frozen-lockfile` (CI) | **미검증** (7절) |
| NFR-08 | `verify:docs` 0건 | PASS |
| NFR-09 | `.env` 미커밋 확인, gitleaks는 CI | 부분 |
| NFR-10 | 4.7절 대조 | PASS |

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

### 6.6 `apps/web` 커버리지 관문 없음

`CLAUDE.md` 3절대로 web에는 관문을 두지 않았다. Phase 0의 화면은 단일 컴포넌트라 E2E가 더 정확한 검증이다. 상태·분기가 늘어나는 Phase 1부터 컴포넌트 테스트를 붙인다.

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
| CI 실제 실행 (gitleaks·라이선스·외부 URL) | 미검증 | push 후 확인 |

### 7.1 Linux 서버에서 실행할 명령

```bash
git clone https://github.com/hipiboy7/workfluence.git   # 또는 git pull
cd workfluence
git checkout impl-phase0

df -h /                    # 여유 5GB 미만이면 정리 후 진행 (CLAUDE.md 8.2절)
docker --version && docker compose version

cp .env.example .env       # WF_PG_PASSWORD 추가 (compose 전용, P0_설계서 1.1절)
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
