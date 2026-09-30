# P19 설계서 — Recovery (비밀번호를 잊었을 때 두 길 · 편집기 서식 단추 줄 — F-011 · F-013)

로그인 화면의 비밀번호 찾기는 지금 한 길이다 — 아이디와 email을 적으면 관리자의 알림에 가고, 관리자가 임시 비밀번호를 만들어 준다(P1 FR-209a, P17 F-010 8번).
Phase 1은 "대역 외 확인 수단(메일)이 없다"를 근거로 로그인 전 자가 재설정을 두지 않았다(P1 2.4절). 그 근거는 Phase 6(메일 발송)과 Phase 18(사내 메일 API의 실제
모양)로 사라졌다. 사용자가 두 길을 원한다(백로그 F-011) — **관리자에게 초기화 요청**과 **내 email로 재설정**, 두 길 모두 **표시 이름 + 처음에 넣은 email**이 맞아야 하고,
email이 기억나지 않으면 **"이메일이 기억이 안나시나요?"**로 시스템 관리자에게 확인을 요청한다.

편집기는 단축키와 입력 규칙(`# 제목`, `- 목록`, Ctrl+B)으로만 서식을 넣고, 표는 붙여 넣기로만 들어간다(백로그 F-013). Phase 17이 본문 칸 바로 위에 자리만 뒀다.
이 Phase는 그 자리에 **서식 단추 줄**을 두고, 댓글 칸에 짧은 줄을 둔다.

- 요청 원문: `docs/prompts/phase19/scope.md` (F-011의 첫 요청과 "이름은 표시 이름" 답은 `docs/기능백로그.md` F-011, F-013의 첫 답은 `docs/prompts/phase17/scope.md`)
- 요구사항 번호: **FR-2000**, 비기능 **NFR-190**부터
- 선행: [`docs/P1_설계서_Auth.md`](P1_설계서_Auth.md) 2.4절·FR-208·209a(계정 찾기) · [`docs/P17_설계서_Ui.md`](P17_설계서_Ui.md) C절(초기화 요청 알림 FR-1801~1804)·J절(화면 틀) ·
  [`docs/P18_설계서_Mail.md`](P18_설계서_Mail.md)(사내 메일 API) · [`docs/P9_설계서_Gate.md`](P9_설계서_Gate.md)·[`docs/P12_설계서_Limits.md`](P12_설계서_Limits.md)(실시간 편집의 관문과 표 한계)
- 구조: [`docs/설계서_Architecture.md`](설계서_Architecture.md) — 2절 DIP 표의 "알림 발송" 축(`MAIL_SENDER`)을 그대로 쓴다

## A. 착수 쟁점 (2026-09-30)

| # | 쟁점 | 사용자 답 | 이 설계가 한 것 |
|---|---|---|---|
| 1 | 본인 email로 재설정을 누구까지 허용하나 — member·admin(root 제외) / 모든 계정 / member만 | **"(가) member·admin만, root는 제외"** (추천) | 판정은 공유 규칙 `canResetPasswordByMail` 한 곳(`packages/shared/src/permissions.ts`). root는 지금처럼 다른 root나 서버 담당자가 푼다(장애대응 7.29절). 링크를 쓰는 순간에도 다시 본다 — 그 사이 root가 된 사람은 쓰지 못한다 |
| 2 | "이메일이 기억이 안나시나요?"로 무엇을 적게 하나 — 아이디 + 표시 이름 / 표시 이름만 | **"(가) 아이디 + 표시 이름"** (추천) | 둘 다 맞는 활성 로컬 계정일 때만 시스템 관리자(root)의 알림에 간다(C.5). 응답은 늘 같고, 읽지 않은 같은 요청은 또 만들지 않는다 |
| 3 | 댓글 칸에도 서식 단추 줄을 두나 | **"(가) 페이지 편집기는 전체 줄, 댓글 칸은 짧은 줄(굵게·기울임·목록·링크·코드)"** (추천) | D.1 — 전체 줄과 짧은 줄은 같은 단추 목록(`formatActions.ts`)에서 고른다 |
| 4 | 서식 단추의 범위 | **"(가) 편집기가 이미 받는 것 전부"** (추천) — 백로그의 것 + 밑줄·취소선·인라인 코드·인용·코드 블록·구분선. 표는 넣기(3×3, 머리 줄)와 표 안에서 행·열 더하기/지우기·표 지우기. 칸 합치기·나누기는 넣지 않는다 | D.1. 허용 목록(`packages/shared`)과 편집기 스키마는 바뀌지 않는다 — 단축키로만 되던 것을 누를 수 있게 한다 |

## A.1 묻지 않고 정한 것 — 근거와 되돌릴 조건

착수 때 사용자에게 보이고 "다르면 말해 달라"고 한 것이다(`docs/prompts/phase19/scope.md`). 사용자는 다르다고 하지 않았다.

