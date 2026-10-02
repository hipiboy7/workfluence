# 계획서 — 공개 API v1 (JWT 인증)

- 작성일: 2026-10-02 / 작성 LLM: Claude Opus 5.5
- 상태: **초안** — 3절의 결정 요청이 닫히면 설계서로 옮기고, 이 문서는 설계서를 가리키는 줄만 남긴다 ([README](README.md))
- 근거 원문: [`요청원문.md`](요청원문.md) · 커버리지 분석: [`분석서_시나리오커버리지.md`](분석서_시나리오커버리지.md) (G1~G5)
- 구현 방식: **TDD** (사용자 지시 2026-10-02 "TDD 방식으로 구현") — 5절

## 1. 목표와 범위

**목표.** LLM 에이전트와 2차 개발자가 브라우저 없이 workfluence의 기능을 쓴다. 사람은 화면에서 자기 이름으로 **JWT를 발급**받아 프로그램에 넘기고, 프로그램은 `Authorization: Bearer <JWT>`로 `/api/v1/*`를 부른다. 프로그램은 **발급한 사람의 권한 안에서만** 동작한다 — 새 권한 체계를 만들지 않는다.

| 연다 | 열지 않는다 (사용자 결정) |
|---|---|
| 스페이스·분류·Crew, 페이지(트리·읽기·쓰기·옮기기·지우기·버전·비교·복원·HTML 내보내기), 댓글, 라벨, 첨부(올리기·받기·지우기), 검색, 템플릿, 휴지통, 알림, 사내 LLM(질문·대화·지시문), **관리 기능**(사용자 관리·정책·감사로그·LLM 연결 — 역할과 위임이 허락하는 사람만), 내 정보(`me`), 상태 확인 | **계정 흐름** — 로그인·가입·로그아웃·ID 찾기·비밀번호 변경/찾기/재설정·OIDC. **실시간 편집** — WebSocket 협업과 그 보조 경로(`collab/title`·`collab/flush`). 외부는 REST 저장(기준 버전 + 409)만 쓴다 |

## 2. 확정된 결정

| # | 쟁점 | 답 (사용자) |
|---|---|---|
| 1 | 인증 | 개인 토큰, 형식은 **JWT** |
| 2 | 경로 | 화면용 `/api/*`와 **따로 `/api/v1/*`** — 외부 계약은 화면 사정으로 바뀌지 않는다 |
| 3 | 제외 범위 | 계정 흐름·실시간 편집만. 관리 기능과 사내 LLM 질문은 연다 |
| 4 | 명세 | OpenAPI JSON + 문서. Swagger UI는 싣지 않는다 (이미지 예산 400MB에 여유 약 10MB — 보류 7의 판단) |

## 3. 결정 요청 (설계서 전에 닫는다)

| # | 물음 | 선택지 | 추천과 이유 |
|---|---|---|---|
| Q1 | **JWT를 누가 어떻게 발급하나** | (가) 서버가 서명하는 **긴 수명 JWT**를 사용자가 화면에서 발급 (나) 화면에서 받은 API 키를 `POST /api/v1/auth/token`에 내고 **짧은 수명(15분) JWT**를 받는다 (다) 사내 IdP가 발급한 access token(JWT)을 JWKS로 검증 | **(가)**. 에이전트 설정이 가장 단순하다(값 하나). (나)는 키 노출 시간을 줄이지만 클라이언트가 갱신 로직을 가져야 한다. (다)는 사내 IdP 실연동이 아직 확인되지 않았다(보류 11) |
| Q2 | 만료 | 필수·최대 365일·기본 90일 / 만료 없음 허용 | **필수·최대 365일·기본 90일.** 상한은 운영 설정(관리 화면)으로 조절 |
| Q3 | 권한 범위(scope) | `read` / `write` 두 단계 / 모듈별 세분 / 없음(사람 권한 전부) | **`read`·`write` 두 단계.** 에이전트에 읽기만 주는 경우가 가장 흔하다. 세분은 요구가 오면 더한다 |
| Q4 | 관리 기능을 토큰으로 할 때 | 그대로 허용 / `admin` scope를 따로 켜야 허용 | **`admin` scope를 따로.** 관리자의 읽기용 토큰이 새어도 사용자 정지·역할 변경은 못 한다 |
| Q5 | 한 사람의 토큰 수 | 10개 / 무제한 | **10개** (`constants`) |
| Q6 | 사람이 실시간 편집 중인 페이지에 에이전트가 저장하면 (분석서 G2) | (가) 409 `PAGE_BEING_EDITED` (나) 방을 먼저 저장하고 기준 버전으로 판정 | **(가)** — 사람의 입력을 절대 건드리지 않는다 |
| Q7 | 본문 형식 (분석서 G1) | 마크다운 읽기·쓰기를 v1에 넣는다 / JSON만 | **넣는다** — LLM 에이전트가 JSON 트리를 직접 쓰면 자주 틀린다 |

