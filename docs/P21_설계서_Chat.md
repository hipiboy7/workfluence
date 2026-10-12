# P21 설계서 — Chat (독립 메뉴의 채팅과 headless 접속 — F-016)

새 메뉴에 **방 단위 채팅**을 만든다. 사람은 화면으로, 사람 없이 도는 클라이언트(headless — 예: AI 에이전트)는 **API 토큰으로** 같은 방에 들어와 같은 메시지를 주고받는다.
새 메시지는 WebSocket으로 받는다. 위키 문서·스페이스와는 독립이다(방은 스페이스에 속하지 않는다).

- 요청 원문: `docs/prompts/phase21/scope.md` · 백로그 F-016
- 요구사항 번호: **FR-2400**, 비기능 **NFR-240**부터
- 선행: [`docs/P6_설계서_Collab.md`](P6_설계서_Collab.md)(실시간 편집의 WebSocket — 연결 수명·재판정 방식) · 공개 API(`docs/spinoff/public-api/설계서_PublicApi.md` — 토큰·scope·빈도 제한)
- 브랜치: `impl-phase21` (사용자 지시로 `tanminkwan-rest-api`에서 분기 — PR의 기준 브랜치도 그쪽이다)

## A. 착수 쟁점 (2026-10-12)

| # | 쟁점 | 사용자 답 | 이 설계가 한 것 |
|---|---|---|---|
| 1 | 채팅의 범위 | **"방 단위"** | 방 목록 · 방 만들기·초대 · 메시지 보내기·읽기. 스페이스·페이지에 붙은 채팅은 하지 않는다 |
| 2 | 새 메시지 수신 방식 | **"WebSocket"** | 사람 한 명(또는 headless 한 개)이 연결 **하나**를 열면 참여한 모든 방의 새 메시지가 온다 |
| 3 | 공개 API에 넣는가 | "api라기보다 headless 또는 background chat에 가까운거지?" → **이번 Phase에 함께 만든다** | 화면과 headless가 **같은 채팅 유스케이스**를 부른다. headless는 토큰(`Authorization: Bearer`)으로 WebSocket·REST에 닿는다 (C절) |
| 4 | 보존·삭제·감사 | **"나중에"** | 보류 39로 등재했다. 이번에는 메시지를 지우지 않고 보존 기간도 없다 — 단 **남기는 모양은 나중에 정책을 얹을 수 있게** 둔다 (F절) |

## A.1 묻지 않고 정한 것 — 근거와 되돌릴 조건

| # | 정한 것 | 근거 | 되돌릴 조건 |
|---|---|---|---|
| 1 | 방은 둘이다 — 1:1(`direct`, 두 사람 사이에 하나)과 여럿(`group`, 이름 있음) | 방 단위라는 답을 가장 작게 담는 모양이다. 1:1은 쌍마다 하나로 고정해 같은 두 사람이 방을 여럿 만들지 못하게 한다 | 1:1도 여러 개가 필요하다는 요청 |
| 2 | 방은 **활성 사용자 누구나** 만든다. 여럿 방은 만든 사람이 초대하고, 참여자는 스스로 나갈 수 있다 | 권한 체계(스페이스 Crew)를 새로 만들지 않는다 — 참여자인지 하나만 본다 | 관리자가 방을 막거나 초대 권한을 나눠야 할 때 |
| 3 | 메시지는 **평문**이다. 길이 상한은 설정(`WF_CHAT_MAX_MESSAGE_CHARS`). HTML로 그리지 않는다 | LLM 답을 평문으로 그린 것(CLAUDE.md 7절)과 같다 — 입력이 화면을 깨는 길을 막는다 | 서식(마크다운)을 원할 때 |
| 4 | 참여자가 아니면 방은 **없는 것과 같은 404**다 | 방이 있는지 드러내지 않는다(보류 34의 같은 결) | — |
| 5 | 정지된 사용자·세션 만료·토큰 폐기는 **그 연결을 그 자리에서 끊는다** | 실시간 편집과 같은 규칙(Phase 7) | — |
| 6 | 보내는 쪽이 **`clientMsgId`**(그 연결이 정하는 임의 문자열)를 붙이면 서버가 같은 값의 되풀이를 한 번만 받는다 | headless는 연결이 끊겼다 다시 보낼 때 같은 메시지를 두 번 보내기 쉽다 | — |

## B. 요구사항