| # | 정한 것 | 근거 | 되돌릴 조건 |
|---|---|---|---|
| 1 | 두 요청을 **Phase 19 하나**로 한다 | 둘 다 사용자가 한 번에 맡겼고 만지는 층이 겹치지 않는다(계정 찾기 · 편집기). Phase 14가 F-007·F-008을 함께 한 것과 같다 | 없음 |
| 2 | **P1 FR-209a를 바꾼다** — 로그인 전 자가 재설정을 둔다. 다만 비밀번호를 **화면이나 메일로 내주지 않는다** — 메일에는 링크, 새 비밀번호는 그 링크 화면에서 본인이 정한다 | FR-209a의 근거는 "대역 외 확인 수단이 없다"였다(P1 2.4절 — 정정 2026-09-23). 사내 메일이 그 수단이 된다: 링크는 요청한 사람이 아니라 **그 계정의 email**로 간다 — 아이디·email을 아는 것(공개 정보)이 아니라 **그 메일함을 가진 것**이 본인 확인이다. 처음 판의 결함(평문이 응답으로 공격자에게, 피해자의 비밀번호가 즉시 덮어써짐)은 이 모양에서 생기지 않는다 — 요청만으로는 아무것도 바뀌지 않는다 | 사내 보안 검토가 메일 도달만의 본인 확인을 받지 않으면 운영 설정으로 끈다(A.1-9). 코드는 고치지 않는다 |
| 3 | 두 길 모두 **표시 이름 + 처음에 넣은 email**. 관리자에게 초기화 요청의 조건을 **아이디+email에서 바꾼다** | 사용자 원문 3번과 답 "이름은 표시 이름이야"(2026-09-28). 로컬 계정은 email을 바꾸는 길이 없어(가입·관리자 만들기에서만 적는다) "처음에 넣은 email"이 곧 지금의 email이다. email은 겹치지 않으므로(`users_email_uq`) 둘이 맞는 계정은 하나뿐이다. 아이디 찾기(FR-208)와 같은 두 칸이 된다 | 로컬 계정의 email을 바꾸는 길이 생기면 "처음에 넣은" 값을 따로 둘지 다시 본다 |
| 4 | 링크는 **30분, 한 번**(`PASSWORD_RESET.linkMinutes`). 새로 요청하면 옛 링크는 죽는다. 발급한 뒤 비밀번호가 **어떤 길로든** 바뀌면 죽는다 — 발급 때의 비밀번호 해시에서 뽑은 표시(`password_mark`)를 두고 쓸 때 견준다 | 흔한 기한이다 — 메일이 늦게 닿아도 쓸 수 있고, 새어 나간 링크가 오래 살지 않는다. 비밀번호가 바뀌는 길(본인 변경·관리자 초기화·이 재설정)마다 링크를 지우는 코드를 두면 새 길이 생길 때 잊는다 — 표시를 견주면 길이 늘어도 맞다 | 현장 메일이 30분보다 늦게 닿는다는 보고가 오면 상수를 올린다 |
| 5 | 서버에는 재설정 값의 **SHA-256 해시만** 둔다. 값은 32바이트 무작위(base64url 43자) | DB가 새어도 링크가 되지 않는다. 값이 충분히 길어 느린 해시(argon2)가 필요 없다 — 추측할 수 없는 값을 찾는 데는 빠른 해시로 충분하다(세션 ID와 같은 판단) | 없음 |
| 6 | 값은 링크 주소의 **`#` 뒤**(`/reset-password#t=…`)에 싣는다. 화면은 읽자마자 주소창에서 지운다(`history.replaceState`) | `#` 뒤는 브라우저가 서버로 보내지 않는다 — nginx·앱의 접근 로그(질의 문자열은 이미 싣지 않는다 — Phase 11)와 다른 곳으로 가는 Referer 어디에도 가지 않는다. 주소창에 남기면 화면 공유·방문 기록에 남는다 | 없음 |
| 7 | 맞든 틀리든 **같은 응답**이고, 메일(값 만들기·보내기)은 **응답과 따로** 돈다. 한 계정에 **5분에 한 통**(`PASSWORD_RESET.mailIntervalMinutes`) — 그 사이의 요청은 조용히 보내지 않는다(응답은 같다). 보내기가 실패하면 그 값을 지운다 | 걸린 시간이 "그런 계정이 있다"를 말하면 안 된다(P17 FR-1801과 같은 판단). 누구나 남의 이름·email로 요청할 수 있다 — 한 사람의 메일함을 채우지 못하게 계정마다 센다(IP별 제한은 여러 주소에서 오면 소용없다). 실패한 값을 남기면 5분 동안 다시 받을 수 없다 | 없음 |
| 8 | **보내지 않는 계정** — root(쟁점 1), 사내 계정(IdP — 비밀번호가 없다), 승인 대기·정지. 응답·감사는 같다 | 사내 계정에 비밀번호를 붙이면 IdP가 강제하던 인증을 건너뛰는 옆문이 된다(FR-217 — 관리자 초기화와 같은 판단). 승인 대기·정지는 로그인할 수 없는 계정이다 | 없음 |
| 9 | 쓸 수 있는 때 — **메일이 켜져 있고**(`WF_MAIL_ENABLED`) **공개 주소가 있고**(`WF_PUBLIC_URL`) **운영 설정이 켬**(`passwordResetMail`, 기본 켬). 하나라도 아니면 화면이 단추를 보이지 않고, 요청과 링크 쓰기가 모두 404다 — **이미 보낸 링크도 막힌다** | 메일이 없으면 링크가 닿지 않고, 주소가 없으면 링크를 만들 수 없다(멘션 메일은 링크를 빼고 보내지만 이 메일은 링크가 전부다). 운영 설정은 **보안 검토가 막으면 코드를 고치지 않고 끄는 자리**다(2절 OCP) — 끄는 뜻이 "지금부터 쓰지 않는다"이므로 이미 보낸 것도 막는다 | 없음 |
| 10 | 링크로 바꾸면 — 모든 세션을 지우고 편집 연결을 끊고(비밀번호 변경과 같다 — FR-224), 잠금을 풀고, 변경 강제를 끄고, 그 사람의 **남은 초기화 요청·email 확인 요청 알림을 읽음으로** 한다. 그 계정의 로그인 줄에 선다(P13 D.4). 로그인은 따로 한다 | 비밀번호를 잊은 사람이 바꾸는 것이다 — 누가 그 사이 들어와 있었으면 끊겨야 한다. 관리자가 그 요청을 뒤늦게 처리하면 방금 정한 비밀번호가 임시 비밀번호로 덮인다(P17 FR-1803과 같은 까닭). 줄에 서지 않으면 옛 비밀번호로 확인 중이던 로그인이 세션을 지운 뒤에 세션을 만든다(P13 병합 전 검토). 바꾸자마자 들여보내지 않는 것은 링크를 누른 브라우저가 그 사람의 것이라는 근거가 메일함뿐이라서다 — 새 비밀번호로 한 번 로그인하게 한다 | 없음 |
| 11 | "이메일이 기억이 안나시나요?"는 **따로 화면**(`/find-account/email`)이다 — email 칸 바로 옆의 단추가 그리로 간다. 안내 문구와 아이디·이름 칸, 보내기 | 사용자 원문 4번 "이메일 입력 옆에 … 버튼 … 문구로 안내". 한 카드 안에 칸을 더 펼치면 비밀번호 찾기의 이름 칸과 섞인다. 시스템 관리자 아이디 찾기(P17 7번)와 같은 안내 화면 틀이다 | 없음 |
| 12 | email 확인 요청 알림은 **시스템 관리자(root)만** 받고 **지금 root일 때만** 보인다. 요청한 사람이 root면 다른 root에게 간다. 알림을 누르면 사용자 관리에서 그 사람을 찾는다 — 시스템 관리자가 본인인지 확인한 뒤 알린다 | 사용자 원문 4번 "시스템 관리자에게". email을 알려 주는 것은 계정의 주인을 가리는 일이라 관리자 전부가 아니라 시스템 관리자가 한다. 초기화 요청 알림(P17 FR-1804)과 같은 판단으로, 역할에서 내려가면 더 알 일이 아니다 | 관리자도 받아야 한다는 요구가 오면 받는 사람 판정만 바꾼다 |
| 13 | 새 설정 키(`WF_*`)는 없다. 운영 설정 하나(`passwordResetMail` — 0 끔 · 1 켬)와 상수 둘 | 메일 설정은 Phase 18 그대로 쓴다. 켜고 끄는 것은 운영 중 관리자가 조절하는 정책값이다(5절 셋째 칸). 기한·간격은 바꾸면 보안 판단이 바뀌는 설계 고정값이다(5절 둘째 칸) | 없음 |
| 14 | 운영 설정의 켜고 끄기는 **관리자**(`settings.manage` — 운영 설정 화면의 다른 값과 같다)가 한다. 감사 기록 단계처럼 시스템 관리자만으로 좁히지 않는다 | 관리자가 켜서 얻는 것은 member·admin 자신의 메일 재설정이다 — root는 쟁점 1로 늘 빠진다. 끄는 쪽이 더 안전해서 누구든 끌 수 있는 것이 낫다 | 없음 |
| 15 | 메일 글은 **평문·마크다운** 둘 다(Phase 18 `WF_MAIL_FORMAT`). 이름은 한 줄로, 마크다운 글자는 이스케이프(P18 A.1-14 그대로). 링크를 누르지 않을 사람을 위해 **요청하지 않았으면 지워도 된다 — 비밀번호는 바뀌지 않는다**를 적는다 | 남이 요청해도 메일이 간다(A.1-7). 받은 사람이 놀라지 않고 아무것도 하지 않아도 되게 한다 | 없음 |
| 16 | 메일 API 주소가 `http`면 링크가 **평문으로** 사내망을 지난다 — 막지 않고 반입 가이드 10-1절에 적는다 | 사내 메일 API의 모양은 현장이 정한다(P18). 링크는 30분·한 번이고 쓰면 죽는다 — 사내 LLM의 http 알림(P10)과 같은 판단으로 알리고 고른다 | 사내 보안 검토가 문제 삼으면 운영 설정으로 끈다 |
| 17 | 서식 단추 줄은 **편집 줄 아래에 붙어** 긴 문서에서도 보인다. 커서가 그 뒤에 숨지 않게 편집 화면의 여백(`EDIT_SCROLL_MARGIN`)에 줄 높이를 더한다 | 붙지 않으면 긴 문서의 끝을 고칠 때 단추를 쓰려고 맨 위로 올라가야 한다. 붙은 막대가 커서를 가린 적이 있다(P17 병합 전 코드 리뷰 18) | 없음 |
| 18 | 단추 줄은 **Tab 한 번으로 들어가고 화살표로 옮긴다**(한 번에 하나만 Tab 자리 — WAI-ARIA toolbar). 단추마다 한국어 이름과 단축키(`굵게 (Ctrl+B)`), 지금 켜진 것은 `aria-pressed`, 쓸 수 없는 것은 비활성. 누른 뒤 초점은 본문으로 돌아간다 | 단추가 스무 개 가까이라 모두 Tab 자리이면 본문에 가기까지 스무 번을 누른다. 그림 단추는 이름 없이 뜻을 전하지 못한다(P17 J.5.12) | 없음 |
| 19 | 링크 단추는 **화면 안의 대화**(`<dialog>` — 확인 대화와 같은 틀)로 주소를 받는다. 주소는 편집기와 서버가 쓰는 같은 판정(`linkAllowed` — http(s)·내부 경로·앵커)으로 보고 아니면 까닭을 말한다. 고른 글이 없으면 주소를 글로 넣는다. 링크 위에서는 고치기·빼기 | `window.prompt`는 화면 모양과 맞지 않고 E2E가 창을 따로 받아야 한다(P17 J.5.10). 판정이 서버와 다르면 그 문서의 저장이 멈춘다(P9 B.2 — `mailto:`) | 없음 |
| 21 | **사용자 관리 목록의 이름 아래에 email**을 보인다 | email 확인 요청(FR-2009)을 받은 시스템 관리자가 알려 줄 값을 볼 곳이 없었다 — 목록은 email로 찾을 수는 있어도 보이지 않았다(E2E가 찾은 빈틈, 2026-09-30). 새로 드러나는 것이 아니다 — 목록의 응답(`UserView.email`)은 Phase 13부터 관리자에게 email을 싣고 있었고 찾기도 email로 됐다. 화면이 그리지 않았을 뿐이다. A.1-12는 **누가 본인을 확인하고 알려 주는가**(시스템 관리자)이고, 보는 것은 관리자도 이미 했다 | 없음 |
| 20 | 되돌리기·다시는 편집기가 이미 가진 명령이다 — 혼자 쓸 때는 편집기의 이력, 실시간 편집에서는 **Yjs의 되돌리기**(내 편집만 되돌린다) | 실시간 편집에서 편집기의 이력을 켜면 내 되돌리기가 남의 편집까지 되돌린다(`apps/web/src/components/extensions.ts`의 `undoRedo: false` — 그래서 꺼 두었다) | 없음 |