> **답이 오기 전에는 추천안으로 진행한다** — 사용자 지시 "TDD 방식으로 구현"을 진행하라는 뜻으로 읽었다. 추천과 다르게 정하면 그 단계부터 고친다.

## 4. 설계 개요

### 4.1 JWT

- **서명**: HS256, 비밀 키는 새 환경변수 `WF_API_JWT_SECRET`(32바이트 이상, 없으면 공개 API가 꺼진 채 뜬다 — 꺼짐/켜짐은 설계서에서 확정). 라이브러리는 이미 쓰는 `jose`(MIT) — 새 의존성 없음.
- **클레임**: `iss`=workfluence, `aud`=workfluence-api, `sub`=사용자 id, `jti`=토큰 id, `iat`, `exp`, `scope`.
- **순수 JWT만으로는 끊지 못한다.** 이 시스템은 정지·세션 종료가 **그 자리에서** 먹어야 한다(`CLAUDE.md` 7절 계정 생명주기). 그래서 요청마다 `jti`로 토큰 행을 보고(폐기·만료) 사용자 행을 다시 읽는다(정지·역할·위임). 세션 가드가 요청마다 사용자 행을 읽는 것과 같은 길이다(`apps/api/src/auth/auth.guard.ts`).
- **검증 순서** (A등급 순수 로직, 테스트 먼저): 헤더 모양 → 서명·`alg` 고정 → `iss`·`aud`·`exp` → 토큰 행(있음·폐기 안 됨) → 사용자(`active`, 비밀번호 변경 강제 아님) → scope가 요청 메서드·경로에 맞는가 → 기존 `can()` 판정(`packages/shared/src/permissions.ts`).
- **토큰 값은 발급 때 한 번만 보인다.** DB에는 값을 두지 않는다(서명으로 검증하고 `jti`로 찾는다). 로그·감사에 토큰을 싣지 않는다.
- **끊기는 때**: 사용자가 폐기, 관리자가 폐기, **정지·비밀번호 변경·관리자 강제 종료 때 그 사람의 토큰 전부**(세션과 같은 자리에서), 만료.
- **발급·폐기는 화면(세션)에서만.** 토큰으로 토큰을 만들지 못한다 — 새어 나간 토큰이 스스로를 늘리는 길을 막는다.

### 4.2 `/api/v1` 원칙

| 항목 | 규칙 |
|---|---|
| 인증 | **Bearer만 받는다. 쿠키는 보지 않는다** — 그래서 CSRF 헤더가 필요 없다(교차 출처 페이지는 Authorization 헤더를 붙일 수 없다). 화면용 `/api/*`는 지금 그대로 |
| 오류 | 한 모양: `{ "error": { "code", "message", "requestId" } }`. code는 고정 문자열 표(설계서) — 에이전트가 문장이 아니라 code로 분기한다 |
| 목록 | `limit`·`cursor` 한 방식 |
| 버전 | v1 안에서는 **더하기만** 한다(필드·경로 추가). 빼거나 뜻을 바꾸면 v2 |
| 빈도 제한 | 토큰별 제한(`RATE_LIMITS`에 더한다, `apps/api/src/common/rate-limit.guard.ts`), 넘으면 429 + `Retry-After` |
| 감사 | 토큰으로 한 일도 기존 감사 행위로 남기고 `detail.tokenId`를 싣는다. 토큰 발급·폐기는 새 감사 행위(`AUDIT_ACTIONS`) |
| LLM 질문 | 화면과 같은 SSE 흐름. 명세에 이벤트 모양을 적는다 |
| 첨부 | 올리기 multipart, 받기 바이너리 — 업로드 상한·확장자 규칙은 지금 그대로 |

### 4.3 OpenAPI

`GET /api/v1/openapi.json` (인증 없음). 요청 모양은 **이미 있는 zod 스키마**(`packages/shared/src/schemas.ts`)에서 zod 4 내장 JSON Schema 변환으로 만든다 — 손으로 쓰지 않으니 코드와 명세가 어긋나지 않는다. 계약 시험이 "v1의 모든 경로가 명세에 있고, 명세의 모든 경로가 v1에 있다"를 본다. 응답 모양도 zod로 두고 시험에서 실제 응답을 그 스키마로 검증한다.

### 4.4 공통 로직을 컨트롤러 밖으로

