# P11 검증기록 — Ops (운영 로그 · LLM 관리 위임 · 사내 LLM 반입 설정)

- 작성일: 2026-09-26 / 작성 LLM: Claude Opus 5.5
- 설계: [`docs/P11_설계서_Ops.md`](P11_설계서_Ops.md) · 검토: [`docs/internal/P11_검토서_Review.md`](internal/P11_검토서_Review.md)
- 요청 원문과 착수 쟁점의 답: `docs/prompts/phase11/scope.md`
- 시행착오는 여기 쓰지 않는다 — [`docs/internal/검토서_트러블슈팅.md`](internal/검토서_트러블슈팅.md) T-047(A등급 관문이 새 domain 디렉토리를 빠뜨림)·T-048(접근 로그가 라우터와 다르게 가정함)·T-049(반입 뒤 `ca/`가 root 소유, `up -d`가 파일을 알아채지 못함)·T-050(LLM E2E의 정리가 흐르던 답의 저장과 겹침)
- 시험·커버리지·E2E(3·4절)는 **병합 전 검토와 종료 루틴을 반영한 뒤** `91e0e6a`에서 쟀다. 컨테이너 확인은 세 번 했다 — 처음
  `workfluence-app:7a03a36-p11`(2.1~2.4·2.6·2.7), 검토 반영 뒤 `554a3f8-p11`(2.5를 **가이드의 명령 그대로** 다시, 2.8~2.10), 종료 루틴 반영 뒤
  `91e0e6a-p11`(2.11 — 기동과 관리의 우열). 반영이 닿지 않은 것(요청 번호 잇기·로그 순환·마이그레이션)은 처음 것을 둔다
- 이 세션도 **이 계정 소유의 사본**에서 일했다(T-040·T-042). 새 빌드는 `:3100`에 띄우고 `E2E_BASE_URL`로 E2E를 돌렸다. 개발 DB(`:5433`)는
  앞 계정과 함께 쓴다 — `:3100`이 기동할 때 `0010`이 개발 DB에 적용됐다(옛 빌드 `:3000`은 새 열을 모르지만 기본값이 있어 막히지 않는다)

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
| 디스크 | 빌드 전 `/` 여유 14GB·13GB (전체 39GB) |

## 2. 컨테이너 — nginx를 거친 요청

스택: `up -d postgres` → `run --rm api node dist/db/migrate.js` → `up -d api nginx`. 호스트에서 nginx(TLS, 8443)로 부른다. **TLS 검증을
끄지 않았다** — 호스트의 curl은 개발용 자가서명 인증서를 CA로 믿고(`--cacert`), 앱은 2.5의 CA 파일로 믿는다. 계정은 합성(`p11-root`·
`p11-admin`·`p11-plain`)으로 컨테이너 DB에 직접 만들고 끝나고 지웠다.

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

검토 반영 뒤(`554a3f8-p11`)에 같은 요청으로 다시: nginx 1줄·앱 1줄(`"route":"/api/users/:id/grants","status":200`)·감사 행 1 — 2.10.

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

### 2.5 사내 CA 파일 — 반입 가이드 10절의 명령 그대로 (FR-1221·1222, 보류 29)

위임받은 관리자(`p11-admin`)가 `https://wf-mock-llm:8443/v1`을 등록하고 연결 확인을 눌렀다. compose는 한 줄도 고치지 않았다.
**처음 확인은 `docker compose restart api`로 했다 — 가이드에 적은 명령(`up -d api`)과 달랐다**(T-049). 검토 반영 뒤 가이드의 ②·③을
적힌 그대로(묶음을 푼 디렉토리에 해당하는 `deploy/`에서, 이미지 태그만 `WF_APP_IMAGE`로 이 Phase의 것) 다시 돌렸다.

