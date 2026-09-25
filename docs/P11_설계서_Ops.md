# P11 설계서 — Ops (운영 로그 · LLM 관리 위임 · 사내 LLM 반입 설정)

Phase 11은 Phase 10이 남긴 네 가지에 대한 사용자의 답(2026-09-26)을 만든다. 요청 원문은 `docs/prompts/phase11/scope.md`,
요구사항 번호는 **FR-1200**, 비기능은 **NFR-110**부터다.

- **기능백로그 F-003** — 운영 로그를 디버깅·유지보수할 수 있게(요청 식별자·접근 로그·event 코드·로그 순환·nginx 로그 형식·규칙)
- **기능백로그 F-004**(확인 필요 F의 답) — 시스템 관리자(root)가 관리자(admin)에게 LLM 연결 관리를 위임한다
- **보류 29**의 방향 — 사내 LLM은 폐쇄망 반입 뒤 현장에서 설정한다. 그 절차를 쉽게 적는다

선행: [`docs/P10_검증기록_Llm.md`](P10_검증기록_Llm.md) · 구조: [`docs/설계서_Architecture.md`](설계서_Architecture.md)

> **경로에 백틱이 없는 것은 아직 만들지 않은 것이다** (4.1절). 만들면 붙인다.

---

## A. 착수 쟁점 (사용자 결정 2026-09-26)

| # | 쟁점 | 사용자의 답 | 이 설계에서의 뜻 |
|---|---|---|---|
| 1 | 보류 29 — 사내 LLM 실연동을 언제·어떻게 | "사내 LLM은 폐쇄망에 반입해서 설정할거라, 설정 방법만 쉽게 적어놔." | 개발 서버에서 실연동하지 않는다. 반입 현장의 절차를 `docs/운영가이드_반입.md`에 **쉽게** 적는다(C.3). 쉽게 하려면 현장에서 compose를 고치지 않아야 한다 — 사내 CA는 파일 하나 두면 믿게 한다(D.7). 보류 29는 "반입 뒤 현장에서"로 트리거를 바꿔 남긴다(J절) |
| 2 | 보류 30 — 질문 빈도 제한 | "질문 빈도 제한이 뭐지?" | **질문이었다.** 대화에서 설명했고 정하지 않았으므로 보류로 남긴다 |
| 3 | 확인 필요 F — LLM 등록을 root만 하나 | "시스템 관리자가 메인 권한을 갖고, 관리자에게 권한을 부여할 수 있도록 만들어줘." | root는 LLM 연결 관리를 **늘** 한다. root가 관리자에게 그 권한을 **주고 거둔다**(C.1) |
| 4 | F-003 로그 개선 | "F-003 로그 개선 이어서 진행해서 완료해줘." | 백로그의 ①~⑥을 전부 한다(C.2) |

## A.1 묻지 않고 정한 것 — 근거와 되돌릴 조건

Phase 10과 같이, 사용자의 답 안에서 Claude가 정했다. **다르게 보면 그 항목만 뒤집는다.**

