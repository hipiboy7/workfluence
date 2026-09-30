# P19 검증기록 — Recovery (비밀번호를 잊었을 때 두 길 · 편집기 서식 단추 줄 — F-011 · F-013)

- 작성일: 2026-09-30 / 작성 LLM: Claude Opus 5.5
- 설계: [`docs/P19_설계서_Recovery.md`](P19_설계서_Recovery.md) · 검토: 7절과 [`docs/internal/P19_검토서_Review.md`](internal/P19_검토서_Review.md)
- 요청 원문: `docs/prompts/phase19/scope.md` (F-011의 첫 요청과 "이름은 표시 이름" 답은 `docs/기능백로그.md` F-011, F-013의 첫 답은 `docs/prompts/phase17/scope.md`)
- 시행착오는 [`docs/internal/검토서_트러블슈팅.md`](internal/검토서_트러블슈팅.md)에만 적는다 — 이 Phase는 T-094(gitleaks가 시험의 가짜 비밀번호를 또 잡았다)·T-095(E2E 뒷정리가 다른 파일의 알림 받는 사람을 지웠다)

## 1. 요구사항과 확인

요구사항의 글은 설계서 B절이 단일 출처다. 여기에는 무엇으로 확인했는지만 적는다.

| # | 확인 | 어디서 |
|---|---|---|
| FR-2000 | 두 길의 조건은 표시 이름 + email(이름은 앞뒤 빈칸만 떼고 그대로, email은 소문자). 맞든 틀리든 `{ok: true}` | A등급 `packages/shared/src/schemas.spec.ts` · 통합 `apps/api/src/auth/recovery.integration.spec.ts`·`auth.integration.spec.ts`(정지된 사람은 대상이 아니다 — 표시 이름으로, 병합 전 검토에서 있으나 마나이던 것을 고쳤다) · E2E `e2e/auth.spec.ts` |
| FR-2001 | 관리자에게 초기화 요청 — 맞는 활성 로컬 계정이면 그 사람을 관리할 수 있는 관리자·시스템 관리자의 알림. 글은 "이름·email로" | 통합 · 화면 `NotificationText.spec.tsx` · E2E(알림 영역에서 받고 초기화하면 읽음) |
| FR-2002 | 내 email로 재설정 링크 — 받을 수 있는 계정(member·admin 활성 로컬)에게만 한 통, 응답을 기다리지 않는다 | A등급 `permissions.spec.ts` · 통합(가짜 발송이 받은 것) · E2E `e2e/recovery.spec.ts`(가짜 사내 메일 서버가 받은 링크) · 컨테이너(5절 — nginx를 지나 가짜 메일 서버가 받은 한 통) |
| FR-2003 | 30분·한 번·새 요청이 옛 것을 죽인다·비밀번호가 바뀌거나 받을 수 없게 되면 쓰지 못한다. **정지하면 링크를 지운다**(병합 전 검토) | A등급 `apps/api/src/auth/domain/reset-link.spec.ts` · 통합(동시에 두 번이면 하나 · 30분 뒤 · 관리자 초기화 뒤 · 정지·해제 뒤) · 컨테이너(같은 링크 두 번째는 400) |
| FR-2004 | 한 계정에 5분에 한 통 — 그 사이는 `throttled`. **보내기가 실패해도 값과 간격은 그대로**(병합 전 검토 — 두 번 고쳤다, 검토서 2절 ④) | A등급 · 통합(실패해도 닿은 링크를 쓴다 · 실패 뒤 5분 안의 요청은 보내지 않는다) · 컨테이너(곧바로 다시 누르면 메일이 가지 않았다) |
| FR-2005 | 서버에는 해시만, 값은 `#` 뒤, 화면이 읽자마자 지운다, 로그·감사에 값이 없다 | 통합(표에 값이 없다) · 화면 `ResetPasswordPage.spec.tsx`(같은 탭에 붙여 넣은 새 링크의 값도) · 컨테이너(api·nginx 로그에서 값 0건) |
| FR-2006 | 새 비밀번호 — 로그인 줄 안에서, **새 해시도 줄 안에서**(병합 전 보안 검토 1), 사용자 행을 잠그고 줄 앞과 같은 판정, 세션·링크 삭제·잠금 해제·알림 읽음·편집 연결 끊기 | 통합(줄을 쥔 동안 해시를 만들지 않는다 · 잠금은 트랜잭션으로 · 줄에서 기다리는 사이 바뀐 것) · E2E · 컨테이너(옛 비밀번호 401 · 새 비밀번호 201 · 남은 세션은 새 로그인 하나) |
| FR-2007 | 틀린 링크는 하나의 400 문장, 감사에 까닭(`unknown`·`expired`·`changed`·`ineligible`) — 줄 안의 거절도 같은 트랜잭션에 | 통합(까닭 넷 · 기록을 못 남기면 링크도 남는다 · 시계만 앞으로 돌린 `expired`) · 컨테이너(감사 `reason: unknown`) |
| FR-2008 | 쓸 수 있는가 — 메일 켜짐 · 모의 아님 · 공개 주소 · 운영 설정. 아니면 단추 없음·404(이미 보낸 링크도). 운영 설정을 읽지 못하면 끈 것으로 답한다 | A등급 `reset-link.spec.ts`·`policy.spec.ts` · 통합(`auth.config_failed`) · 화면 `FindAccountPage.spec.tsx`·`AdminPolicyPage.spec.tsx` · 컨테이너(켠 설정 `resetMailEnabled: true` · 원래 설정 `false`) |
| FR-2009 | "이메일이 기억이 안나시나요?" — 아이디+이름이 맞는 활성 로컬 계정이면 시스템 관리자(자기 제외)에게만, 읽지 않은 같은 요청은 또 만들지 않는다, 지금 root일 때만 보인다 | 통합 · 화면 `EmailHelpPage.spec.tsx` · E2E · 컨테이너(root 넷에 한 번씩, 두 번 눌러도 넷) |
| FR-2010 | 감사 — 요청(`found`·`result`), 재설정(성공·까닭), email 확인(`found`), 메일(`kind: password_reset`). email은 가린다 | 통합 · 컨테이너(학습가이드 6.19의 명령을 적힌 그대로 — 5절) |
| FR-2011 | IP별 제한 — 메일 재설정 3/10분 · 새 비밀번호 10/10분 · email 확인 3/10분 | A등급 `constants.spec.ts`(값) · 통합(경로마다 `@RateLimit`의 값 — 병합 전 검토에서 더했다) |
| FR-2012 | 응답 뒤의 일이 우리 쪽에서 실패하면 error 한 줄 | 통합(`auth.reset_mail_failed`·`auth.email_help_failed` — 병합 전 검토에서 더했다) · `pnpm verify:docs`(장애대응 가이드에 코드가 있다) |
| FR-2013 | 화면 — 비밀번호 찾기 카드의 두 길, 결과는 카드 안, 새 비밀번호 화면. 빈 칸으로 관리자 요청을 보내지 않는다(병합 전 검토) | 화면 `FindAccountPage.spec.tsx`·`ResetPasswordPage.spec.tsx` · E2E |
| FR-2020~2022 | 전체 줄·짧은 줄·상태와 조작(눌림·비활성·한국어 이름·Tab 한 번과 화살표). 키보드로 문단 형식을 고르면 초점이 칸에 남는다(병합 전 검토) | 화면 `FormatToolbar.spec.tsx` · `formatActions.spec.ts` · E2E `e2e/format.spec.ts` |
| FR-2023 | 링크 — 화면 안의 대화, 허용 주소만(앵커 포함, `/\…`·`/<탭>/…`는 아니다), 글이 없으면 주소를 글로(**그 뒤에 이어 친 글은 링크가 아니다**), 링크 위에서 고치기·빼기, Ctrl+K(한글 입력 상태도). **폼 안(댓글 칸)에서도 바깥 폼을 제출하지 않는다** | 화면(폼 안의 편집기 — 누르기·제출) · A등급 `document.spec.ts` · E2E(댓글 칸에 링크를 넣어도 주소가 그대로이고 댓글이 늘지 않는다) |
| FR-2024 | 표 — 넣기와 행·열 더하기/지우기·표 지우기, 결과는 정본 검증·표 한계 안 | `formatActions.spec.ts`(명령마다 정본 검증) · E2E(관문을 지나 동료에게, 저장본에) |
| FR-2025 | 실시간 편집에서도 — 관문을 지나고 동료에게 가고 저장된다. 되돌리기는 내 편집만 | E2E(되돌려도 그 사이 동료가 쓴 글이 남는다 — 병합 전 검토에서 더했다) |
| FR-2026 | 허용 목록과 편집기 스키마는 그대로 — 대조 시험이 지난다 | `pnpm test`(`extensions.spec.ts`) |
| FR-2027 | 읽기만 하는 본문에는 줄이 없다, 편집 화면의 줄은 편집 줄 아래에 붙는다 — 막대들의 **지금 높이**로 여백과 붙는 자리를 잡는다(병합 전 검토) | 화면(`FormatToolbar.spec.tsx` · `Editor.spec.tsx`의 여백) · E2E(기본 폭에서 한 줄 · 표 안에서 잰 높이 = 실제 높이) |
| NFR-190 | 새 의존성 0, 이미지 400MB 안 | lockfile 변경 0줄 · 컨테이너(5절) |
| NFR-191 | 세 요청의 응답 모양과 시간이 계정과 무관 | 통합(응답 모양) · 컨테이너(맞든 틀리든 `{"ok":true}` 201 — 0.014~0.017초) |
| NFR-192 | 마이그레이션 하나(`0013_recovery`), 앱 계정은 새 표에 DML, 감사로그는 쌓기만 | 통합 `apps/api/src/db/app-role.integration.spec.ts` · 컨테이너(권한 표 — 5절) |
| 공개 주소(병합 전 검토) | `WF_PUBLIC_URL`은 http(s)의 호스트와 포트까지만, origin으로 맞춘다 — 틀리면 기동 실패 | A등급 `mail.spec.ts`(shared)·`env.spec.ts` |
| 링크 식(병합 전 보안 검토 3) | 내부 경로는 `/` 바로 뒤가 `/`·`\`·탭·줄바꿈이 아니다 | A등급 `document.spec.ts` · 화면 `extensions.spec.ts`·`formatActions.spec.ts` |
| 되돌리기 이력(병합 전 코드 리뷰 2) | 바깥 값을 따라간 것은 되돌리기 이력에 없다 — 409 뒤 불러온 최신 내용을 되돌리기가 옛 내용으로 돌리지 않는다 | 화면 `Editor.spec.tsx` |
