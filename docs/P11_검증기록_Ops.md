# P11 검증기록 — Ops (운영 로그 · LLM 관리 위임 · 사내 LLM 반입 설정)

- 작성일: 2026-09-26 / 작성 LLM: Claude Opus 5.5
- 설계: [`docs/P11_설계서_Ops.md`](P11_설계서_Ops.md) · 검토: 8절
- 요청 원문과 착수 쟁점의 답: `docs/prompts/phase11/scope.md`
- 시행착오는 여기 쓰지 않는다 — [`docs/internal/검토서_트러블슈팅.md`](internal/검토서_트러블슈팅.md) T-047(A등급 관문이 새 domain 디렉토리를 빠뜨림)
- 테스트·커버리지·E2E는 `7a03a36`에서 쟀다. 그 뒤의 변경은 A등급 관문의 설정(T-047)과 문서다 — 커버리지 관문은 바뀐 설정으로 다시 돌렸다(3절).
  컨테이너 확인(2절)은 `workfluence-app:7a03a36-p11` 이미지로 했다.
- 이 세션도 **이 계정 소유의 사본**에서 일했다(T-040·T-042). 새 빌드는 `:3100`에 띄우고 `E2E_BASE_URL`로 E2E를 돌렸다. 개발 DB(`:5433`)는
  앞 계정과 함께 쓴다 — `:3100`이 기동할 때 `0010`이 개발 DB에 적용됐다(옛 빌드 `:3000`은 새 열을 모르지만 기본값이 있어 막히지 않는다).

## 1. 실행 환경

| 항목 | 값 |
|---|---|
| 호스트 | 사내 Linux 서버 (RHEL 9). 개발·빌드 같은 호스트 |
| Node / pnpm | v24.21.0 / 12.4.1 |
| PostgreSQL | 17.10 (임베디드) · 컨테이너 postgres:17 |
| 새 의존성 | **없다** — 요청 문맥은 Node 내장 `AsyncLocalStorage`, 로거는 쓰던 pino (NFR-110) |
| nginx | nginx:1.27-alpine (`nginx -t` 통과) |
| 사내 LLM | **가짜** — compose 망 안의 https 서버(`wf-mock-llm`)가 **시험용 CA**가 서명한 인증서로 `/v1/models`를 답한다. 시험용 CA·인증서는 `openssl`로 그 자리에서 만들고(2일짜리) 저장소에 넣지 않았다 |
| Docker / Compose | 29.6.1 / v5.3.1 |
| 디스크 | 빌드 전 `/` 여유 14GB (전체 39GB) |

## 2. 컨테이너 — nginx를 거친 요청

스택: `up -d postgres` → `run --rm api node dist/db/migrate.js` → `up -d api nginx`. 호스트에서 nginx(TLS, 8443)로 부른다. **TLS 검증을
끄지 않았다** — 호스트의 curl은 개발용 자가서명 인증서를 CA로 믿고(`--cacert`), 앱은 2.5의 CA 파일로 믿는다. 계정은 합성(`p11-root`·
`p11-admin`)으로 컨테이너 DB에 직접 만들고 끝나고 지웠다.

### 2.1 요청 하나를 세 곳에서 같은 번호로 찾는다 (FR-1210~1213·1217)

root가 `p11-admin`에게 LLM 연결 관리를 준 요청(`PUT /api/users/:id/grants` → 200). 응답 머리말 `x-request-id: c4f74de7a73ff592ec5ec63e597de58b`
(**하나** — nginx의 값)로 찾았다.

```
nginx  {"time":"2026-09-25T16:20:19+00:00","service":"workfluence-nginx","requestId":"c4f74de7a73ff592ec5ec63e597de58b","remoteAddr":"<도커 브리지>",
        "method":"PUT","uri":"/api/users/60929697-782f-4f46-8510-39e1ca9803e6/grants","status":200,"bytes":241,"requestTime":0.022,"upstreamTime":"0.022","userAgent":"curl/7.76.1"}
api    {"level":30,"time":"2026-09-25T16:20:19.455Z","service":"workfluence-api","requestId":"c4f74de7a73ff592ec5ec63e597de58b","userId":"07154510-101f-4fd5-9770-2498b11a25a6",
        "event":"http.request","method":"PUT","route":"/api/users/:id/grants","status":200,"durationMs":21,"msg":"PUT /api/users/:id/grants 200"}
감사   user.grants.change | c4f74de7a73ff592ec5ec63e597de58b | {"after": ["llm.manage"], "before": [], "username": "p11-admin"}
```

