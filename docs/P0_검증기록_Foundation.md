# P0_검증기록_Foundation — Phase 0 공통 기반 검증

- 상위 문서: [`docs/P0_설계서_Foundation.md`](P0_설계서_Foundation.md)
- 규칙: [`CLAUDE.md`](../CLAUDE.md) 4절 3단계 산출물. **수치와 실제 출력만 쓴다.** 시행착오의 경위는 [`docs/internal/검토서_트러블슈팅.md`](internal/검토서_트러블슈팅.md)에 있다
- 실행일: 2026-09-16 (개발 환경) / 2026-09-21 (Linux 빌드, 6절) / 작성 LLM: Claude Opus 5
- 결과: **전 항목 통과.** Linux 빌드·기동·헬스체크까지 실측으로 확인했다 (6절)

> **개정 이력 (2026-09-16).** 원래 이름은 `P0_테스트결과서_Foundation.md`였고 415줄이었다. 그중 재작업 경위 9꼭지가 트러블슈팅 기록과 겹쳐 있었다. 한 사실은 한 곳에만 둔다는 규칙에 따라 경위를 전부 트러블슈팅으로 옮기고, 이 문서는 **측정과 실제 출력**만 남겼다. 근거는 [`docs/internal/검토서_방법론개정.md`](internal/검토서_방법론개정.md).

## 1. 실행 환경과 명령

| 항목 | 값 |
|---|---|
| 개발 PC | Windows Server 2022, D 드라이브 (여유 10.3GB) |
| Node.js | v24.14.0 |
| pnpm | 12.4.1 |
| PostgreSQL | 17.10 (임베디드, `.local/pgdata`) |
| 브라우저 | Chromium (Playwright 1.63, `.local/ms-playwright`) |
| 환경변수 | 12개 키 |

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

## 2. 테스트 건수와 커버리지

| 구분 | 파일 | 테스트 | 결과 | skip |
|---|---|---|---|---|
| 등급 A — `packages/shared` | 5 | **52** | 전부 통과 | 0 |
| 등급 B — `apps/api` | 4 | **18** | 전부 통과 | 0 |
| 등급 B — `apps/web` | 0 | 0 | Phase 0 화면은 E2E로 검증 | 0 |
| 등급 C — E2E | 1 | **4** | 전부 통과 | 0 |
| **합계** | **10** | **74** | **PASS** | **0** |

**등급 A — 목표 ≥ 90% (NFR-01)**

```
File            | % Stmts | % Branch | % Funcs | % Lines | Uncovered
----------------|---------|----------|---------|---------|----------
All files       |   98.72 |    98.12 |  100.00 |   99.01 |
 document.ts    |   97.70 |    97.61 |  100.00 |   97.40 | 78-79
 security.ts    |   97.36 |    92.30 |  100.00 |  100.00 | 50
 (constants·env·permissions·schemas) |  100 |  100 |  100 |  100 |
```

미커버 2곳은 방어적 분기다. `document.ts` 78-79는 오류 20건 초과 시 조기 종료, `security.ts` 50은 생성된 임시 비밀번호가 정책을 위반할 경우의 예외로 정상 경로에서는 도달하지 않는다.

**등급 B — `apps/api` 목표 ≥ 70%**

```
File               | % Stmts | % Branch | % Funcs | % Lines | Uncovered
-------------------|---------|----------|---------|---------|----------
All files          |   98.11 |    90.00 |   94.11 |  100.00 |
 common/           |   97.77 |    88.88 |   93.33 |  100.00 |
  rate-limit.guard |   96.42 |    85.71 |   80.00 |  100.00 | 13,29
 health/           |  100.00 |   100.00 |  100.00 |  100.00 |
```

**측정 범위를 한정했다. 위 수치는 api 코드 전체의 커버리지가 아니다.**

| 제외 | 이유 | 무엇으로 검증하나 |
|---|---|---|
| `main.ts` | 부트스트랩. 프로세스를 띄워야 의미가 있다 | 실제 기동 + E2E (3절) |
| `app.module.ts` | 모듈 조립·정적 서빙 설정 | E2E 3·4번, SPA 경로 오류 재현 (3.4절) |
| `config/` | `.env`와 파일 시스템에 의존 | `check:env` 실행. 스키마 자체는 A등급 `env.spec.ts` |
| `db/` | 실제 PostgreSQL이 있어야 한다 | 마이그레이션·시드 실행 (3.2절) |