지금 컨트롤러가 트랜잭션·감사 기록·멘션 메일까지 한다(예: `apps/api/src/pages/pages.module.ts`의 페이지 만들기). `/api/v1`이 그것을 다시 쓰면 같은 규칙이 두 곳이 된다. 그래서 **먼저** 그 묶음을 서비스(유스케이스) 메서드로 옮기고, `/api/*`와 `/api/v1/*` 컨트롤러는 둘 다 그것을 부르는 얇은 층이 된다. 이 단계는 **동작을 바꾸지 않는다** — 기존 시험이 그대로 통과하는 것이 완료 기준이다.

## 5. TDD 진행 방식

원 저장소의 등급(`CLAUDE.md` 3절)을 그대로 쓰되, **이 스핀오프는 모든 등급에서 테스트를 먼저 쓴다**(사용자 지시).

| 등급 | 이 일에서 무엇 | 순서 |
|---|---|---|
| A (순수, ≥90%) | JWT 클레임 검증·scope 판정·토큰 만료 계산, 마크다운→문서 변환(G1), v1 오류 모양 | 실패하는 시험 → 최소 구현 → 정리. 커밋을 `test:`(Red) → `feat:`(Green) → `refactor:`로 나눠 **시험이 먼저였음이 이력에 남게** 한다 |
| B (실제 PostgreSQL) | 토큰 가드(정지·폐기·만료·비밀번호 변경 강제), 토큰 발급·폐기, v1 컨트롤러 모듈별, 편집 중 저장 409(G2), 세션 강제 종료가 토큰도 끊음(G3) | 모듈마다 "토큰으로 부르면 화면용과 같은 결과"를 먼저 쓴다 — 유스케이스 추출(4.4)은 **기존 시험이 안전망**이고 바꾸기 전에 빠진 시험을 먼저 더한다 |
| 계약 | OpenAPI ↔ 라우트 양방향 일치, 응답이 스키마를 지킴 | 명세 생성기보다 시험이 먼저 |
| C (E2E) | 발급 → 그 토큰으로 마크다운 페이지 만들기 → 폐기 → 401 | 화면 만들기 전에 시나리오를 먼저 쓴다 |

## 5-1. 엔드포인트 지도 (초안)

화면용 경로 97개 가운데 계정 흐름 15개(`me` 제외)·실시간 편집 2개를 뺀 것을 v1로 옮긴다. 경로 이름은 화면용과 같게 둔다(외워 둘 것이 하나).

| 모듈 | v1 경로 | 쓰기 scope |
|---|---|---|
| 나·토큰 | `GET /api/v1/me` · 토큰 관리는 화면용 `/api/tokens`(세션 전용) | — |
| 스페이스 | `GET/POST /spaces` · `GET/PATCH/DELETE /spaces/:id` · `PATCH /spaces/:id/status` · `GET/POST /spaces/:id/members` · `PATCH/DELETE /spaces/:id/members/:userId` | write |
| 분류 | `GET/POST /categories` · `PATCH/DELETE /categories/:id` | write |
| 페이지 | `GET /pages?spaceId=` · `GET/POST /pages` · `GET/PATCH/DELETE /pages/:id` · `PATCH /pages/:id/move` · `GET /pages/:id/versions[/:no]` · `GET /pages/:id/versions/:a/diff/:b` · `POST /pages/:id/versions/:no/restore` · `GET /pages/:id/export` | write |
| 댓글 | `GET/POST /pages/:pageId/comments` · `PATCH/DELETE /comments/:id` | write |
| 라벨 | `GET /labels` · `GET /labels/:name/pages` · `GET/POST /pages/:pageId/labels` · `DELETE /pages/:pageId/labels/:labelId` | write |
| 첨부 | `GET/POST /pages/:pageId/attachments` · `GET/DELETE /attachments/:id` | write |
| 검색 | `GET /search` | read |
| 템플릿 | `GET/POST /templates` · `PATCH/DELETE /templates/:id` | write |
| 휴지통 | `GET /trash/pages` · `GET /trash/spaces` · `POST /trash/{pages,spaces}/:id/restore` | write |
| 알림 | `GET /notifications` · `GET /notifications/unread-count` · `POST /notifications/:id/read` · `POST /notifications/read-all` | write |
| 사내 LLM | `GET /llm/providers` · 지시문 CRUD · 대화 목록·읽기·지우기·고정 · `POST /llm/ask`(SSE) · `POST /llm/stop` | write |
| 관리 | `/users` 10개 · `/settings/policy` · `/audit` · `/llm/admin/providers` 4개 | admin (Q4) |
| 상태 | `GET /health` (인증 없음) · `GET /openapi.json` (인증 없음) | — |

## 6. 만지는 곳