| # | 정한 것 | 근거 | 되돌릴 조건 · 자리 |
|---|---|---|---|
| 1 | 위임은 **관리자 한 사람씩** — root가 사용자 관리 화면에서 켜고 끈다 | "관리자에게 권한을 부여"는 사람에게 주는 말로 읽었다. 한 사람씩 줄 수 있으면 모두에게 주는 것도 된다(반대는 안 된다) | "관리자 모두에게 한 번에"가 필요하면 운영 설정에 스위치 하나 |
| 2 | 위임할 수 있는 것은 **LLM 연결 관리 하나**(`llm.manage` — 등록·삭제·연결 확인·관리 목록) | 확인 필요 F가 물은 것이 그것이다. 다른 root 전용 일(`system.manage` — 운영 기반)까지 열 까닭이 요청에 없다 | 더 위임할 행위가 생기면 `DELEGABLE_ACTIONS`에 하나 더하고 마이그레이션의 CHECK를 고친다 |
| 3 | **위임은 root만 한다** — 위임받은 관리자가 다시 주지 못한다 | "시스템 관리자가 메인 권한을 갖고" — 주고 거두는 권한이 root에게 남아야 메인이다 | — |
| 4 | 위임은 **관리자만** 받는다. 관리자가 member가 되면(관리 화면의 역할 변경·사내 계정의 역할 동기화) 위임이 **사라진다** — 다시 관리자가 되어도 돌아오지 않는다 | member에게 LLM 관리를 주는 길을 막는다. 돌아오게 하면 거둔 기록 없이 권한이 되살아난다. DB CHECK도 막는다(E절) | — |
| 5 | 위임을 바꾸면 **다음 요청부터** 먹는다 | 가드가 요청마다 사용자를 다시 읽는다(`AuthGuard`) — 세션을 끊을 까닭이 없다 | — |
| 6 | 요청 식별자는 **nginx가 만든다**(`$request_id`, 32자 16진) — 앱은 받은 것이 모양에 맞으면 쓰고, 없거나 틀리면 만든다(UUID) | 요청은 nginx에서 시작한다. nginx 로그와 앱 로그가 같은 값을 가져야 잇는다. 개발처럼 nginx가 없으면 앱이 만든다 | — |
| 7 | 접근 로그는 **앱이** 한 줄씩 남긴다. **헬스체크와 정적 자산은 남기지 않는다** | 경로 틀(`/api/pages/:id`)·사용자·걸린 시간은 앱만 안다. 헬스체크는 20초마다 오고 정적 자산은 nginx 로그에 있다 — 소음이다 | — |
| 8 | 접근 로그의 수준: 5xx는 `warn`, 나머지는 `info` | 401·403·404·409는 정상 흐름이다. 처리되지 않은 예외는 따로 `error` 한 줄(`http.unhandled`)이 있고 같은 `requestId`로 잇는다 | — |
| 9 | event 코드는 **`영역.일`** 두 마디, 소문자·밑줄(`llm.ask_failed`). 목록은 `packages/shared/src/constants.ts`의 `LOG_EVENTS` 한 곳 | 감사 종류(`AUDIT_ACTIONS`)와 같은 판단 — 문장을 고쳐도 코드는 그대로다. 장애대응 가이드가 목록 전부를 안다는 것을 `verify:docs`가 대조한다 | — |
| 10 | 로그 순환: 세 서비스 모두 `json-file`, **20MB × 5개**(서비스마다 최대 100MB, 셋이면 300MB). compose 변수로 바꾼다 | 디스크가 하나다(0.3절). 여유 14GB에서 300MB는 2%다. 하루 로그가 수 MB라 5개면 몇 주를 본다 | 현장 디스크에 맞춰 `WF_LOG_MAX_SIZE`·`WF_LOG_MAX_FILES` |
| 11 | nginx 접근 로그는 **JSON 한 줄**, 질의 문자열과 referer를 싣지 않는다 | 앱과 같은 모양이면 수집기(보류 8) 하나로 읽는다. referer는 질의 문자열(검색어)이 든 앞 주소다 | — |
| 12 | 사내 CA는 **`ca/ca.pem` 파일이 있으면** 앱이 믿는다(`NODE_EXTRA_CA_CERTS`). 없으면 아무 일도 없다 | 현장에서 compose를 고치게 하면 쉽지 않다. 사내 IdP(OIDC)도 같은 길이다 — 7절 "사내 CA는 `NODE_EXTRA_CA_CERTS`" | — |
| 13 | 감사로그 행에 `request_id` **열**을 둔다(`detail`에 넣지 않는다) | `detail`은 행위마다 모양이 다르다. 열이면 거르고 잇기 쉽다 | — |

## B. Confluence 대조 (`CLAUDE.md` 4절)

| Confluence의 것 | 우리 | 왜 |
|---|---|---|
| 전역 권한을 그룹마다 준다(사이트 관리자·제품 관리자 등) | **변형 — 역할 셋 + root가 관리자 한 사람에게 행위 하나를 위임** | 사용자 300명에 관리자는 몇 명이다. 그룹 권한표를 두면 "누가 왜 이 권한을 가졌나"를 표 두 개로 따져야 한다. 행위 하나의 위임이면 사용자 관리 화면 한 칸과 감사로그 한 줄로 끝난다 |
| 접근 로그·감사 로그(데이터 센터판) | **채택 — 앱 접근 로그 + 감사로그, 요청 식별자로 잇기** | 500 한 줄을 누구의 어느 요청인지 이어야 한다(F-003 판단 근거) |

---

## C. 요구사항

### C.1 LLM 관리 위임 (FR-1200 ~ FR-1206)