| 단계 | 앱 프로세스(PID 1)의 `NODE_EXTRA_CA_CERTS` | 연결 확인 |
|---|---|---|
| `ca/ca.pem` 없음 | 없다 | `{"ok":false,"message":"LLM 서버에 닿지 않는다 (UNABLE_TO_VERIFY_LEAF_SIGNATURE)"}` |
| ② `mkdir -p ca` · `cp <인증서> ca/ca.pem` 뒤 **옛 ③** `up -d api` | 없다 — compose가 `Container workfluence-api Running`만 말하고 다시 만들지 않았다 | 여전히 `UNABLE_TO_VERIFY_LEAF_SIGNATURE` |
| **③ `up -d --force-recreate api`** | `/etc/workfluence/ca/ca.pem` | **`{"ok":true,"models":["mock-p11"],"modelFound":true}`** — 가짜 LLM이 `GET /v1/models`를 받았다 |
| `ca.pem`을 지우고 `--force-recreate` | 없다 | 닿지 않는다 |

- 확인 명령은 가이드 문제 표의 것 그대로다: `docker exec workfluence-api sh -c 'tr "\0" "\n" < /proc/1/environ | grep NODE_EXTRA_CA_CERTS'`
- 기동 경고(`extra certs`)·경고·오류 줄 0. **빈 파일**은 처음 확인에서 봤다 — 붙이지 않고 경고도 없다(시작 스크립트의 `-s`)
- `git status`에 `ca.pem`이 나오지 않는다(`.gitignore`)
- **기관 여럿을 한 파일에** — 같은 Node(v24.21.0)로 호스트에서: 다른 CA를 앞에, 시험용 CA를 뒤에 이어 붙인 파일이면 200, 다른 CA만이면
  `UNABLE_TO_VERIFY_LEAF_SIGNATURE`, 없으면 같은 오류. `deploy/ca/README.md`의 "한 파일에 이어 붙인다"가 맞다

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
옛 감사 행은 `request_id`가 비어 있다. CHECK가 문장을 거부하는 것(관리자가 아닌데 위임, 모르는 행위)과 CHECK의 목록이 코드의
`DELEGABLE_ACTIONS`와 같은 것은 통합 시험이 본다. 검토 반영에는 마이그레이션이 없다.

### 2.8 감사 행을 요청 번호로 거르는 비용 — 인덱스를 두지 않는 근거 (A.1-18)

시험 DB에 합성 감사 행 **100만 건**(`request_id` 90%, 30초 간격 — 약 1년)을 넣고(11.6초, 표 198MB) 관리 화면과 같은 질의
(`WHERE request_id = … ORDER BY created_at DESC LIMIT 200`, 사용자 표와 조인)를 세 번씩 쟀다.

| 찾는 번호 | 실행 시간(ms, 세 번) | 계획 |
|---|---|---|
| 최근 행(1시간 전) | 79.3 · 76.1 · 86.2 | `Parallel Seq Scan on audit_events` |
| 오래된 행(약 1년 전) | 111.5 · 130.9 · 133.4 | 같다 |
| 없는 번호 | 119.2 · 66.1 · 66.8 | 같다 |

목표(1초) 안이다. 300명 규모에서 감사 행이 1,000만 건에 가까워지거나 거르기가 1초를 넘으면 부분 인덱스를 둔다(설계서 A.1-18).

### 2.9 반입 묶음 — 사내 CA 자리 (T-049)

```
$ pnpm release:bundle .local/release/p11-check       # WF_APP_IMAGE=workfluence-app:554a3f8-p11
[release] 이미지 저장 중… (workfluence-app:554a3f8-p11, nginx:1.27-alpine, postgres:17)
[release] 완료 — 10개 파일 · 263MB
$ pnpm release:verify .local/release/p11-check
[verify] 통과 — 필수 10개 · 체크섬 9개 일치
```