## B. 요구사항

### B.1 비밀번호를 잊었을 때 (F-011)

| # | 요구사항 | 확인 |
|---|---|---|
| FR-2000 | **두 길의 조건** — 관리자에게 초기화 요청과 내 email로 재설정은 모두 **표시 이름 + email**을 받는다(`recoverPasswordDto`). 이름은 앞뒤 빈칸을 떼고 **그대로** 견주고, email은 소문자로 견준다. 맞든 틀리든 응답은 `{ok: true}` 하나다 | A등급 `packages/shared/src/schemas.spec.ts` · 통합 `apps/api/src/auth/recovery.integration.spec.ts` |
| FR-2001 | **관리자에게 초기화 요청**(`POST /api/auth/recover-password`) — 맞는 활성 계정이고 비밀번호가 있으면 그 사람을 관리할 수 있는 관리자·시스템 관리자의 알림에 간다(P17 FR-1801·1802 그대로). 알림 글은 "이름·email로 요청됐다" | 통합 · 화면 시험 `apps/web/src/components/NotificationText.spec.tsx` |
| FR-2002 | **내 email로 재설정 링크**(`POST /api/auth/reset-mail`) — 맞고 받을 수 있는 계정(`canResetPasswordByMail` — member·admin, 활성, 로컬)이면 그 email로 링크 한 통(A.1-4~8). 응답을 기다리지 않는다 | A등급 `packages/shared/src/permissions.spec.ts` · 통합(가짜 메일 발송이 받은 것) · E2E |
| FR-2003 | **링크의 수명** — 30분, 한 번. 새 요청이 옛 링크를 죽인다. 발급 뒤 비밀번호가 바뀌었으면(`password_mark`), 계정이 받을 수 없게 됐으면(정지·root·사내 계정) 쓰지 못한다 | A등급 `apps/api/src/auth/domain/reset-link.spec.ts` · 통합 |
| FR-2004 | **간격** — 한 계정에 5분에 한 통. 그 사이 요청은 보내지 않고 감사에 `throttled`로 남긴다. 보내기가 실패하면 그 값을 지운다 | A등급 · 통합 |
| FR-2005 | **값을 남기지 않는다** — 서버에는 해시만. 링크의 값은 `#` 뒤. 화면이 읽자마자 주소창에서 지운다. 로그·감사에 값과 링크를 싣지 않는다 | 통합(표에 값이 없다) · 화면 시험 `apps/web/src/pages/ResetPasswordPage.spec.tsx` |
| FR-2006 | **새 비밀번호 정하기**(`POST /api/auth/reset-password` `{token, newPassword}`) — 살아 있는 정책으로 세기를 보고(FR-521), 해시는 트랜잭션 밖에서(P13 FR-1434), 그 계정의 로그인 줄 안에서: 값을 지우고(한 번 — 동시에 두 번 써도 하나만 된다), 읽은 비밀번호 그대로일 때만 바꾸고, 세션을 모두 지우고, 남은 초기화 요청·email 확인 요청 알림을 읽음으로, 감사. 커밋한 뒤 편집 연결을 끊는다 | 통합 · E2E |
| FR-2007 | **틀린 링크** — 없는 값·지난 값·쓴 값·비밀번호가 바뀐 뒤의 값·받을 수 없게 된 계정은 모두 **같은 400 문장**("링크가 맞지 않거나 기한이 지났다 — 비밀번호 찾기에서 다시 요청한다")이고 감사에 까닭이 남는다 | 통합 |
| FR-2008 | **쓸 수 있는가** — `GET /api/auth/config`가 `resetMailEnabled`(메일 켜짐 · 공개 주소 · 운영 설정 `passwordResetMail`=1)를 준다. 아니면 화면은 단추를 보이지 않고 `reset-mail`·`reset-password`는 404. 운영 설정 화면의 "세션·계정" 묶음에 켜기·끄기(기본 켬) | A등급 `packages/shared/src/policy.spec.ts` · 통합 · 화면 시험 |
| FR-2009 | **"이메일이 기억이 안나시나요?"** — 비밀번호 찾기의 email 칸 옆 단추가 안내 화면(`/find-account/email`)으로 간다. 아이디 + 표시 이름을 보내면(`POST /api/auth/email-help`) 둘 다 맞는 활성 로컬 계정일 때만 시스템 관리자(자기 제외)의 알림(`email.confirm.request`)에 간다. 응답은 같다. 읽지 않은 같은 요청은 또 만들지 않는다. 알림은 지금 root일 때만 보이고 세어진다. 알림을 누르면 사용자 관리에서 그 아이디를 찾는다 | 통합 · 화면 시험 · E2E |
| FR-2010 | **감사** — `auth.password.reset.request`(메일 재설정 요청 — `found`·`result`: `issued`(링크를 만들었다 — 메일이 나갔는지는 `mail.send`·`mail.fail`)·`throttled`·`ineligible`·`unmatched`), `auth.password.reset`(링크로 바꿈 — 성공은 `actor`, 실패는 까닭), `auth.email.help`(email 확인 요청 — `found`), `mail.send`·`mail.fail`(상세 `kind: "password_reset"`). email은 가린다(`maskEmail`), 값·링크는 싣지 않는다. 모두 필수 기록이다(단계와 무관 — `mail.send`만 P17대로 단계 2부터) | 통합 |
| FR-2011 | **IP별 제한**(`RATE_LIMITS`) — 메일 재설정 요청 3건/10분, 새 비밀번호 정하기 10건/10분, email 확인 요청 3건/10분. 관리자 요청은 그대로(3건/10분) | A등급 `packages/shared/src/constants.spec.ts`(값) · 경로마다의 `@RateLimit`(`apps/api/src/auth/auth.module.ts` — 가드는 P1 그대로) |
| FR-2012 | **실패를 구조화해 남긴다** — 응답 뒤에 도는 일(값 만들기·보내기·알림)이 우리 쪽 결함으로 실패하면 error 한 줄(`auth.reset_mail_failed`·`auth.email_help_failed`). 메일 API의 거절·연결 실패는 Phase 18의 줄(`mail.rejected`·`mail.failed`) | 통합 · `pnpm verify:docs`(장애대응 가이드에 코드가 있다) |
| FR-2013 | **화면** — 비밀번호 찾기 카드에 이름·email과 단추 둘("내 email로 재설정 링크 받기" — 쓸 수 있을 때만, "관리자에게 초기화 요청"), 결과는 카드 안에. 링크 화면(`/reset-password`)은 새 비밀번호와 확인 칸(눈 모양·규칙 안내·다르면 까닭 — P17 FR-1810 그대로) | 화면 시험 · E2E |