| 확인 | 값 |
|---|---|
| 세 곳의 번호 | 같다 — nginx가 만든 32자 16진 |
| 앱 로그에서 그 번호의 줄 | **1줄**(접근 로그) — 정상 요청은 한 줄이다 (NFR-111) |
| 앱 로그의 경로 | 경로 틀(`/api/users/:id/grants`) — id가 흩어지지 않는다. nginx는 실제 경로 |
| 앱 로그의 사용자 | 불투명 id (`userId`) |
| 이 시험 동안 감사 행 여섯(로그인 둘·위임 둘·LLM 등록·삭제) | 전부 `request_id`가 있다 |

### 2.2 요청 번호의 모양 (FR-1210, A.1-6)

| 보낸 것 | 결과 |
|---|---|
| 클라이언트가 `X-Request-Id: client-chosen-id-123`을 붙여 nginx로 | 응답은 nginx의 번호(`80b5a829…`) 하나. 앱 로그의 그 요청 줄도 nginx의 번호. **클라이언트의 값은 nginx·앱 로그 어디에도 없다**(0건) |
| api가 멈춘 채 nginx로(nginx가 스스로 낸 **502**) | `x-request-id`와 `strict-transport-security`가 붙는다 — server 단계 `add_header ... always`가 location에 막히지 않는다 |
| 앱에 바로(E2E), 모양이 맞는 번호 | 그대로 돌려준다 |
| 앱에 바로(E2E), `bad id "x"` | 새로 만든 UUID |

### 2.3 질의 문자열이 로그에 없다 (FR-1213·1217)

`GET /api/search?q=비밀P11질의&limit=5`(인코딩해서) → 200.

| 로그 | 그 요청의 줄 | 질의 문자열(`q=`·검색어·인코딩된 검색어) |
|---|---|---|
| nginx | `"uri":"/api/search"` | **0건** |
| api | `"route":"/api/search"` | **0건** |

### 2.4 로그 순환 (FR-1216)

```
$ docker inspect -f '{{.Name}} {{json .HostConfig.LogConfig}}' workfluence-postgres workfluence-api workfluence-nginx
/workfluence-postgres {"Type":"json-file","Config":{"max-file":"5","max-size":"20m"}}
/workfluence-api {"Type":"json-file","Config":{"max-file":"5","max-size":"20m"}}
/workfluence-nginx {"Type":"json-file","Config":{"max-file":"5","max-size":"20m"}}
```

도커 데몬의 기본값은 건드리지 않았다(공유 서버). 실제로 20MB가 차서 넘어가는 것은 보지 않았다(9절).

### 2.5 사내 CA 파일 (FR-1221·1222, 보류 29)

위임받은 관리자(`p11-admin`)가 `https://wf-mock-llm:8443/v1`을 등록하고 연결 확인을 눌렀다. compose는 한 줄도 고치지 않았다 —
compose 옆 `ca` 디렉토리에 `ca.pem`을 두고 빼며 `docker compose restart api`만 했다.

| `ca/ca.pem` | 앱 프로세스(PID 1)의 `NODE_EXTRA_CA_CERTS` | 기동 경고 | 연결 확인 |
|---|---|---|---|
| 없음 | 없다 | 0 | `{"ok":false,"message":"LLM 서버에 닿지 않는다 (UNABLE_TO_VERIFY_LEAF_SIGNATURE)"}` |
| **시험용 CA** | `/etc/workfluence/ca/ca.pem` | 0 | **`{"ok":true,"models":["mock-p11"],"modelFound":true}`** — 가짜 LLM이 `GET /v1/models`를 받았다 |
| 빈 파일 | 없다 | 0 | 닿지 않는다 (위와 같은 문장) |
| 다시 지움 | 없다 | — | 닿지 않는다 |

