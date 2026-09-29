# P17 검증기록 — Ui (Windows 체험에서 나온 개선 — F-010)

- 작성일: 2026-09-29 / 작성 LLM: Claude Opus 5.5
- 설계: [`docs/P17_설계서_Ui.md`](P17_설계서_Ui.md) · 검토: 6절과 [`docs/internal/P17_검토서_Review.md`](internal/P17_검토서_Review.md)
- 요청 원문: `docs/prompts/phase17/scope.md`
- 시행착오는 [`docs/internal/검토서_트러블슈팅.md`](internal/검토서_트러블슈팅.md)에만 적는다(이번 Phase는 T-077~T-079)

## 1. 요구사항과 확인

요구사항의 글은 설계서 B절이 단일 출처다. 여기에는 무엇으로 확인했는지만 적는다.

| # | 확인 | 어디서 |
|---|---|---|
| FR-1800 | 모든 화면의 알림 — 안 읽은 수, 최근 다섯 건, 바깥·Esc·화면을 옮기면 닫힘. **안 읽은 수의 물음은 배경 요청**(`x-wf-background`)이고 가려진 탭은 묻지 않는다(병합 전 검토) | 컴포넌트 `apps/web/src/components/NotificationBell.spec.tsx` · E2E `e2e/auth.spec.ts` |
| FR-1801~1804 · NFR-170 | 비밀번호 찾기의 요청이 그 사람을 관리할 수 있는 관리자에게 알림으로 간다 — 자기 자신·관리하지 못하는 사람 제외, 읽지 않은 것이 있으면 또 만들지 않음, 초기화하면 모두에게서 읽음, 지금 관리자일 때만 보임, 응답은 알림을 기다리지 않음. **사내 계정의 요청은 알리지 않는다**(병합 전 검토). 알림은 "님의 아이디·email로 … 요청됐다 — 본인에게 확인한 뒤 초기화한다"(본인이라고 말하지 않는다) | 통합 `apps/api/src/auth/auth.integration.spec.ts` · E2E `e2e/auth.spec.ts`(확인 대화의 본인 확인 문장까지) |
| FR-1810 | 비밀번호 변경 — 칸 묶음, 확인 칸, 같거나 다르면 까닭과 막힘, 눈 모양 단추, 폼 아래 ← 뒤로·홈으로 | 컴포넌트 `apps/web/src/pages/ChangePasswordPage.spec.tsx` · E2E `e2e/auth.spec.ts`(**바뀐 결과를 본다** — 옛 비밀번호 거절·새 비밀번호로 로그인, 병합 전 검토) |
| FR-1820 | 편집기·댓글의 쓰는 칸이 보이고 이름이 있다 | 컴포넌트 `apps/web/src/components/Editor.spec.tsx` · E2E `e2e/admin.spec.ts`·`e2e/content.spec.ts` |
| FR-1830 | 시스템 관리자 아이디 찾기 안내 — 아이디를 보이지 않는다 | 컴포넌트 `apps/web/src/pages/RootIdHelpPage.spec.tsx` |
| FR-1840~1842 | 감사 기록 단계 — 3·2·1, 필수는 늘 남음, **2는 실시간 편집의 자동 저장만 뺀다**(사람이 누른 저장·제목 바꾸기는 필수 — 병합 전 검토), 시스템 관리자만 바꿈, 감사로그 화면의 구획 | A등급 `packages/shared/src/policy.spec.ts` · 통합 `apps/api/src/settings/settings.integration.spec.ts` · 컴포넌트 `apps/web/src/components/AuditLevelCard.spec.tsx` |
| FR-1850~1851 | 한 틀과 카드 틀, 1280px에서 본문 900px 이상·가로 스크롤 없음, 1920px에서 표 화면 1440px, 글 칸 760px·넓게 보기 1200px(저장소를 쓰지 못해도 그 화면에서는 바뀐다 — 병합 전 검토) | E2E `e2e/layout.spec.ts`(12화면 × 1280·1920, **데이터가 온 뒤에 잰다** — 병합 전 검토) · 컴포넌트 `apps/web/src/components/ui.spec.tsx` |
| FR-1852~1853 | 위 막대(관리 권한이 없으면 "관리" 없음, `aria-current`), 왼쪽 칸 문맥 셋, 접기·기억·1280px 미만 처음 접힘·Ctrl+[, 트리 펼치기·접기·지금 페이지. **트리를 읽지 못하면 그렇게 말하고 다시 읽기**(병합 전 검토) | 컴포넌트 `apps/web/src/layout/AppLayout.spec.tsx`·`apps/web/src/layout/SpaceSideNav.spec.tsx` · E2E `e2e/tree.spec.ts`·`e2e/layout.spec.ts` |
| FR-1854 | 화면마다 h1 하나(잘못된 주소 화면도 — 병합 전 검토), 빵부스러기는 스페이스 안에서만, 탭 제목. 대문자가 든 식별자 주소는 소문자 주소로 바꿔 연다(좁은 재점검 N2 — 페이지 보기가 멈췄다) | 컴포넌트(`apps/web/src/components/RequireUuidParam.spec.tsx` 등) · E2E |
| FR-1855~1857 | 구획 폼·라벨 위 폼, 도움말·오류의 `aria-describedby`·`aria-invalid`, 필수 칸은 `required`와 라벨 **밖**의 "필수"(병합 전 검토 — 칸마다 따로 적던 `required`를 `Field`가 싣는다), 요소 기본값, 알림띠·배지 | 컴포넌트 `apps/web/src/components/ui.spec.tsx` · E2E `e2e/layout.spec.ts`(편집 칸 테두리 대비 3:1 이상) |
| FR-1858 | 확인 대화 — 처음 초점 그만두기, Esc, **닫은 뒤 초점은 부른 단추로**(부른 단추가 사라졌으면 돌려보내지 않는다 — 병합 전 검토). 묻는 곳은 설계서 J.5.10(비밀번호 초기화를 더해 16) | 컴포넌트 `apps/web/src/components/ConfirmDialog.spec.tsx`·`apps/web/src/pages/admin/AdminUsersPage.spec.tsx` · E2E(`confirmInDialog` — `e2e/spaces-admin.spec.ts`·`e2e/grants.spec.ts`·`e2e/auth.spec.ts`) |
| FR-1859 | 표 모양, "한글 (코드)". 감사로그 **대상** 칸은 종류·그 대상 자신의 이름·자르지 않은 식별자, **상세**의 글 값은 따옴표째(병합 전 검토) | 컴포넌트 `apps/web/src/pages/admin/AdminAuditPage.spec.tsx`·`apps/web/src/components/auditNames.spec.ts` |
| FR-1860 | 편집 화면 — 회색 바탕 위 흰 종이, 편집 줄. **두 막대 뒤로 커서가 숨지 않는다**(`scrollMargin`), **다른 페이지로 옮기면 앞 페이지의 제목을 들고 가지 않는다**, 실시간 편집을 끈 화면은 저장하지 않은 편집이 있으면 창을 닫기 전에 묻는다(병합 전 검토) | 컴포넌트 `apps/web/src/pages/PageEditorPage.spec.tsx`·`apps/web/src/components/Editor.spec.tsx` · E2E `e2e/layout.spec.ts`·`e2e/collab.spec.ts` |
| FR-1861 | 빈 상태·불러오기, 운영 설정의 불러오기 실패. **페이지 보기·이력은 주소의 페이지를 읽은 뒤에만 그 페이지를 그린다**(병합 전 검토 — 앞 페이지의 제목을 보인 채 삭제가 새 페이지로 갔다) | 컴포넌트 `apps/web/src/pages/PageViewPage.spec.tsx`·`apps/web/src/pages/PageHistoryPage.spec.tsx` |
| NFR-171 | 새 의존성 0, 런타임 외부 자원 0, CSS 한 파일 | `pnpm check` · CI(외부 URL 검사) · lockfile 변경 없음(`git diff main -- pnpm-lock.yaml` 비었다) |
| 배경 요청(설계서 A.1-8·H, `CLAUDE.md` 7절 세션) | 배경 표시가 붙은 요청은 세션의 만료를 밀지 않는다(쿠키도 다시 보내지 않는다). 접근 로그(앱·nginx)에서 빼는 것은 **표시가 붙은 알림 수 물음(`GET /api/notifications/unread-count`) 하나뿐**이고 5xx는 남는다 — 다른 경로·메서드는 표시가 붙어도 남는다(좁은 재점검 N1). nginx의 경로는 `pnpm verify:docs`가 공유 상수와 대조한다 | 통합 `apps/api/src/auth/session-middleware.integration.spec.ts`(`sessions.expire`와 `Set-Cookie`) · A등급 `apps/api/src/common/domain/access-log.spec.ts` · 컨테이너(5절) |

## 2. 자동 검사

`pnpm test:cov`(세 패키지를 차례로) — 실패 0 · 건너뜀 0. 수치는 실행 출력의 요약과 커버리지 보고서(`coverage-summary.json`, web은 `clover.xml`).
`pnpm lint`·`pnpm typecheck` 종료 0 · `pnpm verify:docs` 위반 없음 · 브랜치 CI 초록(10절).

| 패키지 | 시험 파일 | 시험 | 라인 | 브랜치 | 함수 |
|---|---|---|---|---|---|
| shared (A) | 12 | 411 | 99.87% | 97.00% | 99.39% |
| api (A+B) | 68 | 1,120 | 96.21% | 91.62% | 94.79% |
| web (측정만) | 42 | 366 | 93.56% | 83.91% | 88.15% |

좁은 재점검 반영(`37fbe73`)의 코드에서 잰 것이다 — 그 뒤 `main`(F-009)을 들였고 이 표의 코드는 바뀌지 않았다(10절). Phase 16 끝(shared 406 · api 1,110 · web 218)에서
shared 5 · api 10 · web 148이 늘었다 — web은 화면 전면이 시험 파일 21개를 새로 들였다(틀·왼쪽 칸·부품·확인 대화·카드 틀 화면). 병합 전 검토 반영(`37a3e1a`)에서 잰 첫
수치는 api 1,119 · web 364였다 — 돌연변이가 빠져나간 곳의 시험 하나(`f0cce6e`)와 좁은 재점검 반영의 시험 둘(A등급 한 건, 대문자 주소 한 건)이 더해졌다.

이번 Phase가 만진 모듈:

| 모듈 | 등급 | 라인 | 브랜치 | 함수 |
|---|---|---|---|---|
| shared `policy.ts` · `constants.ts` · `schemas.ts` | A | 100 | 100 | 100 |
| api `common/domain/access-log.ts` | A | 100 | 100 | 100 |
| api `auth/session-middleware.ts` | B | 100 | 100 | 100 |
| api `auth/auth.service.ts` | B | 97.16 | 84.28 | 92.85 |
| api `notifications/notifications.service.ts` | B | 100 | 96.15 | 100 |
| api `audit/audit.service.ts` | B | 100 | 97.56 | 100 |
| api `settings/settings.service.ts` | B | 100 | 100 | 100 |
| api `common/request-log.middleware.ts` | B | 94.11 | 73.33 | 85.71 |

web(측정만 — `clover.xml`의 문장·조건·함수): `components/ui.tsx` 98.44 · 89.08 · 100, `layout/AppLayout.tsx` 100 · 94.03 · 100, `layout/SpaceSideNav.tsx` 100 · 92.86 · 100,
`components/ConfirmDialog.tsx` 100 · 85.00 · 100, `components/NotificationBell.tsx` 93.48 · 76.32 · 82.35, `components/AuditLevelCard.tsx` 96.15 · 84.62 · 100,
`pages/PageViewPage.tsx` 93.22 · 83.61 · 82.35, `pages/PageEditorPage.tsx` 91.84 · 80.00 · 77.78, `pages/admin/AdminAuditPage.tsx` 93.33 · 90.48 · 78.57,
`layout/AuthLayout.tsx` 50 · 60 · 50(카드 틀 — 컴포넌트 시험이 화면을 틀 없이 그린다. E2E가 카드 틀 화면인 로그인·가입·계정 찾기를 지난다).

- **A등급의 시험 선행** — 병합 전 검토 반영은 Red → Green이다: `4bd85e4` → `2e76f7a`(감사 기록 단계 2, 배경 요청의 접근 로그). **감사 기록 단계의 첫 판은
  `policy.ts`와 그 시험이 한 커밋이다(`2f22699`)** — 시험을 먼저 썼는지 이력으로 보일 수 없다(코드 리뷰 8 — 검토서 3절).
- 컨트롤러는 측정에서 뺀 자리다(`src/**/*.module.ts`) — 감사 기록 단계를 시스템 관리자만 바꾸는 판정(`settings.module.ts`)은 통합 시험이 HTTP로 부른다(돌연변이 P25).

## 3. 돌연변이 — 고친 곳을 옛 코드로 되돌려 봤다

**31개, 모두 시험이 실패했다** — 병합 전 검토 반영분 23(P1~P23), 그 전의 Phase 17 동작 6(P24~P29), 좁은 재점검 반영분 2(P30·P31). 스크립트가 저장소 밖의 작업 폴더(같은 커밋)에서 파일을 바꾸고
그 시험을 돌린 뒤 되돌린다. 첫 실행에서 **하나가 빠져나갔다** — P9(편집 화면을 페이지마다 새로 만드는 것). 이력 화면에는 그 시험이 있었고 편집 화면에는 없었다.
"다른 페이지의 편집으로 곧바로 옮기면 새 페이지를 읽는 동안 앞 페이지의 제목 칸이 없다"를 더하고(`f0cce6e`) 다시 돌려 잡았다. 목록은 검토서 4절.

## 4. 브라우저 — E2E

새 빌드(`pnpm build`)를 호스트 `:3000`에 띄우고 `pnpm test:e2e` — **38 통과 · 실패 0 · 건너뜀 0 (1.3분).** 병합 전 검토 반영(`37a3e1a`)의 빌드와 마지막 코드
(`a341a2b` — 좁은 재점검 반영 + `main` 들임)의 빌드에서 두 번 돌려 둘 다 같았다. Phase 16 끝의 36에서 둘이 늘었다 — 화면 전면의 기계 판정(`e2e/layout.spec.ts`)과
비밀번호 초기화 요청의 알림(`e2e/auth.spec.ts`).

- **레이아웃**(`e2e/layout.spec.ts`) — 1280×720과 1920×1080에서 12화면(홈·스페이스·페이지 보기·편집·이력·검색·알림함·휴지통·LLM·사용자 관리·감사로그·LLM 연결):
  가로 스크롤 없음, 1280에서 본문 900px 이상, 1920에서 표 화면 1440px 이하, 편집 칸 테두리 대비 3:1 이상. 병합 전 검토가 **h1만 보고 재던 것**(불러오는 중인
  화면을 쟀다)을 짚어, 요청이 멎고 "불러오는 중…"이 사라지고 그 화면의 표·목록·본문이 보인 뒤에 잰다. 화면은 .local/tmp/playwright/layout/ 에 남긴다(저장소 밖).
- **비밀번호 변경** — 마지막 단언이 누르기 전부터 참이었다(위 막대의 "{이름}님", T-066과 같은 모양 — 병합 전 검토). 홈으로 가는 것, 옛 비밀번호의 거절, 새
  비밀번호의 로그인을 본다.
- **비밀번호 초기화** — 확인 대화의 **새로 만든다**를 지나고, 요청 알림에서 온 경우 대화가 본인 확인을 말하는지 본다.

## 5. 컨테이너

이번 Phase는 nginx 설정(배경 요청을 접근 로그에서 빼는 `map`)과 세션 미들웨어를 바꿨다. 이 서버의 기존 스택에 새 버전을 들이는 길로 봤다.

| 무엇 | 결과 |
|---|---|
| 이미지(`docker compose … build api`, `GIT_SHA`) | 첫 빌드 `ce36044`(화면 전면), 병합 전 검토 반영 `f0cce6e`, 마지막 빌드 `a341a2b`(좁은 재점검 반영 + `main` 들임) — 라벨 = 빌드한 때의 HEAD. 셋 다 **380MB**(예산 400MB, Phase 16과 같다 — 새 의존성 0). 확인용 태그 `workfluence-app:a341a2b` |
| 표 만들기(`run --rm tools node dist/db/migrate.js`) | `13개 마이그레이션 적용 상태` + `앱 계정 workfluence_app: 권한 적용` — 이번 Phase는 새 마이그레이션이 없다(감사 기록 단계는 운영 설정의 JSON 한 칸) |
| 다시 띄우기(`up -d api`) | 두 빌드 모두 **12초**에 `HTTP 200` `{"status":"ok","db":"ok",…}`. 컨테이너의 이미지 라벨 `a341a2b` |
| nginx(`up -d --force-recreate nginx`) | 설정을 다시 읽었다(`nginx -t` 통과, `map "$http_x_wf_background:$request_method:$uri:$status" $wf_loggable`). 배경 표시를 붙여 알림 수 물음·질의가 붙은 알림 수 물음·다른 경로(`/api/pages/:id`)·로그인(POST)·대문자 경로를, 붙이지 않고 알림 수 물음을 보냈다(모두 로그인 없이 401) — **빠진 것은 표시가 붙은 알림 수 물음 둘뿐이다.** 나머지는 nginx와 앱 접근 로그에 같은 요청 번호로 남았다. 첫 판(`f0cce6e`)의 설정은 표시가 붙은 다른 경로와 로그인도 두 로그에서 뺐다 — 좁은 재점검이 짚은 그대로(N1) |

## 6. 검토

병합 전에 넷을 돌렸다(모두 Opus 5.5, 검토 시점 HEAD `8f60448`) — 자체 점검 16 · 코드 리뷰 10 · 보안 검토 5 · 문서 정합성 14(+ 반박 1 · 참고 2). 코드 쪽
31건은 따로 둘이 반박을 시도해 **확정 24 · 반박 3 · 참고 4**로 걸렀다. 가장 값있던 것:

- **알림 수를 30초마다 묻는 것이 세션의 유휴 만료(30분)를 없앴다** — 셋이 따로 찾았다(높음). 모든 화면에 알림 영역을 둔 것이 Phase 7의 판단("열어만 둔 탭은
  세션을 이어 주지 않는다")을 모든 화면에서 우회했다. `rolling`만 끄면 express-session이 저장소의 만료를 계속 밀어(`touch`) 배경 표시가 붙은 요청은 따로 둔
  세션 미들웨어가 받는다(`CLAUDE.md` 7절 세션).
- **감사 기록 단계 2가 보안 검토가 넣은 귀속 기록(사람이 누른 저장·제목 바꾸기)까지 뺐다**(보안 검토) — 자체 점검도 같은 것을 냈으나 반박 한 표에 걸렸다. 첫 판이
  셋을 "자동 저장 셋"으로 부른 것이 틀렸다(설계서 I절 7).
- **페이지 보기가 다른 페이지로 옮기는 사이 앞 페이지의 제목을 보인 채 삭제가 새 페이지로 갔다**(코드 리뷰).

반영분만 다시 본 좁은 자체 점검(Opus 5.5) — 원래 24건은 고쳐졌다 — 일부만 고쳐진 것이 둘(설계서의 시험 목록, 앱 안 이동의 물음 — 한계로 적었다), 해당 없음이 하나(A등급의 커밋 이력), **새 결함 6(높음 1 · 보통 1 · 낮음 4)과 문서 5**. 높음은 반영이 만든 것이다 — 배경 요청을 로그에서 빼는 판정이 경로를 보지 않아
누구나 표시 하나로 모든 요청을 로그에서 지울 수 있었다(nginx 컨테이너로 실측했다). 보통은 대문자가 든 식별자 주소에서 페이지 보기가 영영 불러오는 중이었다. 모두 반영했다
(A등급 Red `94429c2` → `37fbe73`). 처리 내역 전부는 [`docs/internal/P17_검토서_Review.md`](internal/P17_검토서_Review.md).

## 7. 보류 결정 처리

새로 열거나 닫은 보류가 없다. 설계서 H절·J.11의 남는 것(알림은 밀어 주지 않는다, 서식 단추 줄은 F-013 등)은 되돌릴 조건과 함께 설계서에 있다.

## 8. 기능백로그

| # | 처리 |
|---|---|
| F-010 | 열 가지 모두 이 Phase에서 했다 — 1·9(비밀번호 변경), 4·5(쓰는 칸), 7(시스템 관리자 아이디 안내), 8(초기화 요청 알림·모든 화면의 알림), 10(감사 기록 단계), 2·3·6(화면 전면) |
| F-012 | 사내 메일 API를 현장에서 설정해 붙인다 — 사용자가 준 API의 모양을 적었다. Phase 18(사용자 결정) |
| F-013 | 편집기의 서식 단추 줄 — 화면 전면 뒤로(사용자 결정). 이 Phase에서 하지 않았다 |
| F-011 | 사용자가 정한다 |
| F-009 | 탐색 브랜치의 일이다. 이 Phase를 병합하기 전에 `main`에 넣고(사용자 결정 "지금 병합"), 이 브랜치에 들인 뒤 Phase 17의 코드로 묶음을 만든다(9절) |

## 9. 확인하지 못한 것

- **Windows에서 Phase 17의 화면** — 사용자가 자기 Windows에서 개선을 확인하려면 F-009 묶음을 이 Phase의 코드로 만들어야 한다. F-009를 `main`에 넣고 이 브랜치에
  들인 뒤 수동 실행으로 만든다(PR 설명에 결과를 적는다).
- **배경 요청의 세션을 컨테이너에서** — 세션의 만료가 밀리지 않는 것은 실제 PostgreSQL의 통합 시험(소유 계정)으로 봤다. 컨테이너(앱 계정)에서는 로그인하지 않은
  요청의 로그만 봤다 — 조용한 쪽은 저장소를 덜 부를 뿐 새 권한이 필요 없다.
- **보조기기로 직접** — 이름·`aria-*`·초점 순서는 컴포넌트 시험과 E2E의 역할 선택자로 봤다. 화면 낭독기로 끝까지 써 보지 않았다.
- **Chromium 밖의 브라우저** — E2E는 Chromium만 돈다. 확인 대화(`<dialog>`)와 편집 화면의 여백(`:has()`·`scroll-padding`)을 Firefox·Safari에서 보지 않았다.
- **앱 안의 링크로 떠날 때** — 실시간 편집을 끈 화면의 "저장하지 않은 편집" 물음은 창을 닫거나 새로 고칠 때만이다(설계서 J.12-15 — 라우터를 바꾸지 않았다).
- **편집 줄이 두 줄로 접힐 때의 커서** — 편집기의 여백은 편집 줄 한 줄을 전제한다(설계서 J.12-16). 좁은 창이나 같이 보는 사람이 많을 때를 재지 않았다(좁은 재점검 N3).

## 10. 마지막 확인

- 마지막 코드 `f0cce6e`(그 뒤는 문서뿐)에서 `pnpm check` 종료 0 — PR 설명에 수치를 적는다.
- 브랜치 CI(`gh pr checks`)는 PR 설명에 적는다.