| 확인 | 값 |
|---|---|
| 묶음을 tar로 묶어 가이드 1절대로 풀기(`tar -xf … --strip-components=1`) → `sha256sum -c SHA256SUMS` | 9줄 모두 `OK` — `ca/README.md: OK` 포함 |
| 풀린 `ca/`의 주인 | **푼 계정**(`drwxr-xr-x. … <계정> <계정> … ca`) — 그 계정으로 `ca/ca.pem`을 만든다. 없던 옛 묶음이면 도커가 root로 만든다(실측 — T-049) |
| 묶음에서 `ca/README.md`를 빼고 `release:verify` | **실패 2건** — `ca/README.md: 필수 파일이 없다` · `ca/README.md: 묶음에 없다`. 되돌리면 통과 |

실제 반입의 이미지 태그는 compose의 기본값(`workfluence-app:latest`)이다 — 이 확인만 이 Phase의 이미지를 고르려고 `WF_APP_IMAGE`를 줬다.
만든 묶음·tar·푼 사본(약 800MB)은 확인 뒤 지웠다.

### 2.10 검토 반영의 확인 — nginx를 거쳐 (`554a3f8-p11`)

| 확인 | 결과 |
|---|---|
| 감사 조회 `GET /api/audit?requestId=%20<번호>%20`(앞뒤 공백) | **1행** — `user.grants.change`, `requestId`가 그 요청의 번호, `detail` `before: [] → after: ["llm.manage"]`. 모양이 틀린 번호(`bad id`)는 **400** |
| 같은 위임 목록을 다시 PUT | 200, 그 요청의 감사 행 **0** (A.1-15) |
| 위임 없는 관리자(`p11-plain`) → 위임받은 관리자에게 `reset-password`·`unlock`·`terminate-sessions`·`role` | **403 넷** `이 사용자를 관리할 권한이 없다`. 대상은 `admin \| {llm.manage}` 그대로 (FR-1207, 보안 검토 1) |
| 없는 주소 `GET /api/definitely-not-a-route/x?q=비밀P11` | 404 · 앱 로그 `"route":null,"status":404,…,"path":"/api/definitely-not-a-route/x"` — 틀(`{*any}`)이 아니라 경로 (T-048) |
| 대문자 `GET /API/auth/me` | 200 · 앱 로그에 **남는다** `"route":"/api/auth/me","status":200` (T-048) |
| 질의 문자열이 앱 로그에 | 0건 |
| 기동 | `up -d api nginx` → 헬스체크 200까지 2초(postgres는 이미 떠 있었다). 경고·오류 줄 0, 재시작 0 |

### 2.11 최종 이미지 (`91e0e6a-p11`) — 종료 루틴 반영 뒤

| 확인 | 결과 |
|---|---|
| 기동 | `up -d api nginx` → 헬스체크 200까지 3초. 경고·오류 줄 0 |
| 위임 없는 관리자 → 위임받은 관리자의 비밀번호 초기화 | **403** |
| root → 위임받은 관리자의 비밀번호 초기화 | 201 |
| 위임 없는 관리자 → root의 역할 변경 | **403** `이 사용자를 관리할 권한이 없다` |

마지막 root의 줄 세우기(두 root를 동시에 내리기)와 관리 대상의 행 잠금은 통합 시험과 변이(3절)로 봤다 — 컨테이너에서 두 요청의 시각을 맞추지는
않았다.

## 3. 자동 검사