- 다시 띄워 헬스체크 200까지 11초. 세션은 PostgreSQL에 있어 다시 로그인하지 않았다.
- `git status`에 `ca.pem`이 나오지 않는다(`.gitignore`).
- **기관 여럿을 한 파일에** — 같은 Node(v24.21.0)로 호스트에서: 다른 CA를 앞에, 시험용 CA를 뒤에 이어 붙인 파일이면 200, 다른 CA만이면
  `UNABLE_TO_VERIFY_LEAF_SIGNATURE`, 없으면 같은 오류. `deploy/ca/README.md`의 "한 파일에 이어 붙인다"가 맞다.

### 2.6 위임과 회수 — nginx를 거쳐 (FR-1200~1205)

| 순서 | 결과 |
|---|---|
| root가 `p11-admin`에게 준다 | 200, `grants: ["llm.manage"]` |
| 관리자가 LLM을 등록한다 · 연결 확인 · 지운다 | 201 · 200 · 200 |
| root가 거둔다 | 200 |
| 관리자가 곧바로 LLM 관리 목록 | **403** `권한이 없다: llm.manage` — 세션을 끊지 않아도 다음 요청부터 |
| 관리자가 사용자 목록(제 역할의 일) | 200 — 관리자인 것은 그대로다 |
| 관리자가 스스로에게 준다 | **403** `권한이 없다: user.grants.change` (FR-1202) |
| 감사 | `user.grants.change` 둘 — `before: [] → after: ["llm.manage"]`, `before: ["llm.manage"] → after: []` · `llm.provider.create`·`delete` |

### 2.7 마이그레이션 `0010_ops`

**손으로 썼다**(보류 17). Phase 10의 컨테이너 DB(데이터가 있는 볼륨)에 `node dist/db/migrate.js`로 적용 — `[migrate] 11개 마이그레이션 적용 상태`.
`users.grants`(`text[]`, 기본 `'{}'`)·`audit_events.request_id`(`text`)와 CHECK 둘(`users_grants_known_chk`·`users_grants_admin_chk`)이 생겼다.
옛 감사 행은 `request_id`가 비어 있다. CHECK가 문장을 거부하는 것(관리자가 아닌데 위임, 모르는 행위)은 통합 시험이 본다.

## 3. 자동 검사

| 항목 | 값 | 비고 |
|---|---|---|
| shared 테스트 | **319건** (Phase 10 종료 306) | 위임 규칙, `LOG_EVENTS` 모양, 위임 DTO |
| api 테스트 | **889건** (Phase 10 종료 859) | 요청 식별자 모양·접근 로그 판정(A), 미들웨어, 로거 문맥·event 줄, 감사 `request_id`(트랜잭션 안에서도), 위임 API·DB CHECK·사내 계정 동기화, 위임받은 관리자의 LLM 관리 |
| web 테스트 | **94건** (Phase 10 종료 91) | 사용자 관리의 위임 체크(컴포넌트 시험 3) |
| E2E | **30건 전부 통과** (1.8분) | +2 (`e2e/ops.spec.ts`) |
| skip | **0건** | |
| `pnpm check` | 종료 코드 0 (142초) | lint + typecheck + test + `verify:docs`(문서 56개, 위반 없음 — 7번 검사: `LOG_EVENTS` 32개가 장애대응 가이드에 모두 있다) |
| CI (GitHub Actions) | 8절 뒤에 적는다 | |

### 커버리지 (`pnpm test:cov`, 관문 통과 — 종료 코드 0)