| # | 요구 | 근거 |
|---|---|---|
| FR-1200 | root는 LLM 연결 관리(등록·삭제·연결 확인·관리 목록)를 **늘** 한다 | A-3 "메인 권한" |
| FR-1201 | root가 관리자 한 사람씩 LLM 연결 관리를 **주고 거둔다** — 사용자 관리 화면 | A-3, A.1-1 |
| FR-1202 | 위임받은 관리자는 LLM 연결 관리를 root와 같게 한다. **다시 주지 못한다** | A.1-3 |
| FR-1203 | 위임은 관리자만 받는다. member·root에게 주면 400. 관리자가 member가 되면 위임이 사라진다(관리 화면·사내 계정 동기화 둘 다) | A.1-4 |
| FR-1204 | 위임을 바꾸면 **다음 요청부터** 먹는다 — 거두면 그 관리자의 LLM 연결 화면이 403 | A.1-5 |
| FR-1205 | 위임을 바꾸면 감사로그 `user.grants.change` — 누구에게·이전·이후. 역할이 바뀌어 위임이 사라지면 역할 변경의 감사 행에 함께 남는다 | 6절 "권한 변경" |
| FR-1206 | 판정은 `packages/shared/src/permissions.ts`의 `can()` 한 곳 — 홈 머리말의 "LLM 연결" 메뉴와 서버의 가드가 같은 함수다 | 7절 |

### C.2 운영 로그 (FR-1210 ~ FR-1219)

| # | 요구 | 근거 |
|---|---|---|
| FR-1210 | 요청마다 **식별자** — nginx가 만들어 앱에 넘기고(`X-Request-Id`), 앱은 모양이 맞으면 쓰고 아니면 만든다. 응답 머리말 `X-Request-Id`로 돌려준다 | F-003 ①, A.1-6 |
| FR-1211 | 요청 안의 **모든 앱 로그 줄**에 `requestId`가, 로그인했으면 `userId`(불투명 id)가 실린다 | F-003 ① |
| FR-1212 | 감사로그 행에 그 요청의 `requestId`가 남는다(`audit_events.request_id`). 요청 밖(한 시간마다의 정리·실시간 편집의 자동 저장)은 비운다 | F-003 ①, A.1-13 |
| FR-1213 | **앱 접근 로그** — 요청마다 한 줄, event `http.request`: 메서드·경로 틀(`/api/pages/:id`)·상태·걸린 시간·사용자. **질의 문자열을 싣지 않는다.** 헬스체크·정적 자산은 남기지 않는다. 받는 쪽이 끊은 요청은 그렇다고 적는다 | F-003 ②, A.1-7·8 |
| FR-1214 | 로그 줄마다 **안정된 `event` 코드**(`LOG_EVENTS`에 있는 것만)와 식별자 필드(`pageId`·`providerId` …). 문장(`msg`)은 사람을 위한 설명이다 | F-003 ③, A.1-9 |
| FR-1215 | **실패는 구조화해 남긴다** — 바깥·입력 탓(LLM 서버의 거절·메일 API·사내 IdP)은 `warn`, 우리 쪽 결함(처리되지 않은 예외·저장 실패)은 `error`. 오류는 `errorText`·`errorStack`으로(7절) | F-003 ⑤ |
| FR-1216 | compose 세 서비스의 로그를 **순환**한다(`max-size`·`max-file`) | F-003 ④, A.1-10 |
| FR-1217 | nginx 접근 로그는 **JSON 한 줄** — `requestId`를 싣고, 질의 문자열과 referer를 싣지 않는다 | F-003 ⑥, A.1-11 |
| FR-1218 | 장애대응 가이드는 **event 코드로 찾는다** — 목록의 모든 코드가 가이드에 있다(`verify:docs`가 대조) | F-003 ③ |
| FR-1219 | 로그에 들어가지 않는 것은 그대로다 — 비밀번호·토큰·세션 값·문서 본문·LLM 질문과 답·지시문·API 키(7절). 새 필드도 같다 | 7절 |

### C.3 사내 LLM 반입 설정 (FR-1220 ~ FR-1222)

