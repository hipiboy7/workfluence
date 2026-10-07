# 설계서 — 공개 API v1 (JWT 인증 · F-015)

- 작성일: 2026-10-07 / 작성 LLM: Claude Sonnet 5.5 — 계획서([`계획서_PublicApi.md`](계획서_PublicApi.md))의 결정 요청이 닫혔고(1절) 3단계·2단계가 끝난 시점에 쓴다. 계획서는 이 문서가 나오면 **목표·단계·위험만** 남기고, 겹치는 설계는 이 문서를 가리킨다
- 근거 원문: [`요청원문.md`](요청원문.md) · 커버리지 분석: [`분석서_시나리오커버리지.md`](분석서_시나리오커버리지.md)(G1~G5)
- 요구사항 번호: **FR-2200**, 비기능 **NFR-210**부터 (원 저장소가 FR-2107·NFR-200까지 썼다)
- 구현 방식: **TDD** — 모든 등급에서 시험이 먼저, 이력이 `test:`(Red) → `feat:`·`refactor:`(Green)로 남는다(사용자 지시 2026-10-02)

## 1. 착수 쟁점 (계획서 3절의 결정 요청)

사용자는 계획서를 보고 "TDD 방식으로 구현"이라 답했고, 계획서가 정한 규칙("답이 오기 전에는 추천안으로 진행한다 — 추천과 다르게 정하면 그 단계부터 고친다")에 따라 **추천안으로 진행했다.** 아래는 그 결과를 실제 코드와 맞춰 확정한 것이다. **다르게 정하면 말해 달라** — 다시 정할 때 고칠 곳도 적었다.

| # | 쟁점 | 정한 것 | 구현 상태 · 다시 정할 때 고칠 곳 |
|---|---|---|---|
| Q1 | JWT 발급 | **(가) 서버가 서명하는 긴 수명 JWT**를 사용자가 화면에서 발급. HS256, `WF_API_JWT_SECRET` | 끝 (`api-tokens/`). (나)로 가면 발급 경로와 토큰 수명만 바뀌고 가드·표는 그대로다 |
| Q2 | 만료 | 필수·최대 365일·기본 90일 (`API_TOKEN_LIMITS`) | 끝. **상한을 운영 설정으로 조절하는 것은 아직 없다**(계획서는 "관리 화면"이라 했다) → 7절 남은 일 |
| Q3 | scope | `read` ⊂ `write`, 그리고 `admin`은 따로 (`API_TOKEN_SCOPES`) | 끝 (`packages/shared/src/api-token.ts`) |
| Q4 | 관리 기능 | `admin` scope가 **더** 있어야 한다. 읽기용 관리자 토큰이 새도 정지·역할 변경은 못 한다 | 가드 끝(`API_ADMIN_KEY`). **v1 관리 경로에 그 표시를 붙이는 것은 4단계** |
| Q5 | 토큰 수 | 한 사람 10개 (`API_TOKEN_LIMITS.maxPerUser`) | 끝 |
| Q6 | 편집 중 저장 (G2) | **(가) 409 `PAGE_BEING_EDITED`** — 사람의 입력을 절대 건드리지 않는다 | 4단계. 방이 열려 있는지는 `CollabGateway`가 안다 |
| Q7 | 본문 형식 (G1) | 마크다운 읽기·쓰기를 v1에 넣는다 (`format=json\|markdown\|text`) | 3-1단계 |

## 2. 요구사항

### 2.1 인증과 토큰 (3단계 — 끝)

