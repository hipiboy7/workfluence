# Phase 21 — 요청 원문

> 사용자가 한 말만 그대로 둔다(`CLAUDE.md` 11절). 정리·판정은 `docs/기능백로그.md` F-016과 이 Phase의 설계서에 있다.

## 2026-10-12 — 공개 API 작업 뒤 새 일을 시작하며

> 이제부터 지금까지 와는 완전히 독립적인 내용을 개발할꺼야.   독립적인 menu에  chatting ui를 구현할꺼야.

> main에서 분기하지 말고 현재 branch에서 분기해

- 브랜치: `impl-phase21`을 `tanminkwan-rest-api`에서 분기했다

## 2026-10-12 — Claude가 물은 결정에

> 1번 방 단위, 2번 WebSocket, 3번은 api라기보다 headless 또는 background chat 에 가까운거지? 4번은 나중에

- 1번: 범위 — 방 단위 · 2번: 새 메시지 수신 — WebSocket · 3번: 사람 없이 접속하는 클라이언트(headless) · 4번: 보존·삭제·감사는 나중에

> 2번으로 해

- 고른 안: headless 접속(토큰으로 WebSocket 연결)을 이번 Phase에 함께 만든다