| 층 | 무엇 |
|---|---|
| DB | 손으로 쓴 마이그레이션 하나(`apps/api/drizzle`의 다음 번호) — 토큰 표(id=`jti`, 사용자, 이름, scope, 만든 때, 만료, 마지막 사용, 폐기). 앱 계정 권한(`apps/api/src/db/app-role.ts`) |
| 설정 | `WF_API_JWT_SECRET` — 같은 커밋에서 `.env.example`·설정 항목 표·`deploy/compose.yml`·`scripts/win-launcher.mjs` (`CLAUDE.md` 5절). 토큰 수·만료 상한·빈도 제한은 `packages/shared/src/constants.ts`, 만료 상한의 조절은 운영 설정 |
| shared | 토큰 DTO·scope 판정·JWT 클레임 검증(A등급), v1 응답 스키마, 감사 행위 |
| api | 유스케이스 추출(4.4) → JWT 가드 → 토큰 모듈 → v1 컨트롤러 → 오류 필터 → OpenAPI 생성 |
| web | 내 정보에 **API 토큰** 화면(발급·한 번 보기·복사·폐기·마지막 사용), 사용자 관리에 그 사람의 토큰 폐기 |
| 문서 | 이 디렉토리의 설계서·검증기록·API 사용가이드. 병합 때 본 문서에 가리키는 줄 — 장애대응가이드(401/403/429 증상), 사용자가이드(토큰 화면), 학습가이드, 설계서_Architecture 11절 |

## 7. 작업 단계

| 단계 | 하는 일 | 끝났다고 보는 것 |
|---|---|---|
| 0 | 환경 — 이 서버에 Node 24·pnpm 설치, `pnpm check:env` | `READY` (8절 위험 1·2) |
| 1 | 결정 요청(3절) 닫기 → 설계서 | 요구사항 표·API 계약·설정 항목 표 |
| 2 | 유스케이스 추출 (동작 그대로) | 기존 `pnpm check` 통과, 차이 없음 |
| 3 | JWT 검증 순수 로직 (A, 테스트 먼저) + 토큰 표 + 가드 + 발급·폐기 + 정지·세션 종료·비밀번호 변경 때 토큰 폐기(G3) | 정지·폐기·만료·scope 시험이 실제 PostgreSQL에서 통과 |
| 3-1 | 마크다운→문서 변환 (A, 테스트 먼저 — G1) | 왕복 성질 시험, 허용 목록 밖은 400 |
| 4 | v1 컨트롤러·오류 모양·빈도 제한, 본문 `format`(G1)·편집 중 409(G2)·`ancestors`(G4)·첨부 `src`(G5) | 모듈별 통합 시험 (토큰으로 호출) |
| 5 | OpenAPI 생성 + 계약 시험 | 경로 양방향 일치, 응답이 스키마를 지킨다 |
| 6 | 화면 — 토큰 관리 | E2E: 발급 → 그 토큰으로 페이지 만들기 → 폐기 → 401 |
| 7 | 문서 — API 사용가이드(curl·에이전트 도구 정의 예), 가이드에 가리키는 줄 | `pnpm verify:docs` 통과 |
| 8 | 검토 — `/code-review`·`/security-review`(인증이라 필수)·self-reviewer·doc-consistency, Linux 이미지 빌드·크기 | 검증기록에 수치, PR |

## 8. 위험과 막힌 것

| # | 무엇 | 대응 |
|---|---|---|
| 1 | **이 서버에 Node·pnpm이 없다** (2026-10-02 확인) | `CLAUDE.md` 8.1절대로 사용자 홈에 Node 24.21.0·corepack pnpm |
| 2 | **저장소가 OS 디스크에 있고 여유 2.8GB** (`/` 93%) — `check:env`의 3GB 기준 미달, 의존성 설치·임베디드 PG·이미지 빌드에 모자란다 | 데이터 디스크로 옮기거나 정리 — 사용자 확인 필요 |
| 3 | 이미지 예산 여유 약 10MB | 새 의존성 없음(jose·zod 기존). 빌드 뒤 실측 |
| 4 | v1과 화면용이 같은 규칙을 두 번 갖게 될 위험 | 4.4 — 컨트롤러는 얇게, 규칙은 유스케이스 한 곳 |
| 5 | 토큰이 새는 위험 (에이전트 로그·프롬프트에 실림) | 짧은 기본 만료, `read` 기본, 마지막 사용 시각·IP 표시, 즉시 폐기, 감사 |
| 6 | 원 저장소의 Phase 규칙(브랜치 `impl-phase{N}`, `P{N}_` 문서명)과 다른 자리 | README에 사유. 병합 여부와 방식은 원 저장소 주인이 PR에서 정한다 |