| 항목 | 값 | 비고 |
|---|---|---|
| shared 테스트 | **326건** (Phase 10 종료 306) | 위임 규칙·관리의 우열, `LOG_EVENTS` 모양, 요청 번호의 모양, 위임 DTO·감사 조회 DTO, 묶음의 사내 CA 자리 |
| api 테스트 | **907건** (Phase 10 종료 859) | 요청 식별자 모양·접근 로그 판정(A — 전체 잡기 라우트·대소문자 포함), 사내 IdP 실패의 부류(A), 미들웨어, 로거 문맥·event 줄, 감사 `request_id`와 거르기, 위임 API·DB CHECK·CHECK와 코드의 목록·사내 계정 동기화, 관리의 우열, **동시성 다섯**(행 잠금 셋·판정과 쓰기 사이의 위임·마지막 root), 사내 IdP 실패 넷(닿지 않음·jose의 거절·우리가 판정한 거절·state 불일치 — 콜백의 실패는 감사), 위임받은 관리자의 LLM 관리 |
| web 테스트 | **98건** (Phase 10 종료 91) | 사용자 관리의 위임 체크·관리할 수 없는 행(컴포넌트 시험 4), 감사로그의 요청 번호 거르기(3) |
| E2E | **30건 전부 통과** (1.9분) | +2 (`e2e/ops.spec.ts`). **간헐 실패 둘을 고쳤다** — ① `admin.spec.ts`의 감사로그 거르기가 거른 응답을 기다리지 않고 첫 목록을 읽었다(`554a3f8`) ② `llm.spec.ts`의 마지막 시험이 답이 흐르는 중에 끝나, 서버가 받은 데까지 저장한 새 대화가 뒤의 정리와 겹쳤다(T-050, `91e0e6a`) — 실패한 실행마다 개발 DB에 그 사용자가 남아 있었다. 고친 뒤 그 파일만 네 번 되풀이해 20건, 전체 30건 |
| skip | **0건** | |
| `pnpm check` | 종료 코드 0 (158초) | lint + typecheck + test + `verify:docs`(문서 58개, 위반 없음 — 7번 검사: `LOG_EVENTS` 33개가 장애대응 가이드에 모두 있다) |
| CI (GitHub Actions) | **`check`·`gitleaks` 통과** — `91e0e6a`(코드의 마지막 커밋, push·pull_request 두 실행) | `check`는 `test:cov`·`verify:docs`·취약점·라이선스·빌드·외부 URL 검사까지. 실패한 것은 **Red 셋**(`4c18ad3`·`015ddce`·`043f72e` — 의도)과, event 코드를 더하고 가이드를 고치기 전의 둘(`fec440a`·`554a3f8` — `verify:docs`만: `auth.oidc_failed — LOG_EVENTS에 있는데 장애대응 가이드가 모른다`). 이 문서를 담은 마지막 커밋의 결과는 PR에 적는다 |

### 커버리지 (`pnpm test:cov`, 관문 통과 — 종료 코드 0)

| 범위 | 줄 | 분기 | 기준 |
|---|---|---|---|
| shared 전체 | 99.85% (701/702) | 96.59% (625/647) | A ≥ 90 |
| └ `permissions.ts`·`constants.ts`·`schemas.ts`·`release.ts` | 100% | 100% | |
| api `common/domain` (A) — `request-id.ts`·`access-log.ts` | 100% | 100% | A ≥ 90 (T-047 — 이제 관문 안) |
| api `auth/domain/idp-failure.ts` (A) | 100% | 100% | A ≥ 90 |
| api `common` (B) | 99.28% | 92.17% | B ≥ 70 |
| └ `logger.ts` | 100% | 97.05% | |
| └ `request-context.ts`·`log-line.ts`·`revocation.bus.ts` | 100% | 100% | |
| └ `request-log.middleware.ts` | 94.11% | 73.33% | 빠진 것은 기본 시계 인자 — 시험은 시계를 넘긴다 |
| api `audit/audit.service.ts` | 100% | 96.96% | |
| api `auth/auth.guard.ts` | 93.18% | 89.28% | |
| api `auth/auth.service.ts` | 97.59% | 83.92% | |
| api `users/users.service.ts` | 93.10% | 90.52% | 검토 반영 전 86.53%·81.52% — 관리의 우열·동시성 시험이 초기화·잠금 해제·세션 종료·마지막 root를 지난다 |
| api `mail/mention-mail.service.ts`·`mail/mock.sender.ts` | 100% | 100% | |
| api `llm/providers.service.ts` | 97.77% | 88.23% | |
| api 전체 | 95.43% (2488/2607) | 90.10% (1939/2152) | B ≥ 70. 분기는 실행마다 0.1%p 안에서 갈린다(종료 루틴 자체 점검 7 — 다른 실행은 89.9%) |
| web 전체 | 90.52% | 83.25% | 기록만 (3절). Phase 10의 95.02%에서 내려간 것은 컴포넌트 시험이 처음 들인 `AdminUsersPage.tsx`(66.66%)·`AdminAuditPage.tsx`(87.5%)·`auth.tsx`가 측정에 들어서다 |