### B.2 편집기 서식 단추 줄 (F-013)

| # | 요구사항 | 확인 |
|---|---|---|
| FR-2020 | **전체 줄**(편집 화면 본문 칸 바로 위) — 문단 형식(본문·제목 1~3), 굵게·기울임·밑줄·취소선·인라인 코드, 글머리 목록·번호 목록, 인용·코드 블록·구분선, 링크, 표, 되돌리기·다시 | 화면 시험 `apps/web/src/components/FormatToolbar.spec.tsx` · `apps/web/src/components/formatActions.spec.ts` · E2E |
| FR-2021 | **짧은 줄**(댓글 쓰는 칸 위) — 굵게·기울임·인라인 코드·글머리 목록·번호 목록·링크 | 화면 시험 |
| FR-2022 | **상태와 조작** — 지금 켜진 서식은 눌림(`aria-pressed`), 지금 쓸 수 없는 것은 비활성(`editor.can()`), 이름은 한국어 + 단축키. Tab 한 번으로 줄에 들어가고 ←·→·Home·End로 옮긴다. 누르면 초점이 본문으로 돌아간다(A.1-18) | 화면 시험 |
| FR-2023 | **링크** — 화면 안의 대화로 주소를 받는다. 허용되는 주소(`linkAllowed`)만, 아니면 칸 아래 까닭. 고른 글이 없으면 주소를 글로 넣는다. 링크 위에서 누르면 지금 주소가 채워지고 **링크 빼기**가 있다 | 화면 시험 · `formatActions.spec.ts` |
| FR-2024 | **표** — 표 밖에서는 **표 넣기**(3×3, 첫 줄은 머리 칸). 표 안에서는 행 위에·아래에 더하기, 열 왼쪽·오른쪽에 더하기, 행 지우기, 열 지우기, 표 지우기. 만든 문서는 정본 검증(`validateDocument`)을 지나고 표 한계(`TABLE_LIMITS`)를 넘지 않는다 — 넘게 만드는 명령은 편집기가 하지 않는다(P12 FR-1323 그대로) | `formatActions.spec.ts`(명령마다 결과를 정본 검증) · E2E(실시간 편집 — 관문을 지나 저장된다) |
| FR-2025 | **실시간 편집에서도 같다** — 단추가 만든 변경이 관문(P9·P12)을 지나고 동료에게 가고 자동 저장된다. 되돌리기는 Yjs의 되돌리기(내 편집만) | E2E `e2e/format.spec.ts` |
| FR-2026 | **허용 목록과 편집기 스키마는 바뀌지 않는다** — 대조 시험(`extensions.spec.ts`)이 그대로 지난다 | `pnpm test` |
| FR-2027 | 읽기만 하는 본문(보기 화면·댓글 목록)에는 줄이 없다. 편집 화면의 줄은 편집 줄 아래에 붙는다(A.1-17) | 화면 시험 |