| # | 요구사항 | 확인 |
|---|---|---|
| FR-2200 | **공개 API는 `WF_API_JWT_SECRET`이 있어야 켜진다.** 비면 앱은 뜨고 v1은 503 `API_DISABLED`다. 32자 미만이거나 세션 비밀과 같으면 **기동하지 않는다** | A `packages/shared` 설정 스키마 시험 · B 토큰 서비스 |
| FR-2201 | **JWT는 값 하나로 쓴다.** `Authorization: Bearer <JWT>`. 서명·`iss`·`aud`·`alg`를 **고정**하고(`API_JWT`) `exp`·`iat`·`sub`·`jti`가 없으면 거절한다. `alg: none`·다른 알고리즘·다른 키는 `TOKEN_INVALID` | A `jwt.spec.ts` |
| FR-2202 | **요청마다 토큰 행과 사용자 행을 다시 읽는다.** 순수 JWT만으로는 정지·폐기를 그 자리에서 먹일 수 없다. 폐기·만료·정지·변경 강제는 즉시 거절한다 | B `api-tokens.integration.spec.ts` · `api-token.guard.spec.ts` |
| FR-2203 | **토큰 값은 발급 응답에만 있다.** DB(`api_tokens`)에는 값이 없고 로그·감사에도 싣지 않는다 | B 발급 시험(행에 값 없음) |
| FR-2204 | **끊기는 때** — 사용자가 폐기, 관리자가 폐기, 정지·비밀번호 변경·관리자 강제 종료는 **그 사람의 토큰 전부**를 같은 자리에서 폐기, 만료. 로그아웃은 토큰에 영향이 없다 | B 세션 모두 끊기(G3)·로그아웃 |
| FR-2205 | **발급·폐기·목록은 화면(세션)에서만**(`/api/tokens`). 토큰으로 토큰을 만들지 못한다 | B 가드 시험 |
| FR-2206 | **가드는 쿠키를 보지 않는다.** Bearer가 없으면 세션이 있어도 401이고, 그래서 `/api/v1` 쓰기에는 CSRF 헤더가 필요 없다. 다만 경로 조각(`.`·`..`·인코딩)이 든 `/api/v1`은 **CSRF를 빼 주지 않는다**(`isPublicApiPath`) | B 가드 시험 |
| FR-2207 | **scope** — GET·HEAD·OPTIONS는 `read`, 그 밖은 `write`, 관리 경로는 `admin`이 더 | A `api-token.spec.ts` |
| FR-2208 | **권한은 사람의 것이다.** scope를 통과해도 `can()`(`packages/shared/src/permissions.ts`)이 거절하면 403 `FORBIDDEN`. 토큰이 사람보다 더 할 수는 없다 | B 가드 시험 |
| FR-2209 | **비밀번호 초기화(임시 비밀번호를 돌려주는 경로)는 v1에 열지 않는다**(G3) | 4단계 계약 시험 |

### 2.2 v1 경로 (4단계 이후)

| # | 요구사항 | 확인 |
|---|---|---|
| FR-2210 | **v1 컨트롤러는 유스케이스를 한 번 부르는 얇은 층**이다. 트랜잭션·감사·멘션 메일을 다시 쓰지 않는다 — 화면용 컨트롤러와 같은 `*UseCases`를 부른다 | B 모듈별 "토큰으로 부르면 화면용과 같은 결과" |
| FR-2211 | **오류는 한 모양** `{ "error": { "code", "message", "requestId" } }`. 가드의 코드(3.2절)를 포함해 code는 고정 문자열이고 에이전트는 문장이 아니라 code로 분기한다 | A 오류 모양 · B |
| FR-2212 | **감사** — 토큰으로 한 일도 기존 감사 행위로 남기고 `detail.jti`(토큰 번호 — `tokenId`는 감사의 비밀 키 거름이 지운다)를 싣는다. 발급·폐기는 `api_token.create`·`api_token.revoke` | B |
| FR-2213 | **빈도 제한** — 토큰별(`RATE_LIMITS`에 더한다). 넘으면 429 + `Retry-After`. 값은 4단계에서 실측으로 정한다 | B |
| FR-2214 | **목록은 `limit`·`cursor` 한 방식**이다 | B |
| FR-2215 | **본문 형식 `format`**(G1) — 페이지·댓글 읽기는 `markdown`(에이전트 기본 — FR-2223)·`json`·`text`, 쓰기는 `markdown`(기본) 또는 `json`. 마크다운은 **허용 목록 밖의 노드를 만들지 못하고** 어긋나면 400이다 | A 3-1단계 왕복 성질 시험 |
| FR-2216 | **실시간 편집 중인 페이지에 REST로 저장하면 409 `PAGE_BEING_EDITED`**(G2, Q6). 사람의 저장 전 입력을 지우지 않는다 | B 게이트웨이와 함께 |
| FR-2217 | **페이지 읽기에 `ancestors`**(id·제목)를 싣는다(G4). v1 응답에만 | B |
| FR-2218 | **첨부 응답에 문서에 넣을 `src`**를 싣는다(G5). 그림 노드가 문서에 아직 없어 마크다운의 그림 문법은 받지 않는다(3.4절) | B |
| FR-2219 | **v1은 더하기만 한다**(필드·경로 추가). 빼거나 뜻을 바꾸면 v2 | 문서 규칙 |