`users.module.ts`(위임 API의 배선)는 측정 밖이다(`*.module.ts` 제외) — 배선은 E2E와 2.6·2.10이 본다.

**A등급 관문 (T-047)** — `apps/api/vitest.config.ts`의 A등급 임계값이 domain 디렉토리를 하나씩 열거해 `common/domain`이 빠져 있었다.
`src/**/domain/**` 한 줄로 바꿨다. `common/domain`의 시험을 빼고 돌리면 바꾸기 전에는 그 파일이 오류 목록에 **없고**, 바꾼 뒤에는
`src/common/domain/access-log.ts`·`request-id.ts`를 포함해 domain 파일 열 개가 전부 나온다. 바꾼 설정으로 `pnpm test:cov`를 다시 돌려 통과했다.

### A등급 테스트 선행 (3절)

`af3010e`는 그 판을 그대로 꺼내(`git worktree`) 단위 시험만 돌려 다시 셌다. 검토 반영의 두 Red는 커밋하기 직전의 작업 트리(= 그 커밋)에서 셌다.

| Red 커밋 | 무엇 | 그 판에서 | 뒤따른 구현 |
|---|---|---|---|
| `af3010e` | 위임 규칙(`can`·`grantsForRole`·`DELEGABLE_ACTIONS`)·`LOG_EVENTS`·위임 DTO·요청 식별자 모양·접근 로그 판정 | shared **12 실패** / 307 통과, api `common/domain` 시험 파일 2개 **적재 실패**(`Cannot find module './access-log'`·`'./request-id'`) | `f8b3077` |
| `4c18ad3` | 검토 반영 — 묶음의 사내 CA 자리·`auth.oidc_failed`·요청 번호 모양 공유·감사 조회 거르기·전체 잡기 라우트 | shared **7 실패** / 318 통과, api `common/domain` **1 실패** / 11 통과 | `e2ffff6` |
| `015ddce` | 보안 검토 반영 — 자기에게 없는 위임을 가진 관리자는 관리하지 못한다·접근 로그는 대소문자를 가리지 않는다 | shared **2 실패** / 324 통과, api `common/domain` **1 실패** / 12 통과 | `fec440a` |
| `043f72e` | 종료 루틴 반영 — 사내 IdP 실패를 거절·닿지 않음으로 가른다(`idpFailureKind`) | api `auth/domain/idp-failure.spec.ts` **적재 실패**(`Cannot find module './idp-failure'`) | `d315a49` |

### 시험이 정말 잡는가 — 변이와 재현

| 지운 것·되돌린 것 | 결과 |
|---|---|
| 행 잠금(`lockForUpdate`의 `.for('update')`) | 동시성 시험 **셋 모두 실패**(역할 변경·위임끼리·사내 계정 동기화가 그 사이의 위임을 덮는다). 되돌리자 통과 |
| 마지막 root를 줄 세우는 이름 잠금(`pg_advisory_xact_lock`) | "root 둘을 동시에 내려도 root가 남는다"가 **실패**(root가 0명). 되돌리자 통과 |
| 관리 대상의 행 잠금(`getManaged`가 잠그지 않고 읽게) | "판정과 쓰기 사이에 위임을 받아도 위임 없는 관리자는 초기화하지 못한다"가 **실패**(초기화가 된다). 되돌리자 통과 |
| 시드의 위임 비우기(시험 DB, `WF_ROOT_USERNAME`을 위임받은 관리자로) | 지우면 `[seed] 실패: … users_grants_admin_chk`, 계정은 `admin \| {llm.manage}` 그대로. 되돌리면 `[seed] root 계정 보정: … role, grants, approvedAt` → `root \| {}` |

## 4. 브라우저 — E2E (`e2e/ops.spec.ts`)