### B.3 비기능

| # | 요구사항 | 확인 |
|---|---|---|
| NFR-190 | 새 의존성 0 — 아이콘은 `icons.tsx`의 SVG(외부 자원 없음, `CLAUDE.md` 7절). 이미지 400MB 예산 안 | `pnpm check` · 컨테이너 |
| NFR-191 | **계정 열거 방지** — 세 요청(관리자 요청·메일 재설정·email 확인)의 응답 모양과 걸리는 시간이 계정의 존재·상태와 무관하다. 메일·알림은 응답 뒤에 돈다 | 통합(응답 모양) · 코드(응답이 기다리지 않는다) |
| NFR-192 | 마이그레이션 하나(`0013_recovery`) — 앱 계정은 새 표에 DML(모든 표 — P13 `app-role.ts`), 감사로그는 그대로 쌓기만 | 통합 `apps/api/src/db/app-role.integration.spec.ts` · 컨테이너 |

## C. 비밀번호를 잊었을 때 — 설계 (F-011)

### C.1 세 길

```
로그인 → 아이디·비밀번호 찾기
  ├ 비밀번호 찾기 카드 — 이름 · email [이메일이 기억이 안나시나요?]
  │   ├ 내 email로 재설정 링크 받기 ─ (맞고 받을 수 있으면) 메일 → /reset-password#t=… → 새 비밀번호 → 로그인
  │   └ 관리자에게 초기화 요청 ─ (맞으면) 관리자 알림 → 사용자 관리에서 초기화 → 임시 비밀번호 → 첫 로그인에서 변경
  └ /find-account/email — 안내 · 아이디 · 이름 → (맞으면) 시스템 관리자 알림 → 본인 확인 → 알려 준다
```