| FR-2223 | **에이전트가 정하는 입력은 핵심뿐이다**(사용자 지시 2026-10-07). 페이지 만들기는 **어디(스페이스)·제목·본문** 셋만 필수이고 나머지는 모두 서버가 기본값으로 채운다. 선택 입력을 받더라도 에이전트가 **몰라도 되게** 한다 | 3.5절 · B 모듈별 "필수 입력만으로 성공" |
| FR-2224 | **기본값은 한 곳에 둔다**(`packages/shared`의 `V1_DEFAULTS`). 같은 값이 컨트롤러·명세·문서에 따로 적히지 않는다 — OpenAPI의 `default`와 API 사용가이드가 그것에서 나온다 | A · 계약 시험(명세의 default가 그 상수와 같다) |
| FR-2225 | **기본값으로 채운 결과를 응답이 말한다** — 서버가 정한 부모·위치·버전을 돌려줘서 에이전트가 다음 호출에 id를 외우지 않아도 된다 | B |

### 2.3 명세와 화면 (5·6단계)

| # | 요구사항 | 확인 |
|---|---|---|
| FR-2220 | `GET /api/v1/openapi.json`(인증 없음). 요청 모양은 **이미 있는 zod 스키마에서 만든다**(zod 4 내장 JSON Schema 변환). Swagger UI는 싣지 않는다(이미지 예산) | 계약 시험 |
| FR-2221 | **v1의 모든 경로가 명세에 있고 명세의 모든 경로가 v1에 있다.** 실제 응답은 응답 스키마를 지킨다 | 계약 시험 |
| FR-2222 | 화면: 내 정보에 **API 토큰**(발급·한 번 보기·복사·폐기·마지막 사용), 사용자 관리에 그 사람의 토큰 폐기. 켜짐·상한은 `GET /api/tokens/config`로 폼을 그린다 | E2E: 발급 → 그 토큰으로 마크다운 페이지 만들기 → 폐기 → 401 |

### 2.4 비기능

| # | 요구사항 | 확인 |
|---|---|---|
| NFR-210 | **새 의존성이 없다** — `jose`·`zod`는 이미 있다. app 이미지 예산 400MB(여유 약 10MB)를 지킨다 | 8단계 빌드 실측 |
| NFR-211 | 새 설정 키는 `WF_API_JWT_SECRET` **하나**다. 같은 커밋에서 `.env.example`·설정 항목 표(5절)·`deploy/compose.yml`·`scripts/win-launcher.mjs`를 함께 갱신했다(`CLAUDE.md` 5절) | `.env.example` 키 집합 시험 |
| NFR-212 | 유스케이스 추출(2단계)은 **동작을 바꾸지 않는다** — 기존 시험이 그대로 통과하는 것이 완료 기준이다 | `pnpm check`, E2E |
| NFR-213 | 토큰 값은 응답·로그·감사에 다시 내보내지 않는다. 로그는 `errorText`를 쓰고 `Authorization` 헤더를 싣지 않는다 | B · 8단계 보안 검토 |

## 3. API 계약

### 3.1 토큰 관리 — 화면용 (세션·CSRF 헤더, `/api/tokens`)

| 메서드·경로 | 하는 일 |
|---|---|
| `GET /api/tokens/config` | `{ enabled, scopes, maxDays, defaultDays, maxPerUser }` — 화면이 폼을 그린다 |
| `GET /api/tokens` | 내 토큰 목록(이름·scope·만든 때·만료·마지막 사용·폐기 까닭). 값은 없다 |
| `POST /api/tokens` | `{ name, scopes, days? }` → `ApiTokenView & { token }` — **값은 이 응답에만** |
| `DELETE /api/tokens/:id` | 폐기(행은 남고 `revokedAt`·까닭이 찬다). 다시 폐기하면 감사가 또 남지 않는다 |

### 3.2 v1 가드의 실패 (구현됨 — `api-token.guard.ts`)