| ID | 요구 | 확인 |
|---|---|---|
| FR-2400 | 로그인한 사용자는 **새 메뉴 "채팅"**에서 자기가 참여한 방 목록을 본다(마지막 메시지 시각 순, 안 읽은 수 포함) | 컴포넌트·E2E |
| FR-2401 | 사용자는 다른 활성 사용자를 골라 **1:1 방**을 연다(이미 있으면 그 방) | 통합 |
| FR-2402 | 사용자는 이름과 참여자를 골라 **여럿 방**을 만들고, 만든 사람은 사람을 초대하며, 참여자는 나간다 | 통합 |
| FR-2403 | 참여자는 방에서 메시지를 보내고, 방의 이전 메시지를 **쪽 나누어**(`beforeSeq`·`limit`) 읽는다 | 통합 |
| FR-2404 | 메시지는 방마다 **1부터 이어지는 번호(`seq`)**를 가진다. 같은 방의 메시지는 번호 순서가 곧 도착 순서다 | A·통합 |
| FR-2405 | 연결한 클라이언트는 참여한 모든 방의 **새 메시지를 그 자리에서** 받는다. 새 방에 초대되거나 나가면 연결을 다시 열지 않아도 반영된다 | 통합 |
| FR-2406 | 연결이 끊겼다 돌아온 클라이언트는 방마다 `afterSeq`로 **놓친 메시지**를 받는다(REST) — 연결이 보내 주는 것은 새 것뿐이다 | 통합 |
| FR-2407 | 읽음 표시 — 참여자는 방마다 **마지막으로 읽은 번호**를 올린다. 안 읽은 수 = 그 뒤 메시지 수 | 통합 |
| FR-2410 | **headless 접속** — 공개 API 토큰으로 `/api/v1/chat/*`(REST)와 `/api/v1/chat/ws`(WebSocket)에 닿는다. 읽기(`read` scope)는 방·메시지 읽기와 수신, 쓰기(`write`)는 보내기·방 만들기·읽음 | 통합 |
| FR-2411 | 토큰으로 연 연결은 **토큰이 죽으면(폐기·만료·정지·비밀번호 변경·세션 강제 종료) 그 자리에서** 끊기고, 권한이 줄면 주기 재판정이 끊는다 | 통합 |
| FR-2412 | 브라우저 연결은 세션 쿠키 + **같은 출처(`Origin`)**만 받는다. 토큰 연결은 `Origin`을 보지 않는다(브라우저가 아니다) | 통합 |
| FR-2420 | 설정으로 채팅을 끈다(`WF_CHAT_ENABLED=false`) — 끄면 메뉴가 사라지고 연결·REST가 거절된다 | 통합 |
| NFR-240 | 보내기 한도 — 연결마다 분당 N건(`WF_CHAT_SEND_PER_MIN`). 넘으면 그 메시지만 거절하고 연결은 둔다 | 통합 |
| NFR-241 | 한 사용자의 동시 연결 상한(`WF_CHAT_MAX_CONNECTIONS_PER_USER`) — 넘으면 **가장 오래된 연결을 닫는다**(에이전트가 재접속을 되풀이해도 쌓이지 않는다) | 통합 |
| NFR-242 | 메시지 본문을 **로그에 남기지 않는다**(CLAUDE.md 7절) | 로그 대조 |

## C. 연결과 인증

### C.1 한 연결, 두 입구

| | 사람(화면) | headless |
|---|---|---|
| 주소 | `wss://…/api/chat/ws` | `wss://…/api/v1/chat/ws` |
| 인증 | 세션 쿠키 | `Authorization: Bearer <토큰>` (업그레이드 요청의 헤더) |
| 출처 확인 | `Origin`이 같은 출처 | 하지 않는다 |
| 권한 | 로그인한 사용자 | 토큰의 scope ∩ 그 사람의 권한 |
| 끊는 때 | 세션 파기·정지 | **토큰** 폐기·만료·정지·세션 파기 |

두 입구는 **인증만 다르고** 인증이 끝나면 같은 `ChatGateway` 코드로 합쳐진다(DIP — 인증 결과는 `{userId, 끊김 열쇠}`).
토큰이 URL의 질의 문자열로 오는 것은 받지 않는다(로그에 남는다 — CLAUDE.md 7절).

### C.2 메시지 모양 (JSON 텍스트 프레임)