### C.2 API

| 경로 | 본문 | 응답 | 제한 |
|---|---|---|---|
| `GET /api/auth/config` | — | `{oidcEnabled, collabEnabled, resetMailEnabled}` | — |
| `POST /api/auth/recover-password` | `{displayName, email}` (**바뀜** — 전에는 `{username, email}`) | `{ok: true}` | `recoverPassword` 3/10분 |
| `POST /api/auth/reset-mail` | `{displayName, email}` | `{ok: true}` · 쓸 수 없으면 404 | `resetMail` 3/10분 |
| `POST /api/auth/reset-password` | `{token, newPassword}` | `{ok: true}` · 틀린 링크 400 · 약한 비밀번호 400(까닭) · 쓸 수 없으면 404 | `resetPassword` 10/10분 |
| `POST /api/auth/email-help` | `{username, displayName}` | `{ok: true}` | `emailHelp` 3/10분 |

모두 로그인 없이 부른다(`@Public`). 상태를 바꾸는 요청이라 CSRF 머리말은 그대로 요구한다(7절 — 화면의 `api()`가 싣는다).

### C.3 데이터 — `password_reset_tokens` (`0013_recovery`)

| 열 | 형 | 뜻 |
|---|---|---|
| `id` | uuid PK | |
| `user_id` | uuid → `users(id)` ON DELETE CASCADE | 누구의 링크 |
| `token_hash` | text UNIQUE | 값의 SHA-256(16진) — 값은 두지 않는다 |
| `password_mark` | text | 발급 때 그 사람의 비밀번호 해시에서 뽑은 SHA-256 — 쓸 때 지금 해시의 것과 견준다(A.1-4) |
| `created_at` | timestamptz | 간격 판정(A.1-7) |
| `expires_at` | timestamptz | 기한 |

- 한 사람에게 살아 있는 링크는 **하나**다 — 새로 만들 때 그 사람의 행을 모두 지우고 넣는다(사용자 행을 잠그고 — 동시에 두 요청이 와도 한 통). 기한이 지난 행은 새로 만들 때 함께 지운다.
- 쓰면 그 사람의 행을 모두 지운다. "썼다" 표시를 따로 두지 않는다 — 지운 값은 다시 쓸 수 없다.
- 로그인 줄·세션 규칙은 비밀번호 변경과 같다(P13 D.4).

### C.4 메일

```
제목  [위키] 비밀번호 재설정
평문  {이름} 님, 비밀번호 재설정을 요청하셨습니다.

      아래 주소를 열어 새 비밀번호를 정해 주세요. 30분 동안 한 번만 쓸 수 있습니다.
      {WF_PUBLIC_URL}/reset-password#t={값}

      요청하지 않으셨다면 이 메일을 지우셔도 됩니다 — 비밀번호는 바뀌지 않습니다.
```

마크다운은 이름을 굵게, 주소를 "새 비밀번호 정하기" 링크로(P18 `mentionMail`과 같은 이스케이프). 만드는 곳은 `apps/api/src/mail/domain/compose.ts`의 `passwordResetMail` 한 곳이다.
공개 주소 끝의 `/`는 뗀다.

### C.5 알림 — `email.confirm.request`

- 받는 사람: 활성 root 가운데 요청한 사람이 아닌 모두. 읽지 않은 같은 요청(같은 요청자)이 있으면 그 사람에게는 또 만들지 않는다(P17 FR-1802와 같은 모양).
- 보이는 사람: 지금 root인 사람만(목록·안 읽은 수 모두 — P17 FR-1804와 같은 자리 `visibleKinds`).
- 글: "**{이름}** ({아이디})님의 아이디·이름으로 email 확인이 요청됐다 — 본인에게 확인한 뒤 알려 준다 · 사용자 관리에서 보기".
- 그 사람의 비밀번호가 바뀌면(관리자 초기화·링크 재설정) 초기화 요청 알림과 함께 읽음으로 한다 — 둘 다 "로그인하지 못한다"는 같은 문제의 요청이다.

### C.6 모듈