| 상태 | code | 뜻 |
|---|---|---|
| 401 | `TOKEN_MISSING` | Bearer 헤더가 없다 (세션 쿠키는 보지 않는다) |
| 401 | `TOKEN_INVALID` | 모양·서명·발급자·대상·`alg`가 틀렸다 |
| 401 | `TOKEN_UNKNOWN` | 서명은 맞는데 토큰 행이 없다 |
| 401 | `TOKEN_REVOKED` | 폐기됐다 |
| 401 | `TOKEN_EXPIRED` | 만료됐다 |
| 401 | `ACCOUNT_INACTIVE` | 주인이 정지·승인 대기·삭제 상태다 |
| 403 | `PASSWORD_CHANGE_REQUIRED` | 화면에서 비밀번호를 바꿔야 쓸 수 있다 |
| 403 | `INSUFFICIENT_SCOPE` | 이 요청이 요구하는 scope가 없다 |
| 403 | `FORBIDDEN` | 사람의 권한(`can()`)이 거절했다 |
| 503 | `API_DISABLED` | `WF_API_JWT_SECRET`이 비어 공개 API가 꺼져 있다 |

> 오류는 모두 한 모양(`V1ExceptionFilter`)으로 나간다 — 가드의 코드는 그대로이고, 코드가 없는 오류는 상태에서 정한다(400 `INVALID_REQUEST`·404 `NOT_FOUND`·409 `CONFLICT`·429 `RATE_LIMITED` 등). 페이지에서 더한 코드: `SPACE_NOT_FOUND`·`SPACE_AMBIGUOUS`·`SPACE_REQUIRED`·`VERSION_CONFLICT`·`PAGE_BEING_EDITED`. 처리되지 않은 오류는 500 `INTERNAL`이고 오류 문장은 응답에 싣지 않는다(로그에 `http.unhandled`로 남는다).

### 3.3 v1 경로

경로 이름·모듈별 scope는 계획서 5-1절의 지도를 따른다 — 화면용과 같은 이름을 쓰고(외워 둘 것이 하나) 접두사만 `/api/v1`이다. **같은 사실을 두 곳에 쓰지 않으려고 표를 옮기지 않는다.** 4단계가 모듈을 하나씩 만들 때마다 이 절에 그 모듈의 **v1에서만 다른 점**(`format`·`ancestors`·`src`·409·제외한 경로)을 더한다.

**페이지 (끝 2026-10-07 — 4단계 첫 조각, `packages/shared/src/v1.ts` · `apps/api/src/v1/`)**

| 경로 | 에이전트가 정하는 것 | 화면용과 다른 점 |
|---|---|---|
| `GET /api/v1/pages?space=&limit=` | 스페이스(이름이나 id) | 본문 없는 트리. `limit` 기본 200·최대 1000 |
| `GET /api/v1/pages/:id?format=` | 페이지 | `format` 기본 `markdown`(`json`·`text`) — 본문은 `body`, 형식은 `format`, **`ancestors`**(뿌리부터)가 함께 온다 |
| `POST /api/v1/pages` | `space`·`title`·`body` | 스페이스를 **이름으로** 고른다(겹치면 409 `SPACE_AMBIGUOUS`+후보, 없거나 볼 수 없으면 404 `SPACE_NOT_FOUND`). 본문은 마크다운(`format`으로 `json`). 부모 없으면 맨 위, 위치는 맨 끝. 모르는 칸은 400 |
| `PATCH /api/v1/pages/:id` | 고칠 `title`·`body` 중 하나 이상 | 안 준 것은 그대로, **기준 버전을 안 주면 지금 버전**(주면 지킨다 — 어긋나면 409 `VERSION_CONFLICT`+지금 버전). **사람이 실시간 편집 중이면 409 `PAGE_BEING_EDITED`**(쓰기 권한이 없으면 403이 먼저) |
| `PATCH /api/v1/pages/:id/move` | `parentId`(`null`=맨 위) | 위치를 안 주면 맨 끝 |
| `DELETE /api/v1/pages/:id` | — | 휴지통으로 |
| `GET …/versions` · `GET …/versions/:no?format=` | — | 버전 본문도 `format`대로 |
| `POST …/versions/:no/restore` | — | 편집 중이면 409 `PAGE_BEING_EDITED` |
| `GET …/versions/:a/diff/:b` | — | 화면용과 같은 모양 |
| `GET …/export?versionNo=` | — | HTML 한 파일 — **파일로 받게 한다**(`Content-Disposition: attachment`). 감사 `page.export` |

