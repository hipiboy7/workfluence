# P16 설계서 — Crew (관리자가 건 중지 동안 Crew를 얼린다)

Phase 16은 보류 35를 사용자의 답으로 닫는다. 관리자가 조사하려고 공간을 멈춰 둔 동안에도 주인은 Crew에 사람을 더해 읽을 사람을 넓힐 수 있었다(Phase 15 전부터 —
Crew 관리는 공간의 상태를 보지 않았다). 이제 **관리자가 건 중지 동안에는 주인이 Crew를 바꾸지 못한다.**

- 요청 원문: `docs/prompts/phase16/scope.md`
- 요구사항 번호: **FR-1700**, 비기능 **NFR-160**부터
- 선행: [`docs/P15_설계서_Grants.md`](P15_설계서_Grants.md) C.2(관리자가 건 중지)·D.6 · [`docs/P2_설계서_Page.md`](P2_설계서_Page.md) FR-311·312(Crew)
- 구조: [`docs/설계서_Architecture.md`](설계서_Architecture.md)

---

## A. 착수 쟁점 (2026-09-28)

| # | 쟁점 | 사용자의 답 | 이 설계에서의 뜻 |
|---|---|---|---|
| 1 | 보류 35 — 어느 중지에서 막나 | "보류 35번 진행해줘." → 고른 안: **관리자가 건 중지만** | `suspended_by_owner`가 거짓인 중지(관리자가 건 것 — 모르면 관리자가 건 것으로 친다, P15 D.2)에서만 막는다. 주인이 스스로 건 중지와 활성인 공간은 그대로다 |
| 2 | 무엇을 막나 | 고른 안: **넣기·빼기·자리 바꾸기 모두** | 주인의 Crew 관리 셋(`POST`·`PATCH`·`DELETE /api/spaces/:id/members…`)을 모두 막는다. 관리자는 언제나 한다 |

## A.1 묻지 않고 정한 것 — 근거와 되돌릴 조건

| # | 정한 것 | 근거 | 되돌릴 조건 |
|---|---|---|---|
| 1 | **판정은 `spaceAccess.canManageMembers` 한 곳**이다 — 팀 공간에서 `admin || (isOwner && !관리자가 건 중지)` | 서버의 Crew 관리 셋(`assertManage`)과 화면의 Crew 칸(넣기 칸·자리 고르기·제거)이 이미 그 값 하나를 본다. 한 곳을 바꾸면 둘이 함께 따라온다(`CLAUDE.md` 7절 "판정은 한 곳") | — |
| 2 | **"관리자가 건 중지 풀기"를 받은 주인도** 관리자가 건 중지 동안에는 Crew를 바꾸지 못한다 — 먼저 다시 쓰기로 푼다 | 얼리는 것은 중지의 상태다. 풀 권한이 있으면 풀고 나서 바꾸면 된다. 권한마다 예외를 두면 "얼었는지"를 한 번에 알 수 없다 | — |
| 3 | 막힌 주인에게는 **까닭을 말한다** — 서버는 "관리자가 중지한 스페이스다 — Crew는 관리자가 바꾼다", 화면의 Crew 칸은 넣기 칸 대신 그 안내를 보인다 | 단추만 사라지면 권한을 잃은 줄 안다(P15 FR-1612와 같은 원칙) | — |
| 4 | Crew **목록 보기**는 막지 않는다 | 읽기는 중지와 무관하다(중지는 읽기만 되는 상태다) | — |

## B. Confluence 대조 (`CLAUDE.md` 4절)

| 기능 | Confluence | 여기 | 이유 |
|---|---|---|---|
| 보관한 스페이스의 권한 | 보관해도 스페이스 관리자가 권한을 바꾼다 | **변형** — 관리자가 건 중지에서는 주인이 Crew를 바꾸지 못한다(관리자는 바꾼다) | 사용자 결정(착수 쟁점 1·2). 관리자가 조사하려고 멈춘 공간을 주인이 남에게 열지 못하게 |