| # | 요구 | 근거 |
|---|---|---|
| FR-1220 | 반입 가이드에 **"사내 LLM 연결하기"** — 마스터 키 → (https면) 사내 CA 파일 → 등록 → 연결 확인 → 질문 하나 → (원하면) 관리자에게 위임. 개발을 모르는 사람이 순서대로 따라 한다 | A-1 |
| FR-1221 | 사내 CA를 **파일 하나 두는 것으로** 믿게 한다 — `ca/ca.pem`이 있으면 앱이 믿는다. 사내 IdP(OIDC)도 같은 길 | A.1-12 |
| FR-1222 | 그 절차 어디에서도 **compose를 고치지 않는다** | A-1 "쉽게" |

### C.4 비기능 (NFR-110 ~ NFR-112)

| # | 목표 |
|---|---|
| NFR-110 | 새 운영 의존성을 들이지 않는다 — 요청 문맥은 Node 내장 `AsyncLocalStorage`, 로거는 쓰던 pino. app 이미지 400MB 이하 |
| NFR-111 | 요청 하나가 남기는 앱 로그는 접근 로그 한 줄 + 실패 줄뿐이다(정상 요청은 한 줄) |
| NFR-112 | A등급 파일 단위 커버리지 ≥ 90%, api ≥ 70% 유지 |

---

## D. 설계

### D.1 위임 (FR-1200 ~ FR-1206)

```
행위(Action)     root   admin            member
system.manage     ✓       ✗                ✗        운영 기반 — 위임하지 않는다
llm.manage        ✓     위임받으면 ✓        ✗        등록·삭제·연결 확인·관리 목록
user.grants.change ✓      ✗                ✗        위임을 주고 거두기
```

- `Principal`에 `grants`(위임받은 행위의 목록, 없어도 된다)를 더한다. `can(principal, action)` =
  역할의 행위이거나, **관리자이고** 그 행위가 위임할 수 있는 것(`DELEGABLE_ACTIONS`)이고 `grants`에 있을 때.
  역할이 관리자가 아니면 `grants`는 보지 않는다 — DB가 막는 것을 판정도 한 번 더 막는다.
- 가드는 요청마다 사용자를 읽어 `grants`까지 실어 판정한다(A.1-5). LLM 관리 API 넷의 요구 행위를 `system.manage`에서 `llm.manage`로
  바꾸고, 서비스의 두 번째 확인(`LlmProvidersService`)도 같은 행위를 본다.
- **위임을 주고 거두기** — `PUT /api/users/:id/grants`에 목록 전체를 보낸다(켜고 끄는 두 상태뿐이라 멱등이 쉽다). 대상이 관리자가
  아니면 400. 같은 트랜잭션에서 감사 `user.grants.change`(대상 아이디·이전·이후).
- **역할이 바뀔 때** — 관리 화면의 역할 변경과 사내 계정의 역할 동기화(JIT) 둘 다, 관리자가 아니게 되면 같은 문장에서 `grants`를 비운다.
  역할 변경의 감사 행에 거둔 목록을 싣는다. 비우지 않으면 DB CHECK가 문장을 거부한다(E절) — 조용히 남지 않는다.
- 화면 — 사용자 관리의 관리자 행마다 "LLM 연결 관리" 체크. root에게만 눌리고, 다른 관리자에게는 보이기만 한다. 홈 머리말의
  "LLM 연결" 메뉴는 `can(me, 'llm.manage')`(`/api/auth/me`가 `grants`를 준다).

### D.2 요청 식별자와 요청 문맥 (FR-1210 ~ FR-1212)

```
nginx ── X-Request-Id: $request_id ──▶ api 첫 미들웨어
          (클라이언트가 보낸 값은 덮어쓴다)   │ 모양 판정(requestIdFrom) — 맞으면 쓰고, 없거나 틀리면 randomUUID()
                                             │ 응답 머리말 X-Request-Id
                                             │ AsyncLocalStorage.run({ requestId }) — 뒤의 모든 미들웨어·가드·서비스
                                             ▼
                    가드가 사용자를 확인하면 문맥에 userId를 더한다
                    로그 한 줄마다 문맥의 requestId·userId (pino mixin)
                    감사 한 행마다 문맥의 requestId (audit_events.request_id)
```

- **모양 판정**은 순수 함수다 — 영문·숫자·`-`, 8~64자. 로그 줄에 들어가는 값이라 줄바꿈·따옴표 같은 것을 받지 않는다(로그 위조).
- **문맥이 이어지는지 실측했다(2026-09-26).** 첫 미들웨어에서 `run()`한 문맥이 body parser·express-session(PostgreSQL 저장소의 콜백)·
  비동기 처리기·await한 DB 질의 뒤·오류 처리기까지, keep-alive로 이어진 요청에서도 그 요청의 것으로 남았다. 콜백을 쓰는 저장소가 문맥을
  잃는 일이 흔하다고 알려져 있어 가정하지 않고 쟀다 — 그래서 가로채기(interceptor)로 다시 세우는 길을 두지 않았다.