| 모듈 | 하는 일 |
|---|---|
| `apps/api/src/auth/recovery.service.ts` | 메일 재설정 요청·링크 쓰기·email 확인 요청. 로그인 줄은 `AuthService`의 것을 쓴다(한 프로세스에 한 줄 — P13 FR-1431) |
| `apps/api/src/auth/domain/reset-link.ts` | 값 만들기·해시·비밀번호 표시·링크 주소·기한·간격 판정 — 순수 함수 |
| `apps/api/src/auth/auth.service.ts` | 관리자 요청의 조건(이름+email), 로그인 줄을 빌려 준다(`inAccountLine`) |
| `apps/api/src/users/users.service.ts` | 초기화 요청의 대상 찾기(이름+email) |
| `apps/api/src/notifications/notifications.service.ts` | email 확인 요청 알림·보이는 종류·읽음 처리 |

## D. 편집기 서식 단추 줄 — 설계 (F-013)

### D.1 단추

| 무리 | 단추 (이름 · 단축키) | 전체 | 짧은 줄 | 명령 |
|---|---|---|---|---|
| 문단 | 문단 형식 — 본문 · 제목 1 · 제목 2 · 제목 3 (고르는 칸) | ✓ | | `setParagraph` · `toggleHeading` |
| 글자 | 굵게 (Ctrl+B) · 기울임 (Ctrl+I) · 밑줄 (Ctrl+U) · 취소선 (Ctrl+Shift+S) · 코드 (Ctrl+E) | ✓ | 굵게·기울임·코드 | `toggleBold` 등 |
| 목록 | 글머리 목록 (Ctrl+Shift+8) · 번호 목록 (Ctrl+Shift+7) | ✓ | ✓ | `toggleBulletList` · `toggleOrderedList` |
| 블록 | 인용 (Ctrl+Shift+B) · 코드 블록 (Ctrl+Alt+C) · 구분선 | ✓ | | `toggleBlockquote` · `toggleCodeBlock` · `setHorizontalRule` |
| 넣기 | 링크 (Ctrl+K — 대화) · 표 넣기 | ✓ | 링크 | D.2 · `insertTable({rows: 3, cols: 3, withHeaderRow: true})` |
| 표 (표 안에서만 보인다) | 위에 행 · 아래에 행 · 왼쪽에 열 · 오른쪽에 열 · 행 지우기 · 열 지우기 · 표 지우기 | ✓ | | `addRowBefore` 등 |
| 이력 | 되돌리기 (Ctrl+Z) · 다시 (Ctrl+Y) | ✓ | | `undo` · `redo`(실시간 편집이면 Yjs의 것) |

- 단축키는 편집기가 이미 가진 것이다. **링크의 Ctrl+K만 새로** 둔다(대화를 연다).
- 제목은 1~3까지만 고르는 칸에 둔다 — 허용 목록은 1~6을 받고 `####`로 친 제목은 그대로 쓰인다. 고르는 칸은 지금 제목 단계를 보이고, 4~6이면 "제목 4" 같은 줄을 그때만 더한다.
- 단추 목록·켜짐·쓸 수 있음·실행은 `apps/web/src/components/formatActions.ts`(React 밖 — 3절)가 들고, 줄(`FormatToolbar.tsx`)은 그것을 그린다. 편집기 상태가 바뀔 때마다 다시 그린다(`useEditorState`).

### D.2 링크 대화

- 열 때: 커서가 링크 위면 그 주소, 아니면 비어 있다. 첫 초점은 주소 칸.
- **넣기**: 앞뒤 빈칸을 떼고 `linkAllowed`로 본다. 아니면 "http(s)로 시작하는 주소나 `/`로 시작하는 위키 안 주소만 링크가 된다"를 칸 아래에 보이고 닫지 않는다.
  고른 글이 있으면 그 글에 링크를 걸고(`extendMarkRange('link').setLink`), 없으면 주소를 글로 넣고 링크를 건다.
- **링크 빼기**(링크 위에서만): `unsetLink`. **그만두기**·Esc: 아무것도 하지 않는다. 닫으면 초점이 본문으로.

### D.3 실시간 편집과

단추는 편집기 명령을 부를 뿐이다 — 새 노드·속성·마크를 만들지 않는다. 편집기 스키마와 허용 목록이 같다는 것은 대조 시험이 증명하고(P9 D.7·P12), 명령은 스키마를
어기는 문서를 만들 수 없다. 그래도 **실제로 지나는지** E2E가 본다 — 실시간 편집 화면에서 단추로 제목·목록·표·링크를 만들고, 관문이 끊지 않고, 동료 화면에 보이고,
저장본에 남는다.

## E. 모듈과 등급