| 범위 | 줄 | 분기 | 기준 |
|---|---|---|---|
| shared 전체 | 99.85% | 96.55% | A ≥ 90 |
| └ `permissions.ts`·`constants.ts`·`schemas.ts` | 100% | 100% | |
| api `common/domain` (A) — `request-id.ts`·`access-log.ts` | 100% | 100% | A ≥ 90 (T-047 — 이제 관문 안) |
| api `common` (B) | 99.28% | 92.17% | B ≥ 70 |
| └ `logger.ts` | 100% | 97.05% | |
| └ `request-context.ts`·`log-line.ts` | 100% | 100% | |
| └ `request-log.middleware.ts` | 94.11% | 73.33% | 빠진 것은 기본 시계 인자 — 시험은 시계를 넘긴다 |
| api `audit/audit.service.ts` | 100% | 96.77% | |
| api `auth/auth.guard.ts` | 93.18% | 89.28% | |
| api `auth/auth.service.ts` | 97.26% | 80.43% | |
| api `users/users.service.ts` | 86.53% | 81.52% | 빠진 줄은 앞 Phase의 관리자 직접 생성·강제 종료(E2E가 본다). 위임(`changeGrants`)은 통합 시험 안이다 |
| api `llm/providers.service.ts` | 97.77% | 88.23% | |
| api 전체 | 95.15% | 89.60% | B ≥ 70 |
| web 전체 | 90.67% | 84.65% | 기록만 (3절). Phase 10의 95.02%에서 내려간 것은 컴포넌트 시험이 처음 들인 `AdminUsersPage.tsx`(63.63%)·`auth.tsx`(57.69%)가 측정에 들어서다 |

`users.module.ts`(위임 API의 배선)는 측정 밖이다(`*.module.ts` 제외) — 배선은 E2E와 2.6이 본다.

**A등급 관문 (T-047)** — `apps/api/vitest.config.ts`의 A등급 임계값이 domain 디렉토리를 하나씩 열거해 `common/domain`이 빠져 있었다.
`src/**/domain/**` 한 줄로 바꿨다. `common/domain`의 시험을 빼고 돌리면 바꾸기 전에는 그 파일이 오류 목록에 **없고**, 바꾼 뒤에는
`src/common/domain/access-log.ts`·`request-id.ts`를 포함해 domain 파일 열 개가 전부 나온다. 바꾼 설정으로 `pnpm test:cov`를 다시 돌려 통과했다.

### A등급 테스트 선행 (3절)

Red 커밋을 그 판 그대로 꺼내(`git worktree`) 단위 시험만 돌려 실패를 셌다.

| Red 커밋 | 무엇 | 그 판에서 | 뒤따른 구현 |
|---|---|---|---|
| `af3010e` | 위임 규칙(`can`·`grantsForRole`·`DELEGABLE_ACTIONS`)·`LOG_EVENTS`·위임 DTO·요청 식별자 모양·접근 로그 판정 | shared **12 실패** / 307 통과, api `common/domain` 시험 파일 2개 **적재 실패**(`Cannot find module './access-log'`·`'./request-id'`) | `f8b3077` |

## 4. 브라우저 — E2E (`e2e/ops.spec.ts`)

| 시험 | 본 것 |
|---|---|
| 시스템 관리자가 관리자에게 LLM 연결 관리를 주면 그 관리자가 LLM을 등록한다 — 거두면 다음 요청부터 막힌다 | 처음에는 관리자에게 "LLM 연결" 메뉴가 없다 → root가 사용자 관리의 체크를 켠다 → **그 PUT 응답의 `X-Request-Id`가 감사 행의 `request_id`와 같다**, 감사 detail `before: [] → after: ["llm.manage"]` → 관리자가 새로 고치면 메뉴가 생기고 LLM을 등록한다 → root가 끈다 → 관리자가 새로 고치면 `권한이 없다`, 메뉴가 사라진다 |
| 요청마다 번호가 붙는다 | 모양이 맞는 번호는 그대로, `bad id "x"`는 새 UUID, 없으면 새 UUID |

전체 30건이 통과했다 — 로그 부르는 자리 35곳과 모든 요청이 지나는 첫 미들웨어를 바꿨으므로 앞 Phase의 흐름도 함께 봤다.

## 5. 이미지와 기동

```
$ docker compose -f deploy/compose.yml --env-file deploy/.env build api     # 47초
workfluence-app:7a03a36-p11  380MB
```