- 컨트롤러는 화면용과 같은 `PageUseCases`를 부른다 — 감사(`page.create` 등)와 멘션 메일이 같은 길이다. **감사 행에는 `detail.jti`(토큰 번호)가 요청 문맥에서 자동으로 붙는다**(FR-2212).
- 응답이 서버가 채운 값(부모·위치·버전)을 말한다(FR-2225).
- **빈도 제한(FR-2213, 끝)**: 토큰마다 읽기 120/분·쓰기 30/분(`API_RATE_LIMITS` — **측정 전의 값**). 넘으면 429 `RATE_LIMITED`에 `Retry-After`(초)와 `details.retryAfterSec`. 읽기와 쓰기는 따로 세고, 토큰 가드를 **통과한** 요청만 센다. 저장소는 `ApiTokensModule`의 `RateLimitStore` 하나라 로그인 등 IP별 제한과 섞이지 않는다. 모든 v1 컨트롤러는 `@UseV1()` 한 줄로 토큰 가드 → 빈도 제한 → 오류 한 모양을 함께 건다(순서가 뜻이 있다).
- 실제 호출 확인(2026-10-07, 개발 서버·컨테이너 아님): 쿠키·CSRF 헤더 없이 토큰만으로 만들기·고치기·읽기, 토큰 없음 401, HTML 본문 400(입력을 되읊지 않음), 모르는 칸 400, 없는 스페이스 404, 기준 버전 어긋남 409, read 토큰의 쓰기 403, 세션 쿠키만으로는 401, 감사 행의 `jti`. 빈도 제한(쓰기 40번 연속 → 28개 200·12개 429, 앞서 쓰기 2번이 먼저 세어져 30에서 막힘, 읽기는 별도 예산)·`diff`·내보내기 헤더도 같은 서버에서 확인했다. **편집 중 409는 시험의 대역으로만 확인했다**(실제 WebSocket 편집과 겹치는 시험은 5단계 이후 E2E).


### 3.5 에이전트용 단순 계약 — 기본값을 최대한 적용한다 (사용자 지시 2026-10-07)

> "llm agent 가 복잡한 일을 하게 할 수는 없어. 왠만한 attribute는 default 값을 넣게 강제하고 핵심 내용만 ai agent가 작성하게 해. 예를 들어 content page를 만든다면 category 선택, 제목작성, 본문작성 만 하게 하는거야." · "v1 api 는 default 값을 최대한 적용해야되."

**원칙.** v1은 화면용 API를 그대로 열지 않는다. 경로마다 **에이전트가 정할 것(필수)** 과 **서버가 채울 것(기본값)** 을 나누고, 필수는 사람이 말로 시킬 수 있는 것(어디·제목·본문)으로 한정한다. 선택 입력은 둘 수 있지만 **없어도 같은 결과가 나오는 기본값이 있어야 한다.**

| 경로 | 에이전트가 정하는 것 | 서버가 채우는 기본값 (제안 — 4단계 착수 때 확정) |
|---|---|---|
| 페이지 만들기 | 스페이스 · `title` · `body`(마크다운) | `parentId`=스페이스 맨 위 · 위치=맨 끝 · 본문 형식=마크다운 · 스키마 버전 |
| 페이지 고치기 | 페이지 · `body`(와 필요하면 `title`) | 기준 버전=지금 버전(편집 중이면 409 — FR-2216) · 제목은 그대로 |
| 읽기 | 페이지 | `format`=마크다운 · 조상 경로 포함 · 본문만 |
| 목록·검색 | (없음 또는 검색어) | `limit` 기본값 · 최신순 |
| 댓글·라벨 | 페이지 · 글(라벨 이름) | 본문 형식=마크다운 · 부모 댓글 없음 |

- **스페이스는 id가 아니라 이름으로도 고른다**(에이전트가 uuid를 외우지 않게). 이름이 겹치면 임의로 고르지 않고 400과 후보 목록을 돌려준다. **"category 선택"이 스페이스인지 분류인지 부모 페이지인지는 사용자 답을 기다린다** — 답이 오기 전에는 스페이스로 둔다.
- 기본값이 **권한을 넓히지 않는다** — 채우는 값은 사람이 화면에서 같은 일을 할 때의 기본값과 같다(FR-2208은 그대로 먼저 본다).
- 필수 입력만으로 부른 요청이 성공하는 시험을 경로마다 둔다(FR-2223).

