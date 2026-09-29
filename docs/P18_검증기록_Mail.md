# P18 검증기록 — Mail (사내 메일 API를 현장에서 설정해 붙인다 — F-012)

- 작성일: 2026-09-29 / 작성 LLM: Claude Opus 5.5
- 설계: [`docs/P18_설계서_Mail.md`](P18_설계서_Mail.md) · 검토: 6절과 [`docs/internal/P18_검토서_Review.md`](internal/P18_검토서_Review.md)
- 요청 원문: `docs/prompts/phase18/scope.md` (사내 메일 API의 모양은 `docs/prompts/phase17/scope.md`)
- 시행착오는 [`docs/internal/검토서_트러블슈팅.md`](internal/검토서_트러블슈팅.md)에만 적는다

## 1. 요구사항과 확인

요구사항의 글은 설계서 B절이 단일 출처다. 여기에는 무엇으로 확인했는지만 적는다.

| # | 확인 | 어디서 |
|---|---|---|
| FR-1900 | 요청이 사용자가 준 모양이다 — `POST`, `application/json; charset=utf-8`, `{subject, content, receivers, sender_name}`, 받는 사람은 한 통에 하나 | A등급 `apps/api/src/mail/domain/request.spec.ts` · 통합 `apps/api/src/mail/mail.spec.ts`(가짜 메일 서버가 받은 것) · 컨테이너(5절) |
| FR-1901 | `WF_MAIL_FORMAT`이 `markdown`이면 마크다운 본문 — 이름·제목의 마크다운 글자를 이스케이프하고 바로 가기는 링크. 평문은 Phase 6의 글 그대로 | A등급 `apps/api/src/mail/domain/compose.spec.ts`·`packages/shared/src/markdown.spec.ts` · 멘션 한 번을 평문·마크다운으로 보내 가짜 서버가 받은 것(4절) |
| FR-1902 | 인증 헤더는 이름과 값이 둘 다 있을 때만 싣고, 한쪽만이면 기동 실패. 값은 창·로그·감사에 나가지 않고 응답이 되읊으면 가린다 | A등급(`packages/shared/src/env.spec.ts`·`request.spec.ts`) · 통합(`mail.spec.ts`·`apps/api/src/cli/mail-test.integration.spec.ts`) · 컨테이너(401 응답이 되읊은 키가 `***`) |
| FR-1903 | 2xx만 성공, 넘겨주기를 따르지 않는다, 실패는 `false`(던지지 않는다), 응답 본문은 로그에 싣지 않는다 | 통합 `mail.spec.ts`(200·400·401·500·503·302·끊김·닿지 않음) |
| FR-1904 | 기동 검사 — 주소 모양(http(s), 사용자 정보·질의·조각 없음), 헤더 이름·값의 글자, 켰는데 주소 없음, 운영에서 켰는데 모의, 옛 키 | A등급 `packages/shared/src/mail.spec.ts`·`packages/shared/src/env.spec.ts` · 컨테이너(운영에서 켰는데 모의면 `tools`도 뜨지 않는다) |
| FR-1905 | 시험 명령 — 설정을 말하고(값은 가림) 한 통 보내 결과와 까닭, 켜지 않아도 보낸다, 0/1, 감사(`mail.send`는 단계 2부터 · `mail.fail`은 늘, `kind: "test"`), DB에 닿지 않아도 결과는 그대로 | 통합 `apps/api/src/cli/mail-test.integration.spec.ts` · 컨테이너(반입 가이드의 명령을 적힌 그대로) |
| FR-1906 | 현장 절차 — 반입 가이드 10-1절, 장애대응 7.21, 운영이관, 학습가이드 6.18 | `pnpm verify:docs` · 가이드의 명령을 이 서버의 컨테이너에서 가짜 메일 서버로 적힌 그대로 쳤다(5절) |
| NFR-180 | 새 의존성 0, 표 변경 0, 화면 변경 0. `tools`가 메일 설정과 사내 CA를 받는다 | lockfile 변경 없음 · 마이그레이션 13개 그대로 · 컨테이너 |
| 제목 한 줄(P7 C.4.1) | 메일 제목의 줄바꿈·제어 글자는 보내는 경계에서 빈칸으로 | A등급 `request.spec.ts`(Red `84365a2` → Green `2cc0e18`) |

## 2. 자동 검사