**두 가지 한정을 함께 읽어야 한다.** 첫째, 위 범위 한정. 둘째, **등급 A의 99%는 아직 호출자가 없는 코드에 대한 수치다.** `packages/shared`의 DTO·권한 판정·문서 검증은 Phase 1·2에서 실제 호출부가 붙는다. 그때 계약이 바뀔 수 있고 커버리지를 다시 측정해야 한다 (`CLAUDE.md` 3절·보류 10). 현재 앱 코드가 쓰는 것은 환경 스키마뿐이다.

가중 평균은 약 99%로 목표 80%를 넘지만, 위 두 한정 때문에 이 숫자를 품질의 전부로 읽지 않는다.

## 3. 실제 동작 검증

**문서가 아니라 동작으로 확인한다** (`CLAUDE.md` 1.3절). 아래는 실행 결과를 그대로 옮긴 것이다.

### 3.1 환경 확인 — `pnpm check:env`

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

### 3.2 DB 초기화·마이그레이션·시드 (멱등성 포함)

프로토타입 데이터를 지우고 처음부터 만들었다.

```
$ pnpm dev:db          # 최초
[dev-db] initdb → D:\claude\workfluence\.local\pgdata
[dev-db] 데이터베이스 workfluence: 생성
[dev-db] 데이터베이스 workfluence_test: 생성
[dev-db] READY. Ctrl+C로 종료.

$ pnpm dev:db          # 재실행 — 만들지 않고 "있음"
[dev-db] 데이터베이스 workfluence: 있음
[dev-db] 데이터베이스 workfluence_test: 있음
```

마이그레이션과 시드를 각각 2회 실행해 **출력이 같음**을 확인했다 (FR-031, FR-034).

```
$ pnpm db:migrate      # 1회·2회 동일
[migrate] D:\claude\workfluence\apps\api\drizzle → postgres://***@127.0.0.1:5433/workfluence
[migrate] 1개 마이그레이션 적용 상태

$ pnpm db:seed         # 1회·2회 동일
[seed] Phase 0 — 시드할 데이터가 없다 (계정·카테고리는 Phase 1)
```

테스트 DB 배선 (FR-030). `WF_ENV=test`면 테스트 DB로 붙는다.

```
$ WF_ENV=test pnpm db:migrate
[migrate] D:\claude\workfluence\apps\api\drizzle → postgres://***@127.0.0.1:5433/workfluence_test
[migrate] 1개 마이그레이션 적용 상태
```

두 DB의 테이블을 직접 조회해 확인했다. 양쪽 모두 `drizzle.__drizzle_migrations`와 `public.settings`가 있다. `WF_ENV=test`인데 `WF_DATABASE_URL_TEST`가 비어 있으면 **개발 DB로 대체하지 않고 종료 코드 1로 실패**한다.

### 3.3 헬스체크·보안 헤더·캐시 실호출 (FR-040, FR-062, FR-063)

```
$ curl -i http://127.0.0.1:3000/api/health
HTTP/1.1 200 OK
X-Content-Type-Options: nosniff
Referrer-Policy: same-origin
Content-Security-Policy: default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'
Cache-Control: no-store
Content-Type: application/json; charset=utf-8

{"status":"ok","db":"ok","time":"2026-09-16T02:31:35.016Z"}
```

```
$ curl -i http://127.0.0.1:3000/assets/index-B3pKotSU.js
HTTP/1.1 200 OK
Cache-Control: public, max-age=31536000, immutable
```

해시 파일명만 `immutable`, 나머지와 `/api/*`는 `no-store`다.

### 3.4 SPA 경로가 틀리면 기동이 멈춘다 (FR-070)

경로가 틀리면 화면은 통째로 404인데 `/api/health`는 200이라 **헬스체크가 healthy를 보고한다.** 조용히 잘못되는 유형이라 기동 시점에 실패시킨다. 경위는 트러블슈팅 T-013.