**스페이스·Crew·분류 (끝 2026-10-07 — 4단계 둘째 조각, `apps/api/src/v1/v1-spaces.controller.ts`)**

| 경로 | 에이전트가 정하는 것 | 서버가 채우는 것·화면용과 다른 점 |
|---|---|---|
| `POST /api/v1/spaces` | `name` | 종류는 **팀**(개인 스페이스는 계정과 함께 생긴다 — `kind`를 보내면 400), 설명 빈 글, 분류 없음. 분류는 **이름**으로 고른다(`category`) — 없으면 404 `CATEGORY_NOT_FOUND`에 고를 수 있는 이름(`details.available`) |
| `GET /api/v1/spaces?q=&limit=` | (없음) | 내가 읽을 수 있는 팀·개인 스페이스를 한 목록으로. 이름·키로 찾기 |
| `GET /api/v1/spaces/:id` | — | 응답은 에이전트가 쓸 것만: `id·name·description·kind·status·category·categoryId·memberCount·myRole·canWrite·canManageMembers`(열쇠·만든 사람·세부 권한은 뺀다) |
| `PATCH /api/v1/spaces/:id` | 고칠 `name`·`description`·`category` | 분류는 `null`이면 지우고 없으면 그대로 |
| `PATCH …/status` | `status`(`active`·`suspended`), 필요하면 `takeover` | `takeover`는 중지에만 |
| `DELETE /api/v1/spaces/:id` | — | 휴지통으로 |
| `GET·POST …/members` | `username` | 역할 기본 **editor**(owner 자리는 줄 수 없다). 응답은 `userId·username·displayName·role` |
| `PATCH·DELETE …/members/:ref` | `role` | `:ref`는 **사용자 이름이나 id** — Crew에 없으면 404 `MEMBER_NOT_FOUND` |
| `GET·POST /api/v1/categories`, `PATCH·DELETE …/:id` | `name` | 만들기는 같은 이름이면 있던 것(멱등). 남의 공간이 쓰는 분류는 만든 사람도 못 지운다(화면용과 같은 규칙) |

- 컨트롤러는 화면용과 같은 `SpaceUseCases`·`CategoryUseCases`를 부른다(FR-2210). 판정(주인·관리자·위임)과 감사도 같다 — 에이전트가 사람보다 더 할 수 없다.
- 스페이스를 **이름으로 고르는 규칙**(`resolveSpaceRef` — 겹치면 409 `SPACE_AMBIGUOUS`, 볼 수 없으면 404)은 페이지와 이 모듈이 한 곳(`v1/space-ref.ts`)을 쓴다.
- 실제 호출 확인(2026-10-07, 개발 서버): 이름만으로 만들기, 분류 이름으로 고르기·없는 분류 404, `kind` 400, Crew를 사용자 이름으로 넣기(기본 editor)·자리 바꾸기·빼기, 없는 사람 404, 목록 찾기, 분류를 지우면 스페이스가 분류 없음으로.

**댓글·라벨·첨부 (끝 2026-10-07 — 4단계 셋째 조각, `apps/api/src/v1/v1-content.controller.ts`)**

| 경로 | 에이전트가 정하는 것 | 서버가 채우는 것·화면용과 다른 점 |
|---|---|---|
| `GET·POST /api/v1/pages/:pageId/comments` | `body`(답글이면 `parentId`) | 본문은 마크다운이 기본(`format`으로 `json`), 응답도 `format`대로. 응답은 `id·pageId·parentId·author·createdAt·updatedAt·canDelete·format·body`. 멘션 메일은 화면용과 같은 길 |
| `PATCH·DELETE /api/v1/comments/:id` | `body` | |
| `GET·POST /api/v1/pages/:pageId/labels` | `name` | |
| `DELETE …/labels/:ref` | — | `:ref`는 **이름이나 id** — 붙어 있지 않으면 404 `LABEL_NOT_FOUND` |
| `GET /api/v1/labels` · `GET …/labels/:name/pages` | — | 볼 수 있는 페이지만(`{items}`) |
| `GET /api/v1/pages/:pageId/attachments` | — | 응답에 **`url`**(이 API로 받는 주소)과 **`href`**(위키 안 주소 — 본문에 `[이름](href)`로 걸면 사람이 눌러 받는다) |
| `POST …/attachments` | **JSON `{filename, content, encoding?}`**(글은 utf8, 바이너리는 base64) 또는 multipart(필드 `file`) | 에이전트는 바이너리를 보낼 수 없어 JSON 길을 둔다. **형식(mime)은 받지 않고** 확장자에서 정한다. 종류·크기·내용(가장한 파일) 검사와 감사는 화면용과 같다. JSON 본문은 앱의 JSON 상한(2MB) 안 |
| `GET /api/v1/attachments/:id` | — | 바이너리(`nosniff`·`no-store`·`attachment`). **`?format=json`이면 글은 utf8·바이너리는 base64로 JSON에 담는다**(1,000,000바이트까지 — 넘으면 413 `TOO_LARGE_FOR_JSON`) |
| `DELETE /api/v1/attachments/:id` | — | |