| 시험 | 본 것 |
|---|---|
| 시스템 관리자가 관리자에게 LLM 연결 관리를 주면 그 관리자가 LLM을 등록한다 — 거두면 다음 요청부터 막힌다 | 처음에는 관리자에게 "LLM 연결" 메뉴가 없다 → root가 사용자 관리의 체크를 켠다 → **그 PUT 응답의 `X-Request-Id`가 감사 행의 `request_id`와 같다**, 감사 detail `before: [] → after: ["llm.manage"]` → 관리자가 새로 고치면 메뉴가 생기고 LLM을 등록한다 → root가 끈다 → 관리자가 새로 고치면 `권한이 없다`, 메뉴가 사라진다 → **관리 화면의 감사로그에 그 번호를 붙여(앞뒤 공백째) 거르면 그 행 하나**(`1건`) |
| 요청마다 번호가 붙는다 | 모양이 맞는 번호는 그대로, `bad id "x"`는 새 UUID, 없으면 새 UUID |

전체 30건이 통과했다 — 로그 부르는 자리 35곳과 모든 요청이 지나는 첫 미들웨어, 사용자 관리·감사로그 화면을 바꿨으므로 앞 Phase의 흐름도 함께 봤다.

## 5. 이미지와 기동

```
$ docker compose -f deploy/compose.yml --env-file deploy/.env build api
workfluence-app:554a3f8-p11  380MB     # 46초
workfluence-app:91e0e6a-p11  380MB     # 최종
```

| 항목 | 값 |
|---|---|
| app 이미지 | **380MB** (Phase 10은 379MB. 예산 400MB 대비 여유 20MB) — 새 운영 의존성이 없다. 시작 스크립트는 한 파일 |
| 기동 | `up -d api nginx` → 헬스체크 200까지 2~3초(postgres는 이미 떠 있었다, 세 번 모두). `restart api`는 11초 |
| 기동 로그 | `app.started` event 한 줄과 Nest의 적재 줄 — 경고·오류 0. 운영은 기동 때 마이그레이션하지 않아 `app.migrated`가 없다(개발 `:3100`에는 있다) |
| 재시작 | 세 컨테이너 모두 0회 (세 번 모두) |

## 6. 개발 서버(`:3100`)의 로그

검토 반영 뒤의 빌드(`554a3f8`)로 E2E 전체를 두 번 돌리는 동안(첫 번은 1건 실패 — 3절) `.local/logs/api-3100.log`에 남은 것:

| 확인 | 값 |
|---|---|
| `http.request` | 1,338줄 |
| 수준 | info 1,471 · **warn 8** · error 0 |
| warn 여덟 | `collab.gate_refused` 6 · `collab.save_invalid` 2 — 한 번에 3·1, 조작한 연결과 남은 옛 상태를 **E2E가 일부러 만든 것뿐이다.** 줄마다 `pageId`·`userId`와 까닭(`reason`·`errors`)이 필드로 있고 문서 본문은 없다 |
| event 없는 warn·error | 0 |
| 맞춘 라우트가 없는 줄 | 2 — `"route":null,"status":404,…,"path":"/api/unknown"`(헬스 E2E의 "`/api`는 폴백에서 뺀다"). 검토 반영 전에는 `{*any}`로 남았을 줄이다 |
| 로그 한 줄 모양(`wf.log-line`)이 날것으로 찍힌 줄 | 0 — 통합 시험의 출력에는 그 모양이 보이는데, 시험 앱이 pino 로거가 아니라 Nest의 기본 로거를 써서다(운영 배선과 다르다) |

## 7. 보류 결정 처리

| # | 처리 |
|---|---|
| 29 | **트리거를 "폐쇄망 반입 뒤 현장에서"로 바꿨다**(사용자 결정). 현장 절차는 반입 가이드 10절, https의 사내 CA는 파일 하나(2.5·2.9) |
| 30 | 그대로 — 사용자가 뜻을 물었고 정하지 않았다 |
| 확인 필요 F | **닫았다** — root가 메인, 관리자 한 사람씩 위임(2.6·4절). 위임받은 관리자의 계정 일은 root와 같은 위임을 가진 관리자만(2.10 — 위임 없는 관리자는 403, 같은 것을 가진 관리자·root는 통합 시험) |
| 8 | 닫힌 그대로 — 수집기를 붙일 모양(JSON 한 줄·`requestId`·`event`)을 갖췄다 |