- nginx는 앱이 돌려준 `X-Request-Id`를 숨기고 자기 값을 붙인다 — 머리말이 두 번 나가지 않고, nginx가 스스로 낸 응답(502 등)에도 붙는다.

### D.3 앱 접근 로그 (FR-1213)

```json
{"level":30,"time":"…","service":"workfluence-api","event":"http.request","requestId":"…","userId":"…",
 "method":"GET","route":"/api/pages/:id","status":200,"durationMs":12,"msg":"GET /api/pages/:id 200"}
```

- 요청이 끝날 때(`finish`) 한 줄. 받는 쪽이 먼저 끊으면(`close`만 오고 `finish`가 없으면) `aborted: true` — LLM 답을 받다 떠난 것이 이것이다.
- **경로 틀**은 라우터가 맞춘 모양(`req.route.path`)이다 — id·라벨 이름 같은 값이 로그에 흩어지지 않는다. 맞춘 라우트가 없는 API 요청(404)은
  `route`가 비고 경로를 200자까지 싣는다. **질의 문자열은 어디에도 싣지 않는다**(검색어).
- 남기지 않는 것: `/api/health`(헬스체크), `/api` 밖(SPA 정적 자산 — nginx 로그에 있다). WebSocket(실시간 편집)은 HTTP 요청이 아니라
  업그레이드라 여기 오지 않는다 — 게이트웨이의 event가 따로 있다.
- 판정(무엇을 남기나·어느 수준인가·어떤 필드인가)은 순수 함수, 미들웨어는 시각과 이벤트만 다룬다.

### D.4 event 코드 (FR-1214·1215·1218)

- 코드는 `영역.일`이다. 영역: `app`(기동) · `http`(요청) · `health` · `session` · `mail` · `llm` · `collab`. 일은 소문자와 밑줄.
- 로그 한 줄 = `event` + 식별자 필드 + `msg`(사람을 위한 문장). 오류가 있으면 `error`(`errorText`)와, `error` 수준이면 `trace`(`errorStack`).
- **문장에 id를 섞지 않는다** — `(page=…, user=…)`로 적던 것은 필드(`pageId`·`userId`)로 옮긴다. 문장은 그대로 두어 가이드의 검색어가
  깨지지 않게 한다.
- 처리되지 않은 예외(Nest `ExceptionsHandler`)는 `http.unhandled`로 적는다 — 같은 `requestId`의 `http.request` 줄과 이어진다.
- 목록과 뜻은 코드(`LOG_EVENTS`)가 정본이고, 운영자가 읽는 표는 장애대응 가이드 한 곳에 둔다. `verify:docs`가 목록의 코드가 가이드에 모두
  있는지 대조한다 — 코드를 더하고 가이드를 잊으면 검사가 막는다.

### D.5 nginx 접근 로그 (FR-1217)

```
log_format json escape=json '{"time":"$time_iso8601","service":"workfluence-nginx","requestId":"$request_id",
  "remoteAddr":"$remote_addr","method":"$request_method","uri":"$uri","status":$status,"bytes":$body_bytes_sent,
  "requestTime":$request_time,"upstreamTime":"$upstream_response_time","userAgent":"$http_user_agent"}';
```

- `$uri`는 질의 문자열이 없는 경로다(`$request`·`$request_uri`는 질의를 싣는다). referer는 싣지 않는다.
- 이미지의 기본 로그 위치는 표준 출력이다 — 그대로 둔다(`docker compose logs nginx`).

### D.6 로그 순환 (FR-1216)

```yaml
x-logging: &logging
  driver: json-file
  options: { max-size: "${WF_LOG_MAX_SIZE:-20m}", max-file: "${WF_LOG_MAX_FILES:-5}" }
```

세 서비스가 같은 설정을 쓴다(YAML 앵커). 도커 데몬의 기본값(json-file, 크기 무제한)을 바꾸지 않는다 — 공유 서버의 다른 프로젝트에
닿는다. 이 compose 안에서만 건다.