| 방향 | `type` | 내용 |
|---|---|---|
| 서버→클라 | `hello` | 연결이 선 직후 — `userId`, 참여한 방 id 목록 |
| 클라→서버 | `send` | `roomId`, `body`, `clientMsgId`(선택) |
| 서버→클라 | `ack` | `clientMsgId`, `roomId`, `seq`, `createdAt` — 보낸 사람에게만 |
| 서버→클라 | `message` | `roomId`, `seq`, `senderId`, `body`, `createdAt` — **보낸 사람 포함** 참여자 모두 |
| 서버→클라 | `room` | 방이 생기거나 초대·나감 — `roomId`, `change` |
| 서버→클라 | `error` | `code`, `roomId?`, `clientMsgId?` — 그 메시지만 거절하고 연결은 둔다 |
| 양쪽 | 프로토콜 ping/pong | 30초 주기 — 응답이 없으면 끊는다(실시간 편집과 같다) |

모르는 `type`·너무 큰 프레임·JSON이 아닌 것은 **연결을 닫는다**(편집 관문의 규칙과 같다 — 조작한 연결이 서버에 일을 시키지 못하게).

## D. 데이터 모델 (마이그레이션 `0015_chat.sql` — 손으로 쓴다)

| 표 | 칸 | 비고 |
|---|---|---|
| `chat_rooms` | `id` uuid, `kind` (`direct`/`group`), `name` text null, `created_by` uuid, `created_at`, `last_seq` bigint(기본 0) | 1:1은 `name` 없음. `last_seq`는 새 메시지의 번호를 매기는 곳(행 잠금) |
| `chat_members` | `room_id`, `user_id`, `joined_at`, `last_read_seq` bigint(기본 0), 기본키(`room_id`,`user_id`) | 나가면 행을 지운다(되돌리기 없음) |
| `chat_direct_pairs` | `user_a`, `user_b`(`user_a < user_b`), `room_id` | 쌍의 유일성. 1:1 만들기가 두 사람 순서와 무관하게 같은 방을 돌려준다 |
| `chat_messages` | `id` uuid, `room_id`, `seq` bigint, `sender_id`, `body` text, `client_msg_id` text null, `created_at` | 고유(`room_id`,`seq`) · 고유(`room_id`,`sender_id`,`client_msg_id`) — 같은 값의 되풀이를 한 번만 받는다 |

- 번호 매기기: 보낼 때 `chat_rooms` 행을 `FOR UPDATE`로 잠그고 `last_seq + 1`을 받는다 — 방 안에서 번호가 비지도 겹치지도 않는다.
- 메시지는 **고쳐 쓰지도 지우지도 않는 모양**으로 둔다(보류 39 — 정책이 정해지면 그 위에 얹는다). 앱 DB 계정에는 UPDATE·DELETE를 주지 않는 방안을 보류 39에서 본다.
- 앱 계정은 새 표에 SELECT·INSERT(`chat_rooms`·`chat_members`는 UPDATE·DELETE까지)를 받는다 — `apps/api/src/db/app-role.ts`가 줄 권한 목록에 더한다(CLAUDE.md 9.2절).

## E. API

화면용은 세션 + CSRF 머리말, headless용은 토큰이다. **본문과 응답은 같고** 경로 앞머리만 다르다(`/api/chat/…` ↔ `/api/v1/chat/…`).

| 메서드·경로 | 하는 일 | scope |
|---|---|---|
| `GET /rooms` | 내가 참여한 방 — 마지막 메시지 시각 순, `unread` 포함 | read |
| `POST /rooms` | `{kind:'direct', userId}` 또는 `{kind:'group', name, userIds[]}` | write |
| `POST /rooms/{id}/members` | 여럿 방에 초대(만든 사람만) | write |
| `DELETE /rooms/{id}/members/me` | 방에서 나가기 | write |
| `GET /rooms/{id}/messages` | `beforeSeq`·`afterSeq`·`limit`(기본 50, 상한 200) | read |
| `POST /rooms/{id}/messages` | 보내기(`body`, `clientMsgId`) — WebSocket을 못 쓰는 곳용 | write |
| `PUT /rooms/{id}/read` | `{seq}` — 읽음 표시 | write |
| `GET /users` | 방에 부를 사람 찾기(이름) — 활성 사용자만, 이름·id만 | read |

공개 API의 명세(`openapi.yaml`)에는 위 REST를 **설명과 함께** 더한다(칸 설명이 빠지면 시험이 실패한다). **WebSocket은 OpenAPI가 표현하지 못하므로** 명세의 머리말(`info.description`)과 API사용가이드에 연결 방법·프레임 모양·재접속 규칙을 쓴다 — 에이전트가 명세만 읽고 접속할 수 있어야 한다.