| 항목 | 값 |
|---|---|
| app 이미지 | **380MB** (Phase 10은 379MB. 예산 400MB 대비 여유 20MB) — 새 운영 의존성이 없다. 시작 스크립트는 한 파일 |
| 기동 | `up -d api nginx` → 컨테이너 안 `/api/health` 200까지 3초(postgres는 이미 떠 있었다). `restart api`는 11초 |
| 기동 로그 | `app.started` event 한 줄과 Nest의 적재 줄 — 경고·오류 0. 운영은 기동 때 마이그레이션하지 않아 `app.migrated`가 없다(개발 `:3100`에는 있다) |
| 재시작 | 세 컨테이너 모두 0회 |

## 6. 개발 서버(`:3100`)의 로그

E2E 전체(30건) 동안 `.local/logs/api-3100.log`에 남은 것:

| 확인 | 값 |
|---|---|
| `http.request` | 649줄 |
| 수준 | info 782 · **warn 4** · error 0 |
| warn 넷 | `collab.gate_refused` 3(`rule: owner`·`structure`·`structure` — 조작한 연결을 보내는 E2E) · `collab.save_invalid` 1(남은 옛 상태 E2E). **E2E가 일부러 만든 것뿐이다.** 줄마다 `pageId`·`userId`와 까닭(`reason`·`errors`)이 필드로 있고 문서 본문은 없다 |
| event 없는 warn·error | 0 |
| 위임을 거둔 뒤의 관리자 요청 | `"route":"/api/llm/admin/providers","status":403` 한 줄 |
| 로그 한 줄 모양(`wf.log-line`)이 날것으로 찍힌 줄 | 0 — 통합 시험의 출력에는 그 모양이 보이는데, 시험 앱이 pino 로거가 아니라 Nest의 기본 로거를 써서다(운영 배선과 다르다) |

## 7. 보류 결정 처리

| # | 처리 |
|---|---|
| 29 | **트리거를 "폐쇄망 반입 뒤 현장에서"로 바꿨다**(사용자 결정). 현장 절차는 반입 가이드 10절, https의 사내 CA는 파일 하나(2.5) |
| 30 | 그대로 — 사용자가 뜻을 물었고 정하지 않았다 |
| 확인 필요 F | **닫았다** — root가 메인, 관리자 한 사람씩 위임(2.6·4절) |
| 8 | 닫힌 그대로 — 수집기를 붙일 모양(JSON 한 줄·`requestId`·`event`)을 갖췄다 |

## 8. 검토

병합 전에 돌린다. 결과와 처리는 검토서에 모은다.

## 9. 확인하지 못한 것

- **사내 LLM·사내 IdP 실연동** — 가짜 https LLM과 시험용 CA로만 봤다. 현장의 사내 CA가 중간 기관을 두는지, IdP(OIDC)가 같은 파일로
  믿어지는지는 현장에서 본다 → 보류 29·11
- **로그가 실제로 넘어가는 것** — 설정(2.4)만 봤다. 20MB가 차서 다음 파일로 넘어가고 다섯 개를 넘으면 지워지는 것은 도커의 동작이라 재지 않았다
- `http.unhandled`(처리되지 않은 예외)는 컨테이너에서 일으켜 보지 않았다 — 로거 시험(`logger.spec.ts`)이 Nest의 `ExceptionsHandler` 줄을
  그 event로 바꾸는 것을 본다
- **실시간 편집(WebSocket) 로그에는 `requestId`가 없다** — 설계대로다(D.8). 연결 단위 필드(`pageId`·`userId`)로 잇는다
- 브라우저에서 난 오류는 서버로 오지 않는다(D.8)
- 사내 계정 동기화에서 관리자가 member가 되어 위임이 사라지는 것은 통합 시험(모의 클레임)으로만 봤다 — 실제 IdP는 보류 11
- **HSTS 머리말이 두 번 나간다** — nginx(server 단계)와 앱(`WF_ENV=production`)이 같은 값을 붙인다. Phase 11 전부터 그랬다(`main`의
  nginx.conf에도 server 단계 HSTS가 있다). 브라우저는 첫 것만 쓰고(RFC 6797 8.1) 두 값이 같아 영향이 없어 이번에 고치지 않았다