`pnpm test:cov`(세 패키지를 차례로) — 실패 0 · 건너뜀 0. 수치는 실행 출력의 요약과 커버리지 보고서(`coverage-summary.json`).
`pnpm lint`·`pnpm typecheck` 종료 0 · `pnpm verify:docs` 위반 없음 · 브랜치 CI 초록(10절).

| 패키지 | 시험 파일 | 시험 | 라인 | 브랜치 | 함수 |
|---|---|---|---|---|---|
| shared (A) | 13 | 429 | 99.87% | 97.06% | 99.41% |
| api (A+B) | 71 | 1,147 | 96.19% | 91.49% | 94.10% |
| web (측정만) | 42 | 366 | 93.56% | 83.91% | 88.15% |

Phase 17 끝(shared 411 · api 1,120 · web 366)에서 shared 18 · api 27이 늘었다. 새 시험 파일 넷 — `packages/shared/src/mail.spec.ts`, `apps/api/src/mail/domain/compose.spec.ts`·
`request.spec.ts`, `apps/api/src/cli/mail-test.integration.spec.ts`. web은 바뀌지 않았다.

이번 Phase가 만진 모듈:

| 모듈 | 등급 | 라인 | 브랜치 | 함수 |
|---|---|---|---|---|
| shared `mail.ts` | A | 100 | 95.45 | 100 |
| shared `env.ts` | A | 100 | 100 | 100 |
| shared `markdown.ts` | A | 100 | 94.33 | 100 |
| api `mail/domain/compose.ts` | A | 100 | 100 | 100 |
| api `mail/domain/request.ts` | A | 100 | 97.61 | 100 |
| api `mail/http.sender.ts` | B | 100 | 100 | 66.66 |
| api `mail/mention-mail.service.ts` · `mock.sender.ts` | B | 100 | 100 | 100 |
| api `cli/mail-test.ts` | B | 90 | 81.81 | 28.57 |

- **A등급은 시험을 먼저 썼다** — Red → Green: `afa405e` → `cf7478f`(판정·설정·마크다운·메일 글·요청), `84365a2` → `2cc0e18`(제목 한 줄).
- `mail-test.ts`의 함수 수치가 낮은 것은 컨테이너의 입구(`require.main === module`의 화살표 함수들)를 시험이 부르지 않아서다 — 본문(`mailTest`)은 통합 시험이 부르고, 입구는
  컨테이너에서 적힌 그대로 쳤다(5절). `http.sender.ts`의 함수 하나는 본문을 비울 때의 `catch` 화살표다.

## 3. 돌연변이 — 만든 곳을 틀리게 바꿔 봤다

**21개, 모두 시험이 실패했다.** 스크립트가 저장소 밖의 작업 폴더(같은 커밋)에서 파일을 바꾸고 그 시험 파일을 돌린 뒤 되돌린다. 목록은 검토서 4절.

## 4. 브라우저 — E2E, 그리고 멘션 메일 한 통

새 빌드를 호스트 `:3000`에 **메일을 켠 채**(모의 아님, 주소는 호스트의 가짜 사내 메일 서버) 띄우고 `pnpm test:e2e` — **38 통과 · 실패 0 · 건너뜀 0 (1.3분).**
E2E의 계정은 email이 없어(픽스처가 비운다) 멘션 메일이 나가지 않는다 — 그래서 email이 있는 두 계정으로 API를 불러 팀 스페이스·Crew·페이지(제목 `*주간* [회의]`)·
`@아이디` 댓글을 만들었다. 가짜 서버가 받은 것:

- 평문(`/send`): `subject` `[위키] 메일 확인 *A* 님이 회원님을 불렀습니다`, `receivers` 받는 사람 한 명, `sender_name` `위키`, `content` Phase 6의 글 그대로(문서 제목·바로 가기, 본문 없음)
- 마크다운(`/send_markdown`, 앱을 `WF_MAIL_FORMAT=markdown`으로 다시 띄워): `content`가 `**메일 확인 \*A\*** 님이 …` · `문서: **\*주간\* \[회의\]**` · "문서 열기" 링크 — 이름·제목의 마크다운 글자가 이스케이프됐다(병합 전 검토 전의 코드로 쟀다 — 반영 뒤는 10절)

두 계정은 확인 뒤 지웠다.

## 5. 컨테이너