### D.7 사내 CA 파일 (FR-1221·1222)

- api 컨테이너는 compose 옆의 `ca` 디렉토리를 읽기 전용으로 붙인다(`/etc/workfluence/ca`).
- 이미지의 시작 스크립트가 **`ca.pem`이 있고 비어 있지 않으면** `NODE_EXTRA_CA_CERTS`를 그 파일로 두고 앱을 띄운다. 없으면 그대로 띄운다 —
  빈 값을 넘기면 Node가 기동할 때마다 경고를 남긴다.
- **TLS 검증은 그대로다**(7절). 믿을 기관을 하나 더할 뿐이다. 사내 LLM(https)과 사내 IdP가 같은 길을 쓴다.
- 반입 묶음에는 디렉토리의 안내만 들어간다 — 인증서는 현장의 것이다(TLS 인증서 `certs`와 같다).

### D.8 남는 것

| 무엇 | 왜 남기나 | 자리 |
|---|---|---|
| 실시간 편집(WebSocket)의 로그에는 `requestId`가 없다 | 업그레이드 뒤의 메시지는 HTTP 요청이 아니다. 연결 단위 필드(`pageId`·`userId`)로 잇는다 | — |
| 브라우저에서 난 오류는 서버로 오지 않는다 | 화면 오류를 모으는 길을 새로 여는 일이다 — F-003의 범위 밖 | 요청이 오면 기능백로그 |
| 로그를 한곳에 모으는 수집기 | 현장에 수집 인프라가 있는지 모른다. JSON 표준 출력이라 나중에 앱을 고치지 않고 붙는다 | 보류 8(닫음 — 다시 열 조건 그대로) |

---

## E. 데이터 모델 (`0010`)

```sql
ALTER TABLE users ADD COLUMN grants text[] NOT NULL DEFAULT '{}';
ALTER TABLE users ADD CONSTRAINT users_grants_known_chk CHECK (grants <@ ARRAY['llm.manage']::text[]);
ALTER TABLE users ADD CONSTRAINT users_grants_admin_chk CHECK (cardinality(grants) = 0 OR role = 'admin');
ALTER TABLE audit_events ADD COLUMN request_id text;
```

- 둘째 CHECK가 A.1-4를 DB에서 지킨다 — 관리자가 아닌데 위임이 남은 행은 만들어지지 않는다(역할을 바꾸면서 비우지 않으면 문장이 실패한다).
- `audit_events`는 append-only다(트리거가 UPDATE·DELETE를 막는다). 열을 더하는 것은 DDL이라 트리거와 무관하고, 옛 행은 `request_id`가 비어 있다.

## F. API 계약

| 메서드 | 경로 | 권한 | 하는 일 |
|---|---|---|---|
| `PUT` | `/api/users/:id/grants` | `user.grants.change`(root) | `{ grants: ['llm.manage'] }` 또는 `{ grants: [] }` → 바뀐 사용자(`UserView`) |
| `GET` | `/api/users` | `user.manage` | `UserView`에 `grants`가 더해진다 |
| `GET` | `/api/auth/me` | 로그인 | `MeView`에 `grants`가 더해진다 |
| `GET`·`POST`·`DELETE` | `/api/llm/admin/providers…` | **`llm.manage`**(root, 위임받은 admin) | 그대로 (P10 F절) |
| (모든 응답) | — | — | 머리말 `X-Request-Id` |

## G. 화면

| 화면 | 무엇 |
|---|---|
| 사용자 관리 | 관리자 행마다 **"LLM 연결 관리"** 체크 — root만 켜고 끈다. 관리자가 아닌 행은 비어 있다 |
| 홈 머리말 | "LLM 연결" 메뉴 — root, 그리고 위임받은 관리자 |
| LLM 연결 | 그대로 (P10 G절). 위임받은 관리자도 쓴다 |

## H. 모듈과 등급