```
$ WF_WEB_DIST=../../web/dist node dist/main.js
Error: WF_SERVE_WEB=true인데 SPA 산출물이 없다: D:\claude\workfluence\web\dist
  WF_WEB_DIST=../../web/dist (기준 D:\claude\workfluence\apps\api)
  개발이면 'pnpm build'를, 컨테이너면 이미지 레이아웃과 WF_WEB_DIST를 확인한다.
```

### 3.5 브라우저 화면과 E2E (FR-071, 등급 C)

`http://127.0.0.1:3000/`에서 기동 확인 화면이 뜨고 API·데이터베이스가 각각 `ok`, 서버 시각이 표시된다.

| # | 시나리오 | 확인 내용 |
|---|---|---|
| 1 | 헬스체크 | 200, `status`·`db` = ok, 시각 파싱 가능, `Cache-Control: no-store` |
| 2 | 보안 응답 헤더 | `nosniff`, CSP `default-src 'self'`·`frame-ancestors 'none'`, `X-Powered-By` 없음 |
| 3 | SPA 셸 | 제목·기동 확인 영역 표시, 배지 `ok`, 데이터베이스 항목 노출 |
| 4 | 딥링크 폴백 | 임의 경로는 200 text/html, `/api/unknown`은 404 JSON |

### 3.6 설정 항목 추적성 (NFR-10)

| 집합 | 키 수 | 결과 |
|---|---|---|
| 환경 스키마 (`packages/shared/src/env.ts`) | 12 | 기준 |
| `.env.example` | 12 | **일치** (테스트가 강제 — FR-015) |
| 설계서 1.1절 표 | 12 | **일치** |

compose 전용 변수 3개는 앱에 전달되지 않으므로 앱 스키마에 넣지 않고 설계서 1.1절에 따로 표로 두었다. 대조 중 compose가 프로토타입 시절의 세션·계정 키를 넘기던 것을 발견해 제거했다. strict 스키마라 그대로 두면 **운영 컨테이너가 기동에 실패한다.**

### 3.7 검사 관문

| 검사 | 결과 |
|---|---|
| `pnpm lint` | 통과 (0건) |
| `pnpm typecheck` | 3개 패키지 통과 |
| `pnpm verify:docs` | 위반 0건 |
| `pnpm licenses:check` | production 의존성 **129개**, 허용 라이선스만 (MIT 116 · ISC 7 · Apache-2.0 3 · BSD-3-Clause 2 · 0BSD 1) |

빌드 산출물 크기는 web SPA 번들이 225KB(JS 221KB / gzip 69KB, CSS 1.2KB), api 컴파일 결과가 117KB다.

### 3.8 CI 실제 실행

워크플로를 작성만 하고 "돌 것이다"라고 적지 않는다.

| 작업 | 단계 | 결과 |
|---|---|---|
| `check` | 의존성 설치(lockfile 고정) · lint · typecheck · 테스트 · 문서 검사 · 취약점 점검 · 라이선스 검사 · 빌드 · 외부 URL 참조 검사 | 9단계 전부 success |
| `gitleaks` | 전체 이력 스캔 | success |

**세 번 실패한 뒤의 성공이다.** 원인은 순서대로 트러블슈팅 T-007, T-008, T-010이고 셋 다 **개발 PC에는 있고 갓 클론한 곳에는 없는 것**이었다. CI 단계를 쪼갠 덕에 세 번째 실패는 어느 관문인지 즉시 보였다.

## 4. 요구사항 대응