이미지 `1dd60fb`(라벨 = 빌드한 때의 HEAD), **380MB**(Phase 17과 같다 — 새 의존성 0). 이미지에 `dist/cli/mail-test.js`가 있다. 같은 망(`deploy_default`)에 가짜 사내 메일
서버를 띄우고, 반입 가이드 10-1절의 명령을 `deploy` 폴더에서 **적힌 그대로** 쳤다(값은 셸의 환경변수로 덮었다 — compose가 `.env`보다 앞세운다).

| 무엇 | 결과 |
|---|---|
| 적힌 그대로(`.env`에 주소 없음) | `WF_MAIL_API_URL이 비었다 — … (반입 가이드 "사내 메일 연결하기")`, 종료 1 |
| 평문 · 인증 없음 | 설정 세 줄(주소 · `형식: text · 보내는 이름: 위키 · 인증: 없음` · `지금 앱은 메일을 보내지 않는다(WF_MAIL_ENABLED=false …)`) → `보냈다 — HTTP 200` → `감사로그에 mail.send로 남겼다`, 종료 0. 가짜 서버가 받은 것은 1절 FR-1900의 모양 그대로 |
| 마크다운 · `X-API-Key` · 보내는 이름 `사내 위키` | `인증: X-API-Key 헤더(값은 가린다)`, 가짜 서버가 `/send_markdown`에서 헤더(10자)와 마크다운 본문·`sender_name` `사내 위키`를 받았다 |
| 401 — 응답이 키를 되읊음 | `받지 않았다 — HTTP 401. 인증을 받지 않았다 — WF_MAIL_AUTH_HEADER·WF_MAIL_AUTH_VALUE …` · `응답: {"message":"invalid key ***"}` · `mail.fail`, 종료 1 |
| 운영에서 켰는데 모의(`WF_MAIL_ENABLED=true`만) | `tools`가 뜨지 않는다 — `WF_MAIL_MOCK: 운영(production)에서 메일을 켰으면 false여야 한다 …` |
| 학습가이드 6.18의 감사 확인 명령(적힌 그대로) | `mail.fail`·`mail.send`·`mail.send` 세 줄, 상세 `{"kind": "test", "sent": …, "recipients": 1}` |
| api를 메일을 켠 설정(운영, 모의 아님, 가짜 서버)으로 `up -d --force-recreate api` | **12초**에 `HTTP 200`. 컨테이너 환경에 `WF_MAIL_*` 일곱 키가 있다. 확인 뒤 원래 설정으로 다시 만들었다 |

## 6. 검토

(병합 전 검토 뒤 적는다)

## 7. 보류 결정 처리

- **보류 18(사내 메일 API 실연동)** — 트리거를 **"폐쇄망 반입 뒤 현장에서"**로 바꿨다(착수 쟁점 2 — 사용자 답 "닿지 않는다 — 반입 뒤 현장에서"). 판정은 반입 가이드 10-1절.
  이 Phase는 가짜 메일 서버로만 확인했다 — **모의 통과는 완료가 아니다**(9.1절).

## 8. 기능백로그

| # | 처리 |
|---|---|
| F-012 | 이 Phase에서 했다 — 현장의 실제 한 통은 보류 18 |
| F-011 | 사용자가 정한다 — 본인 email로 재설정(2번)의 전제(메일이 닿는다)가 이 Phase로 준비됐다. 다만 P1 FR-209a(로그인하지 않은 자가 재설정을 뺀 판단)는 F-011을 할 때 다시 본다 |

## 9. 확인하지 못한 것

- **실제 사내 메일 API로 한 통** — 개발 서버에서 닿지 않는다(보류 18 — 현장). 응답의 모양(200의 본문, 400·500의 문장), 인증이 필요한지, 마크다운을 어떻게 그리는지는 현장에서 본다.
- **사내 API가 제목을 어떻게 다루는지** — 줄바꿈·제어 글자는 우리가 빈칸으로 바꾸지만, 그 API가 제목을 SMTP 헤더로 옮길 때 다른 글자를 어떻게 다루는지는 모른다.
- **https와 사내 인증 기관** — `tools`에 `ca` 자리를 이었고 시작 스크립트가 같은 길로 믿게 한다(Phase 11과 같은 길). 사내 기관이 서명한 https 메일 서버로는 보지 않았다.

## 10. 마지막 확인

(종료 루틴에서 적는다)