| 모듈 | 경로 | 등급 | 하는 일 |
|---|---|---|---|
| 권한 판정 | `packages/shared/src/permissions.ts` | **A** | 위임 규칙(D.1) |
| 로그 코드 | `packages/shared/src/constants.ts` | **A** | `LOG_EVENTS` |
| DTO | `packages/shared/src/schemas.ts` | **A** | 위임 목록(`userGrantsDto`) |
| 요청 식별자 모양 | `apps/api/src/common/domain/request-id.ts` | **A** | D.2 |
| 접근 로그 판정 | `apps/api/src/common/domain/access-log.ts` | **A** | D.3 — 남기나·수준·필드 |
| 요청 문맥 | `apps/api/src/common/request-context.ts` | B | `AsyncLocalStorage` — 식별자·사용자 |
| 로거 | `apps/api/src/common/logger.ts` | B | mixin(문맥) · event 줄 · `http.unhandled` |
| 로그 한 줄 | `apps/api/src/common/log-line.ts` | B | event + 필드 + 문장을 로거에 넘기는 모양 |
| 감사 | `apps/api/src/audit/audit.service.ts` | B | `request_id` |
| 위임 | `apps/api/src/users/users.service.ts` · `users.module.ts` | B | D.1 |
| 사내 계정 동기화 | `apps/api/src/auth/auth.service.ts` | B | 역할이 바뀌면 위임을 비운다 |
| 배선 | `apps/api/src/main.ts` | (측정 밖) | 첫 미들웨어(식별자·문맥)·접근 로그 |
| 시작 스크립트 | `deploy/entrypoint.sh` | (컨테이너 확인) | D.7 |
| 화면 | `apps/web/src/pages/admin/AdminUsersPage.tsx` · `apps/web/src/pages/SpacesPage.tsx` | B | G절 |

## I. 설정 항목

앱 환경변수는 늘지 않는다. compose 전용 변수(`deploy/.env`, 앱에 넘기지 않는다):

| 키 | 기본값 | 무엇 |
|---|---|---|
| `WF_LOG_MAX_SIZE` | `20m` | 로그 파일 하나의 크기 (D.6) |
| `WF_LOG_MAX_FILES` | `5` | 서비스마다 남기는 로그 파일 수 (D.6) |

파일 자리: compose 옆의 `ca/ca.pem` — 있으면 믿는 사내 CA(D.7). 설계 고정값: `LOG_EVENTS`·`DELEGABLE_ACTIONS`(shared), 요청 식별자의
모양(영문·숫자·`-` 8~64자), 접근 로그에 싣는 경로의 길이(200자).

## J. 보류 결정 처리

| # | 항목 | 처리 |
|---|---|---|
| 29 | 사내 LLM 실연동 | **트리거를 "폐쇄망 반입 뒤 현장에서"로** 바꾼다(사용자 답). 판정 방법은 반입 가이드의 "사내 LLM 연결하기" 확인 항목. https·사내 CA의 compose 자리는 이 Phase가 둔다(D.7) |
| 30 | 질문 빈도 제한 | 그대로 — 사용자가 뜻을 물었고 정하지 않았다 |
| 확인 필요 F | LLM 등록을 root만 하는가 | **닫는다** — root가 메인, 관리자에게 위임(C.1) |
| 8 | 중앙 로그 수집 | 닫힌 그대로. F-003이 수집기를 붙일 모양(JSON·requestId·event)을 갖춘다 |

## K. 구현 순서

1. A등급 — 위임 규칙·`LOG_EVENTS`·위임 DTO·요청 식별자 모양·접근 로그 판정. **테스트 먼저**
2. 마이그레이션 `0010` + 감사 종류 `user.grants.change`
3. 요청 문맥·로거·접근 로그·감사 `request_id` — 요청 하나를 끝까지 잇는 통합 시험
4. 위임 API·가드·LLM 관리 가드·사내 계정 동기화 — 통합 시험(실제 PostgreSQL)
5. 로그 부르는 자리 전부를 event 코드로 · 장애대응 가이드의 event 표 · `verify:docs` 대조
6. 화면 — 사용자 관리의 위임 체크, 홈 머리말. 컴포넌트 시험
7. nginx 로그 형식·compose 순환·시작 스크립트(사내 CA)
8. E2E — root가 관리자에게 위임 → 그 관리자가 LLM을 등록 → 거두면 막힌다 · 응답의 `X-Request-Id`
9. 컨테이너 — nginx를 거친 요청 하나를 nginx 로그·앱 로그·감사 행에서 같은 `requestId`로 찾는다, 질의 문자열이 로그에 없다, 로그 순환 설정, `ca/ca.pem`
10. 검증기록 → 검토(자체 점검·코드 리뷰·보안 검토 — 권한을 만진다·문서 정합성) → 학습가이드·장애대응·운영이관·반입 → PR → **CI** → 병합