| FR/NFR | 검증 방법 | 결과 |
|---|---|---|
| FR-001~004 | 기반 파일 존재, `pnpm install` 성공, `pnpm store path`가 `.local/` | PASS |
| FR-010~014 | `env.spec.ts` — 미지 키·타입·범위·빈 문자열·운영 자동 마이그레이션 거부 | PASS |
| FR-015 | `.env.example`과 스키마 키 집합 대조 테스트 | PASS |
| FR-016 | `.env.example`에 placeholder만 | PASS |
| FR-017 | `loadEnv`가 파일과 `process.env`를 병합, `process.env` 우선 | PASS |
| FR-020~027 | `constants`·`document`·`permissions`·`security`·`schemas` 테스트 49건 | PASS (호출자는 Phase 1~2에서 붙는다) |
| FR-030~032 | 마이그레이션 2회 동일 출력, 테스트 DB 분기 확인 (3.2절) | PASS |
| FR-033 | `settings` 테이블 생성 확인 | PASS |
| FR-034 | 시드 2회 실행 결과 동일 (3.2절) | PASS |
| FR-040, 041 | `health.controller.spec.ts` + 실호출 (3.3절) | PASS |
| FR-050~052 | `logger.spec.ts` — JSON 한 줄·마스킹·레벨·프레임워크 위임 | PASS |
| FR-060 | `zod.pipe.spec.ts` — 400 + 위반 목록·중첩 경로 | PASS |
| FR-061 | `rate-limit.guard.spec.ts` — 상한·IP/핸들러 분리·창 만료 | PASS |
| FR-062~064 | 실호출 헤더 확인 (3.3절) | PASS |
| FR-070 | SPA 경로 오류 시 기동 중단 확인 (3.4절) | PASS |
| FR-071, 072 | E2E 3·4번, 빌드 산출물에 외부 URL 없음 | PASS |
| FR-080~084 | `check:env` READY, `dev:db` 초기화, `verify:docs` 0건, `test:e2e` 4건, `check` | PASS |
| FR-090 | ESLint 대소문자 검사 규칙 적용, lint 통과 | PASS |
| FR-091~094 | GitHub Actions 실제 실행 (3.8절) | PASS |
| FR-100~104 | Dockerfile·compose·nginx 작성 | PASS — Dockerfile·compose는 6절에서 실빌드·실기동. nginx는 TLS 인증서가 없어 미기동 |
| FR-110, 111 | 에이전트 2 + 스킬 1 + `docs/internal/설계서_Agents.md` | PASS |
| NFR-01, 02 | 2절 커버리지, skip 0 | PASS (측정 범위 한정 있음) |
| NFR-03, 04 | 이미지 크기·기동 시간 | PASS — 384MB (≤400MB), 13초 (≤30초). 6절 |
| NFR-05 | CI의 외부 URL 검사 단계 통과 | PASS |
| NFR-06 | Windows에서 전 명령 동작 확인. Linux는 6절 | PASS |
| NFR-07 | CI의 의존성 설치가 lockfile 고정으로 통과 | PASS |
| NFR-08 | `verify:docs` 0건 | PASS |
| NFR-09 | `.env` 미커밋 + CI gitleaks success | PASS |
| NFR-10 | 3.6절 대조 | PASS |

## 5. 자체 점검 결과

`self-reviewer` 에이전트가 별도 컨텍스트에서 검토해 **결함 25건**(높음 3·보통 13·낮음 9)을 보고했고 **오탐은 0**이었다. 그중 하나는 Linux 빌드에 가서야 드러났을 것이고 오진하기 쉬운 형태였다(트러블슈팅 T-013). 전체 처리 내역은 [`docs/internal/P0_검토서_SelfReview.md`](internal/P0_검토서_SelfReview.md) 5절.

`doc-consistency` 에이전트가 Phase 종료 재독에서 **어긋남 2건**을 보고했고 둘 다 사실이었다. CI를 단계별로 쪼갠 변경이 워크플로에는 반영됐는데 설계서와 요구사항정의서에는 옛 문구로 남아 있었다. 같은 사실을 세 곳에 적었기 때문이며, 이것이 두 문서를 합친 계기다.

## 6. Linux 빌드 검증 — 완료 (2026-09-21)

**완료 기준의 마지막 항목을 채웠다.** 사내 리눅스 빌드 서버에서 `impl-phase0`(`3a0f589`)을
받아 이미지를 만들고 띄워 여섯 개 값을 실측했다. 목표가 있는 네 항목 모두 충족했다.

| 항목 | 실측 | 목표 | 판정 |
|---|---|---|---|
| Linux 서버에서 pull → 이미지 빌드 | 완료 (22초, `--no-cache` 25초) | — | — |
| `docker compose up -d` → `/api/health` 200 | `HTTP 200` + `{"status":"ok","db":"ok",...}` | 200 + `ok` | 충족 |
| 이미지 크기 | **384MB** | ≤400MB | 충족 |
| 기동 시간 | **13초** | ≤30초 | 충족 |
| 재부팅 후 자동 기동 | `unless-stopped` 둘 다 + 도커 데몬 `enabled`. **실제 재부팅은 미실시** | 정책 확인 | 충족 (11.1절 범위) |
| Docker·Compose 버전, 디스크 여유 (확인 필요 D) | Docker 29.6.1 / Compose v5.3.1 / 여유 20GB | 24+ / v2 / 5GB+ | 충족 |
| ~~CI 실제 실행~~ | **완료 2026-09-16** (3.8절) | — | — |