## C. 요구사항

| # | 요구사항 | 근거 |
|---|---|---|
| FR-1700 | **관리자가 건 중지** 동안 주인(팀 공간을 만든 사람·Crew의 owner)은 Crew를 넣지도 빼지도 자리를 바꾸지도 못한다 — 403 "관리자가 중지한 스페이스다 — Crew는 관리자가 바꾼다". "관리자가 건 중지 풀기"를 받았어도 같다 | 착수 쟁점 1·2, A.1-2 |
| FR-1701 | 주인이 스스로 건 중지와 활성인 공간에서는 주인이 지금처럼 Crew를 바꾼다. 관리자는 언제나 바꾼다 | 착수 쟁점 1 |
| FR-1702 | 화면의 Crew 칸은 막힌 주인에게 넣기 칸·자리 고르기·제거를 보이지 않고, 그 까닭을 보인다. Crew 목록은 그대로 보인다 | A.1-3·4 |
| NFR-160 | 판정은 `spaceAccess` 한 곳이다 — A등급 시험이 중지의 상태(활성·주인이 건 중지·관리자가 건 중지·모름)마다 주인·관리자·위임 받은 주인을 본다 | `CLAUDE.md` 7절 |

## D. 설계

- **`spaceAccess`**(A등급, `packages/shared/src/permissions.ts`) — 팀 공간의 `canManageMembers`를 `admin || (isOwner && !adminSuspended)`로 한다.
  `adminSuspended`는 `status === 'suspended' && suspendedByOwner !== true`다(모르면 관리자가 건 것 — `canResume`과 같은 기준, P15 D.2). 개인 공간은 그대로
  `false`다(Crew가 없다).
- **서버**(`apps/api/src/spaces/spaces.service.ts` `assertManage`) — 판정 결과를 그대로 쓴다. 막힌 사람이 주인이면 까닭을 나눠 말한다(A.1-3). 데이터·마이그레이션은
  없다.
- **화면**(`apps/web/src/pages/SpacePage.tsx`) — Crew 칸은 이미 `access.canManageMembers`로 넣기 칸·자리 고르기·제거를 보인다. 막힌 주인에게 안내 한 줄을 더한다.

## E. 데이터 모델 · I. 설정 항목

없다 — 새 열·환경변수·정책값이 없다.

## F. API 계약

| 경로 | 바뀜 |
|---|---|
| `POST /api/spaces/:id/members` · `PATCH`·`DELETE /api/spaces/:id/members/:userId` | 관리자가 건 중지 동안 주인은 403(관리자는 된다) |
| `SpaceView.access.canManageMembers` | 관리자가 건 중지면 주인에게 거짓 |

## H. 모듈과 등급

| 모듈 | 경로 | 등급 | 하는 일 |
|---|---|---|---|
| 스페이스 판정 | `packages/shared/src/permissions.ts` | **A** | `spaceAccess.canManageMembers`(D) |
| 스페이스 서비스 | `apps/api/src/spaces/spaces.service.ts` | B | 막힌 주인의 까닭(`assertManage`) |
| 화면 | `apps/web/src/pages/SpacePage.tsx` | B | Crew 칸의 안내 |

## J. 보류 결정 처리

- **보류 35 → 닫는다**(착수 쟁점 1·2).

## K. 구현 순서

1. A등급 Red → Green — `spaceAccess.canManageMembers`
2. 서버 — 막힌 주인의 까닭(통합 시험 — 넣기·자리 바꾸기·빼기 셋, 관리자, 주인이 건 중지, 다시 쓰게 한 뒤)
3. 화면 — Crew 칸의 안내(컴포넌트 시험). E2E의 "관리자가 건 중지" 흐름에 Crew 칸을 더한다
4. 문서 — 사용자 가이드·학습가이드·장애대응·운영이관·범위·규칙서, 검증기록