- 그림 노드가 문서에 없어(3.4절) 첨부를 본문에 **그림으로** 넣을 수는 없다 — 링크(`href`)로 건다. 분석서 G5의 `src`는 이 `href`로 바꿨다(FR-2218).
- JSON 받기가 413이어도 **다운로드 감사 행은 남는다**(서버가 파일을 읽었다 — "누가 무엇에 접근했나"가 기준이다).
- 실제 호출 확인(2026-10-07, 개발 서버): 본문만으로 댓글·답글, 댓글의 HTML 400, 이름만으로 라벨·이름으로 떼기·없는 라벨 404, JSON(utf8)·multipart 업로드, `format=json` 받기·바이너리 머리, 가장한 PDF 400·`.exe` 400.

### 3.4 마크다운 변환의 경계 (3-1단계)

- **읽기**는 이미 공유 함수 `pageMarkdown`이 있다(화면의 복사 단추가 쓴다). v1은 그 함수와 텍스트 변환을 그대로 쓴다.
- **쓰기**(마크다운 → 문서)가 새로 만들 것이다. 문서 허용 목록(`packages/shared/src/document.ts`)과 **편집기 스키마와 대조 시험이 같게 두는 그 집합**을 넘는 것을 만들지 않는다 — 어긋난 것은 조용히 고치지 않고 400이다.
- **지원**: 문단(줄 끝 `\`·빈칸 둘은 줄바꿈), 제목 1~6, 가로줄, 인용, 울타리 코드, 글머리·번호 목록(중첩), GFM 표(정렬), 굵게·기울임·취소선·코드·링크·`<http(s)://…>`. **지원하지 않음**: 들여 쓴 코드·setext 제목·참조식 링크·맨 주소 자동 링크·밑줄·**그림**. 문서 허용 목록에 그림 노드가 없어 **그림 문법은 400**이다(분석서 G5의 "그림 문법을 받는다"는 이 때문에 접는다 — 그림 노드가 문서에 생기면 그때 더한다).
- **거절**: 원시 HTML·허용 밖 링크 주소·그림·너무 긴 입력·너무 깊은 중첩·처리량 예산 초과. 오류는 줄 번호와 규칙만 말하고 입력한 글을 되읊지 않는다.
- 시험(A등급, 먼저): 허용 목록 안의 문서는 `문서 → 마크다운 → 문서`가 같아지는 **왕복 성질**, 허용 목록 밖 문법(원시 HTML·스크립트 링크·외부 이미지)은 거절.

## 4. 데이터 모델 (`0014_api_tokens` — 끝)

`api_tokens`: `id`(= JWT의 `jti`)·`user_id`(삭제 시 함께)·`name`(1~100자)·`scopes text[]`(1개 이상, `read`·`write`·`admin`만)·`created_at`·`expires_at`(`> created_at`)·`last_used_at`·`revoked_at`·`revoked_reason`(둘은 함께 있거나 함께 없다). 인덱스는 `(user_id, created_at)`. **값 열이 없다.** 마지막 사용 시각은 `lastUsedResolutionSec`(60초)로 묶어 쓴다. 앱 계정의 권한은 마이그레이션 단계가 모든 표에 다시 준다(`apps/api/src/db/app-role.ts`).

## 5. 설정 항목

| 이름 | 위치 | 값 |
|---|---|---|
| `WF_API_JWT_SECRET` | `.env` | 32자 이상, 세션 비밀과 달라야 함. 비면 공개 API가 꺼진다. **바꾸면 이미 발급한 토큰이 모두 죽는다**(서명이 달라진다) |
| `API_TOKEN_LIMITS`·`API_TOKEN_SCOPES`·`API_JWT` | `packages/shared/src/constants.ts` | 사람마다 개수·기본/최대 만료·이름 길이·scope 목록·JWT 고정값. 바꾸면 보안 판단이 바뀌는 설계 고정값이다 |
| 토큰 만료 상한(운영 설정) | DB `settings` | **아직 없다** — 7절 |

## 6. 모듈과 등급 (`CLAUDE.md` 3절)

| 모듈 | 위치 | 등급 | 상태 |
|---|---|---|---|
| 토큰 판정(클레임·scope·행·계정·만료) | `packages/shared/src/api-token.ts` | A | 끝 |
| JWT 서명·검증·Bearer 해석 | `apps/api/src/api-tokens/domain/jwt.ts` | A | 끝 |
| 마크다운 → 문서 | `packages/shared/src/markdown-parse.ts` (읽기 방향은 기존 `markdown.ts`) | A | **끝**(3-1) |
| v1 오류 모양·기본값·본문 형식·스페이스 이름 찾기 | `packages/shared/src/v1.ts` | A | **끝** |
| 토큰 서비스·가드·컨트롤러 | `apps/api/src/api-tokens/` | B | 끝 |
| 유스케이스 | `apps/api/src/*/*.usecases.ts` | B | **끝**(설정·라벨·휴지통·템플릿·첨부·댓글·LLM·사용자·스페이스·분류·페이지) |
| v1 컨트롤러 | `apps/api/src/v1/` | B | **페이지·스페이스·분류·댓글·라벨·첨부 끝**, 나머지 모듈은 같은 틀로 |
| OpenAPI 생성·계약 시험 | 예정 | B | 5 |
| 토큰 화면 | `apps/web` | B(측정만) · C E2E | 6 |

## 7. 남은 일과 판단이 필요한 것

| 단계 | 일 | 비고 |
|---|---|---|
| ~~3-1~~ | ~~마크다운 → 문서 변환 (A, 시험 먼저)~~ → **끝 2026-10-07**(`96034fb` Red → Green) | 3.4절 |
| 4 | v1 컨트롤러·오류 필터·빈도 제한·`format`·409·`ancestors`·`src` | **페이지(비교·내보내기 포함)·스페이스(Crew)·분류·댓글·라벨·첨부·빈도 제한은 끝(2026-10-07)** — 3.3절. 남은 모듈(검색·템플릿·휴지통·알림·LLM·관리), 관리 경로의 `admin` 표시, 비밀번호 초기화 제외(FR-2209), 본문 파싱 오류(잘못된 JSON·너무 큰 본문)의 오류 모양 |
| 5 | OpenAPI 생성 + 계약 시험 | |
| 6 | 토큰 화면 + E2E | |
| 7 | API 사용가이드(curl·에이전트 도구 정의 예), 가이드에 가리키는 줄(장애대응 401/403/429, 사용자가이드, 학습가이드, 설계서_Architecture 11절) | `pnpm verify:docs` |
| 8 | 검토 — `/code-review`·`/security-review`(인증이라 필수)·self-reviewer·doc-consistency, Linux 이미지 빌드·크기 | 병합 **전에** 돌린다(`CLAUDE.md` 13절) |
| 미정 | 토큰 만료 상한을 운영 설정으로 조절할지(Q2) | 지금은 상수다. 필요해지면 `settings`에 키 하나 |
| ~~미정~~ | ~~마크다운 변환기를 직접 쓸지 의존성을 들일지~~ → **직접 썼다**(사용자 결정 2026-10-07 — 허용 목록 밖을 만들지 않는 것을 코드로 통제하고 이미지를 늘리지 않는다) | 3.4절 |

## 8. 이 설계가 보지 않은 것

- 빈도 제한 값 — 4단계에서 실측으로 정한다.
- 실제 호출 — 지금까지는 통합 시험·가드 시험으로만 본다. 8단계에서 이미지를 띄워 curl로 본다.
- 원 저장소 병합 방식 — 계획서 8절 위험 6, 원 저장소 주인이 PR에서 정한다.