## F. 보류 (보류 39로 등재)

보존 기간·메시지 삭제·관리자의 열람·감사 기록 대상 여부는 **나중에 정한다**(사용자 답 4). 이번에 하지 않는 것을 분명히 한다.

- 메시지는 지우지 않는다. 보존 기간이 없다.
- 관리자도 남의 방을 읽는 경로가 없다.
- 감사 기록에 채팅을 더하지 않는다(내용 없이 남길지는 그때 정한다). 다만 **연결 거절·한도 초과는 앱 로그**(`event` 코드, 내용 없이)에 남긴다.
- 트리거: 사내 보안 검토가 채팅의 보존·감사를 묻거나 방 수·메시지 수가 쌓여 정리가 필요할 때.

## G. 모듈과 등급

| 모듈 | 위치 | 등급 |
|---|---|---|
| 방 접근 판정(참여자인가·초대할 수 있는가) · 프레임 모양 검증 · 번호·쪽 나누기 계산 | `packages/shared/src/chat/**` | A (테스트 먼저) |
| 보내기 한도·되풀이(`clientMsgId`) 판정 | `apps/api/src/chat/domain/**` | A |
| 채팅 유스케이스(방·메시지·읽음) | `apps/api/src/chat/chat.service.ts` | B (실제 PostgreSQL) |
| 연결 게이트웨이(업그레이드·인증·재판정·끊기·방 구독) | `apps/api/src/chat/chat.gateway.ts` | B |
| 화면용·headless용 컨트롤러 | `apps/api/src/chat/*.controller.ts`, `apps/api/src/v1/v1-chat.controller.ts` | B |
| 채팅 화면(방 목록·메시지·보내기) · 연결 상태 기계(`chatLink.ts` — React 밖) | `apps/web/src/` | B(상태 기계는 Node 시험) |
| E2E — 두 브라우저가 한 방에서 주고받는다 · headless 클라이언트가 토큰으로 받고 답한다 | `e2e/` | C |

## H. 설정 항목 (모두 `WF_` — 4곳 갱신: `.env.example`·이 표·`deploy/compose.yml`·`scripts/win-launcher.mjs`)

| 키 | 기본 | 뜻 |
|---|---|---|
| `WF_CHAT_ENABLED` | `true` | 채팅 켜기·끄기 |
| `WF_CHAT_MAX_MESSAGE_CHARS` | `4000` | 메시지 한 건의 글자 상한 |
| `WF_CHAT_SEND_PER_MIN` | `60` | 연결마다 분당 보내기 한도 |
| `WF_CHAT_MAX_CONNECTIONS_PER_USER` | `5` | 한 사용자의 동시 연결 상한 |
| `WF_CHAT_PING_MS` | `30000` | ping 주기 |
| `WF_CHAT_RECHECK_MS` | `300000` | 권한·세션·토큰 재판정 주기 |
| `WF_CHAT_MAX_FRAME_BYTES` | `65536` | 한 프레임 상한 — 넘으면 닫는다 |

(값은 착수 때의 가정이다 — 실측으로 고치면 이 표를 먼저 고친다.)

## I. 만들 때 풀어야 하는 것 (착수 뒤 확인)

1. **토큰 단위로 끊기** — 지금의 `RevocationBus`는 사용자·세션 열쇠로 끊는다. 토큰 하나만 폐기해도 그 토큰의 연결이 끊겨야 하므로, 토큰 id를 열쇠로 받는 길을 버스에 더할지 주기 재판정에 맡길지 정한다(FR-2411).
2. **여러 앱 인스턴스** — 이중화는 하지 않으므로(0.1절) 방 구독은 **프로세스 안 메모리**다. 보류 6이 닫혀 있어 문제가 없다.
3. **업그레이드 분기** — 한 서버에 업그레이드 처리기가 둘(편집·채팅)이 되면 **경로로 나눠 우리 경로가 아니면 닫는다**(편집 게이트웨이의 자체 점검 13과 같은 사고를 막는다). 같은 처리기 하나로 경로를 가르는 방안도 본다.
4. **빈도 제한의 이중 적용** — 토큰의 읽기 120·쓰기 30/분 한도가 WebSocket 보내기에도 걸리는지, `WF_CHAT_SEND_PER_MIN`만 쓰는지 정한다. 에이전트가 대화에 쓰기 한도 30이 빠듯하면 안 된다.