## 8. 검토

병합 전에 셋을 돌렸다. 결과와 처리는 [`docs/internal/P11_검토서_Review.md`](internal/P11_검토서_Review.md)에 있다.

| 검토 | 결과 | 처리 |
|---|---|---|
| `self-reviewer` | 11건 (높음 1 · 보통 3 · 낮음 7) | 10건 반영, 1건(인덱스) 실측으로 두지 않음 |
| 코드 리뷰 (`/code-review high`, PR #10) | 10건 | 10건 반영(둘은 일부 — 인덱스와 위임 대상의 상태는 까닭을 적고 두지 않음) |
| 보안 검토 (`general-purpose`) | MEDIUM 1 · LOW 1 + 문턱 아래 4 | 둘 다 반영, 문턱 아래는 1건 반영·1건 MEDIUM으로 막힘·2건 까닭을 적고 두지 않음 |
| 종료 루틴 — `doc-consistency` · `self-reviewer` (반영분에) | 14건 + 변경 밖 4건 · 9건(보통 1) | 문서 정합성 13건 반영·1건 두었다, 자체 점검 9건 반영 — 검토서 §5 |

## 9. 확인하지 못한 것

- **사내 LLM·사내 IdP 실연동** — 가짜 https LLM과 시험용 CA로만 봤다. 현장의 사내 CA가 중간 기관을 두는지, IdP(OIDC)가 같은 파일로
  믿어지는지는 현장에서 본다 → 보류 29·11
- **사내 IdP 실패의 모습**(`auth.oidc_failed`·502)은 통합 시험의 가짜 제공자(닿지 않음·거절)로만 봤다 — 컨테이너는 OIDC가 꺼져 있다.
  실제 IdP가 내는 오류 문장·코드는 현장에서 본다 → 보류 11
- **로그가 실제로 넘어가는 것** — 설정(2.4)만 봤다. 20MB가 차서 다음 파일로 넘어가고 다섯 개를 넘으면 지워지는 것은 도커의 동작이라 재지 않았다
- `http.unhandled`(처리되지 않은 예외)는 컨테이너에서 일으켜 보지 않았다 — 로거 시험(`logger.spec.ts`)이 Nest의 `ExceptionsHandler` 줄을
  그 event로 바꾸는 것을 본다
- **실시간 편집(WebSocket) 로그에는 `requestId`가 없다** — 설계대로다(D.8). 연결 단위 필드(`pageId`·`userId`)로 잇는다
- **세션 저장소(connect-pg-simple)의 정리 타이머는 첫 요청의 문맥 안에서 걸린다**(보안 검토 후보 4). 지금 그 타이머의 로그는
  `console.error`로 가서 우리 로거를 지나지 않아 영향이 없다. 그 로그를 pino에 잇는 날에는 첫 요청의 번호가 계속 찍힐 것이라, 그때 문맥 밖에서
  걸게 한다
- 브라우저에서 난 오류는 서버로 오지 않는다(D.8)
- 사내 계정 동기화에서 관리자가 member가 되어 위임이 사라지는 것과, 동기화가 그 사이의 위임을 덮지 않는 것은 통합 시험(모의 클레임)으로만
  봤다 — 실제 IdP는 보류 11
- **HSTS 머리말이 두 번 나간다** — nginx(server 단계)와 앱(`WF_ENV=production`)이 같은 값을 붙인다. Phase 11 전부터 그랬다(`main`의
  nginx.conf에도 server 단계 HSTS가 있다). 브라우저는 첫 것만 쓰고(RFC 6797 8.1) 두 값이 같아 영향이 없어 이번에 고치지 않았다