| 모듈 | 등급 | 시험 |
|---|---|---|
| `packages/shared/src/schemas.ts` — `recoverPasswordDto`(이름+email — 관리자 요청과 메일 재설정이 같이 쓴다), `resetPasswordDto`(`RESET_TOKEN_PATTERN`), `emailHelpDto` | A | `packages/shared/src/schemas.spec.ts` |
| `packages/shared/src/permissions.ts` — `canResetPasswordByMail` | A | `packages/shared/src/permissions.spec.ts` |
| `packages/shared/src/policy.ts` — `passwordResetMail` | A | `packages/shared/src/policy.spec.ts` |
| `packages/shared/src/constants.ts` — `PASSWORD_RESET`, `RATE_LIMITS`, `AUDIT_ACTIONS`, `LOG_EVENTS`, `NOTIFICATION_KINDS` | A | `packages/shared/src/constants.spec.ts` |
| `apps/api/src/auth/domain/reset-link.ts` | A | `apps/api/src/auth/domain/reset-link.spec.ts` |
| `apps/api/src/mail/domain/compose.ts` — `passwordResetMail` | A | `apps/api/src/mail/domain/compose.spec.ts` |
| `apps/api/src/auth/recovery.service.ts` · `auth.module.ts`(경로) · `auth.service.ts` · `users.service.ts` · `notifications.service.ts` · `db/schema.ts` · `drizzle/0013_recovery.sql` | B | 통합 `apps/api/src/auth/recovery.integration.spec.ts` · `auth.integration.spec.ts` · `notifications.integration.spec.ts` |
| `apps/web/src/pages/FindAccountPage.tsx` · `EmailHelpPage.tsx` · `ResetPasswordPage.tsx` · `components/NotificationText.tsx` · `pages/admin/AdminPolicyPage.tsx` · `components/policyNames.ts` · `pages/admin/AdminUsersPage.tsx`(이름 아래 email — A.1-21) · `components/ui.tsx`(`Field`의 `aside`) | B(web) | 화면 시험(같은 이름의 `.spec.tsx`) |
| `apps/web/src/components/formatActions.ts` · `FormatToolbar.tsx` · `LinkDialog.tsx` · `icons.tsx` · `Editor.tsx` · `CollabEditor.tsx` · `Comments.tsx` · `pages/PageEditorPage.tsx` · `styles.css` | B(web) | `formatActions.spec.ts` · `FormatToolbar.spec.tsx`(링크 대화 포함) |
| `e2e/recovery.spec.ts`(가짜 사내 메일 서버를 스스로 띄운다) · `e2e/format.spec.ts` | C | `pnpm test:e2e` |

## F. 설정 항목

| 이름 | 어디 | 기본 | 뜻 |
|---|---|---|---|
| `passwordResetMail` | 운영 설정(DB `settings`, 관리 → 운영 설정의 "세션·계정") | `1`(켬) | 0이면 메일 재설정을 쓰지 않는다 — 단추가 사라지고 이미 보낸 링크도 막힌다(A.1-9) |
| `PASSWORD_RESET.linkMinutes` | `packages/shared/src/constants.ts` | 30 | 링크의 기한(분) |
| `PASSWORD_RESET.mailIntervalMinutes` | `packages/shared/src/constants.ts` | 5 | 한 계정에 메일을 다시 보내기까지(분) |
| `WF_MAIL_*` · `WF_PUBLIC_URL` | `.env` (Phase 18 · Phase 6) | — | 그대로 쓴다. `WF_PUBLIC_URL`이 비면 메일 재설정은 쓸 수 없다 |

**새 `WF_` 키는 없다.** `.env.example`·compose·Windows 체험 묶음은 바뀌지 않는다.

## G. Confluence 대조

| Confluence | 우리 | 까닭 |
|---|---|---|
| 비밀번호를 잊으면 아이디나 email을 적고, 그 계정의 email로 재설정 링크 | **변형** — 표시 이름과 email **둘 다**, 링크는 30분·한 번, root는 빠진다 | 사용자 원문 3번. 하나만 받으면 email 목록으로 누구에게나 메일을 보낼 수 있다. root의 메일함 하나로 시스템 전체가 넘어가지 않게(쟁점 1) |
| 관리자가 사용자의 비밀번호를 초기화 | **채택**(이미 있다) — 사용자가 요청하면 관리자의 알림에 온다(P17) | 메일이 닿지 않는 현장에서도 길이 하나 있어야 한다 |
| email을 모르면 관리자에게 문의(안내문뿐) | **변형** — 화면에서 시스템 관리자에게 확인 요청이 알림으로 간다 | 사용자 원문 4번 |
| 편집기 위의 서식 막대 — 문단 형식·글자 서식·목록·정렬·색·링크·표·이미지·매크로·멘션·이모지 | **채택(일부)** — 문단 형식·글자 서식·목록·인용·코드·구분선·링크·표·되돌리기 | 허용 목록 안의 것만(쟁점 4). 정렬·색·이미지는 허용 목록에 없다 — 넣으면 정본 검증과 관문을 바꾸는 일이다. 멘션은 `@`로 친다 |
| 표 막대(칸 합치기·나누기·머리 칸·칸 색) | **변형** — 행·열 더하기/지우기·표 지우기 | 합치기는 표 한계(P12)에 닿는 명령이고(누가 999를 심어 둔 표에서 합치면 끊겼다), 사용자가 빼기로 골랐다(쟁점 4) |

## H. 보류 결정

- **보류 18(사내 메일 API 실연동)** — 메일 재설정도 그 뒤에 선다. 현장 절차(반입 가이드 10-1절)에 "비밀번호 찾기의 메일 한 통"을 더한다. 모의·가짜 서버 통과는 완료가 아니다(9.1절).
- 새 보류는 없다. F-001(비밀번호 자가 재설정을 다시 볼 것)은 이 Phase가 답한다 — 백로그에서 닫는다.

## I. 남는 것 · 하지 않는 것

- 하지 않는다: 링크를 누르면 곧바로 로그인(A.1-10), 비밀번호를 메일로 보내기, root의 메일 재설정(쟁점 1), 표 칸 합치기·나누기(쟁점 4), 정렬·색·이미지 단추(허용 목록 밖), 로컬 계정의 email 바꾸기(요구가 없다).
- 남는 것: 실제 사내 메일로 링크가 닿는지(보류 18 — 현장). 사내 메일 API가 `http`면 링크가 평문으로 사내망을 지난다(A.1-16).