### 6.1 실행 절차

절차와 명령은 [`docs/운영가이드_리눅스빌드.md`](운영가이드_리눅스빌드.md)에 있다. **여기에 다시 적지 않는다** — 같은 명령을 두 곳에 두면 한쪽이 상한다 (`CLAUDE.md` 1.3절).

### 6.2 받은 값 원문

```
Docker version 29.6.1, build 8900f1d
Docker Compose version v5.3.1
```

```
# 빌드 전
Filesystem      Size  Used Avail Use% Mounted on
/dev/vda4        39G   20G   20G  51% /
# 빌드·기동·마이그레이션까지 끝난 뒤
/dev/vda4        39G   22G   18G  55% /
```

```
IMAGE                     ID             DISK USAGE   CONTENT SIZE   EXTRA
workfluence-app:3a0f589   24f8abc48051        384MB         86.4MB
workfluence-app:latest    24f8abc48051        384MB         86.4MB
```

```
기동 시간: 13초
```

```
HTTP 200
{"status":"ok","db":"ok","time":"2026-09-21T06:41:48.904Z"}
```

```
/workfluence-api restart=unless-stopped
/workfluence-postgres restart=unless-stopped
enabled
```

마이그레이션은 두 번 돌려 출력이 같았고(`[migrate] 1개 마이그레이션 적용 상태`), `down` 후
다시 올렸을 때도 같았다. 볼륨이 살아 있고 멱등이라는 뜻이다.

**측정에서 뺀 것.** `postgres:17`을 미리 받아 두고 기동 시간을 쟀다(받는 데 8.7초).
가이드 5절은 앱 이미지만 빌드하므로, 처음 도는 서버에서 6절 스크립트를 그대로 쓰면
이미지 내려받는 시간이 기동 시간에 섞인다.

**이미지 크기의 근거.** Docker 29의 `docker images`에는 가이드가 말하는 `SIZE` 칸이 없고
`DISK USAGE`(384MB)와 `CONTENT SIZE`(86.4MB)로 갈린다. 400MB 목표와 비교한 값은
`--format '{{.Size}}'`가 가리키는 **384MB**다. 둘 중 큰 쪽으로 판정했다.

### 6.3 첫 빌드는 실패했다 — 프록시가 빌드 컨테이너에 전달되지 않았다

`RUN npm install -g pnpm`이 **471초 뒤 ETIMEDOUT**으로 죽었다. 도커 데몬에는 사내 프록시가
설정돼 있어 **베이스 이미지 받기는 성공**하는데, 빌드 컨테이너 안의 `RUN` 단계는 프록시를
물려받지 못해 레지스트리로 직접 나가려다 끊긴 것이다.

조용히 잘못되기 쉬운 형태였다. `git clone`은 호스트 셸이 프록시를 쓰므로 **성공한다.**
그래서 가이드 1절의 "`git clone`이 되는지"를 통과하고도 빌드에서 막힌다.

`deploy/compose.yml`의 `api.build.args`에 프록시를 셸 환경에서 받아 넘기도록 해서 고쳤다.
같은 단계가 **2.5초**로 끝난다. 값은 저장소에 박지 않고(`${HTTP_PROXY:-}`) 프록시가 없는
폐쇄망 반입 서버에서는 빈 값이라 무해하다. 프록시 값이 이미지에 남지 않는 것도 확인했다
(`docker history` 0건, `Config.Env`에 없음 — 도커가 predefined build arg로 처리해 제거한다).

## 7. 다음 Phase 인계

설계서 13절이 단일 출처다. 요약하면 환경변수 표에 세션·계정·OIDC 키를 추가하고 `.env.example`과 compose를 같은 커밋에서 갱신하는 것, `settings.updated_by`에 사용자 테이블 FK 제약을 추가하는 것, 인증 가드가 쓰는 모듈을 전역으로 두는 것, E2E가 자기 계정을 직접 만드는 것이다.
