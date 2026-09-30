# P18 설계서 — Mail (사내 메일 API를 현장에서 설정해 붙인다 — F-012)

Phase 6은 멘션을 메일로도 보내게 만들었지만, 사내 메일 API의 요청 형식을 몰라 **가정한 모양**(`Authorization: Bearer` + `{from, to[], subject, text}`)으로
만들었다(P6 A.1, 보류 18). 사용자가 사내 메일 API의 실제 모양을 주었다(백로그 F-012). Phase 18은 그 모양으로 보내고, 현장마다 다를 수 있는 것(주소·인증·
본문 형식·보내는 이름)을 **설정으로** 맞추고, 반입 뒤 현장에서 한 통을 보내 보는 명령과 절차를 둔다.

- 요청 원문: `docs/prompts/phase18/scope.md` (F-012의 첫 요청과 API 모양은 `docs/prompts/phase17/scope.md`)
- 요구사항 번호: **FR-1900**, 비기능 **NFR-180**부터
- 선행: [`docs/P6_설계서_Collab.md`](P6_설계서_Collab.md) A.1·B.5(메일 FR-750~757) · [`docs/P10_설계서_Llm.md`](P10_설계서_Llm.md)(사내 LLM — 반입 뒤 현장에서 붙이는 같은 모양) ·
  [`docs/P13_설계서_Readiness.md`](P13_설계서_Readiness.md)(compose의 `tools`)
- 구조: [`docs/설계서_Architecture.md`](설계서_Architecture.md) — 2절 DIP 표의 "알림 발송" 축(`MAIL_SENDER`)

## A. 착수 쟁점 (2026-09-29)

| # | 쟁점 | 사용자 답 | 이 설계가 한 것 |
|---|---|---|---|
| 1 | 사내 메일 연결을 어디서 설정하나 — 설정 파일 + 시험 명령 / 관리 화면에서 등록·시험 | "사내 메일은 api로 메일 보내기만 할 수 있음" | 설정할 것이 API 하나뿐이다 — 추천안대로 **설정 파일(`WF_MAIL_*`) + 시험 명령**(A.1-1) |
| 2 | 이 개발 서버에서 사내 메일 API에 닿나 | **"닿지 않는다 — 반입 뒤 현장에서"** | 개발은 가짜 메일 서버로 형식을 확인하고, 실제 한 통은 폐쇄망 현장에서 설치및실행가이드대로 보낸다. 보류 18의 트리거를 "반입 뒤 현장에서"로 바꾼다(보류 29와 같다) |
| 3 | 본문을 어느 주소로 — `/send`(평문) · `/send_markdown` | **"설정으로 고른다"** | `WF_MAIL_FORMAT`(`text` 기본 · `markdown`). 마크다운이면 제목·이름의 마크다운 글자를 이스케이프하고 링크를 링크로 싣는다 |
| 4 | 인증(키·토큰)이 필요한가 — 예시에는 인증 헤더가 없었다 | **"모른다 — 설정으로 둘 다 (추천)"** | 기본은 인증 없음. 필요하면 헤더 이름과 값 두 줄(`WF_MAIL_AUTH_HEADER`·`WF_MAIL_AUTH_VALUE`) |

## A.1 묻지 않고 정한 것 — 근거와 되돌릴 조건

| # | 정한 것 | 근거 | 되돌릴 조건 |
|---|---|---|---|
| 1 | 설정은 `deploy/.env`의 `WF_MAIL_*`, 바꾸면 앱을 다시 만든다(`up -d --force-recreate api`). 관리 화면은 두지 않는다 | 쟁점 1의 답 — 사내 메일은 "API로 보내기"뿐이라 설정이 다섯 줄이다. 화면으로 하면 키를 DB에 암호화해 두는 표·화면·권한이 늘어 크기가 L이 된다(사내 LLM은 여러 개를 등록하고 사람마다 고르므로 화면이 필요했다) | 운영 중 재기동 없이 바꿔야 한다는 요구가 오면 사내 LLM처럼 관리 화면으로 옮긴다 |
| 2 | 본문 필드는 **사용자가 준 모양으로 고정**한다 — `{"subject", "content", "receivers", "sender_name"}`. 필드 이름을 설정으로 바꾸게 하지 않는다 | 모양은 이제 가정이 아니라 사내 API의 설명이다. 필드 이름까지 설정으로 두면 현장에서 틀릴 자리만 늘고, 시험이 모든 조합을 볼 수 없다 | 현장의 API가 다른 필드를 요구하면 `apps/api/src/mail/domain/request.ts` 한 파일을 고친다(모양은 그 파일의 시험이 지킨다) |
| 3 | **한 통에 받는 사람 하나**(`receivers`에 주소 하나) | Phase 6 자체 점검 21 — 한 통에 여럿을 넣으면 서로의 주소와 "누가 함께 불렸는지"가 드러난다. API는 쉼표로 이은 여럿을 받지만 쓰지 않는다 | 없음 |
| 4 | 주소는 **형식마다 하나** — `WF_MAIL_API_URL`에 고른 형식의 주소(`…/send` 또는 `…/send_markdown`)를 적는다. 주소 키를 둘 두지 않는다 | 형식은 하나만 쓴다. 두 키를 두면 쓰지 않는 쪽이 틀려도 모른다. 시험 명령이 형식과 주소를 함께 보여 주고, 마크다운인데 주소가 `markdown`으로 끝나지 않으면 알린다 | 없음 |
| 5 | 보내는 이름(`sender_name`)의 기본은 **`위키`** | 메일 제목이 `[위키] …`다. 비워 두면 API가 400(필수 값 누락)을 줄 수 있다 — 기본값이 있으면 설정을 하나 덜 적는다 | 없음 — 현장에서 바꾼다 |
| 6 | 설정 키 둘을 바꾼다 — `WF_MAIL_FROM`(보내는 **주소**) → `WF_MAIL_SENDER_NAME`(보내는 **이름**), `WF_MAIL_API_TOKEN`(`Bearer`를 붙여 보냄) → `WF_MAIL_AUTH_HEADER`·`WF_MAIL_AUTH_VALUE` | 뜻이 바뀐 키를 같은 이름으로 두면 옛 값이 조용히 다른 뜻으로 쓰인다. 아직 폐쇄망에 반입하지 않았고 이 서버의 `deploy/.env`에도 두 키가 없다. 개발 `.env`에 옛 키가 있으면 앱이 뜨지 않는다(모르는 `WF_` 키 — 5절) | 없음 |
| 7 | 넘겨주기(3xx)를 따르지 않는다(`redirect: 'error'`) | 인증 헤더가 다른 곳으로 따라가지 않게 — 사내 LLM(P10)과 같은 판단 | 없음 |
| 8 | 시험 명령은 **켜져 있지 않아도 보낸다**(`WF_MAIL_ENABLED=false`·`WF_MAIL_MOCK=true`여도) | 켜기 전에 연결을 확인하는 명령이다. 앱이 지금 메일을 보내는지는 따로 말한다 | 없음 |
| 9 | 시험 명령은 실패했을 때 **응답 본문을 200자까지** 창에 보인다(인증 값은 가린다). 앱 로그에는 여전히 싣지 않는다 | 현장에서 "필수 파라미터 누락"처럼 까닭을 알아야 고친다. 운영자가 서버에서 친 명령의 창이고 `run --rm`은 끝나면 컨테이너와 그 로그를 지운다. 앱 로그는 오래 남고 남이 읽는다(7절 로그) | 없음 |
| 10 | 시험 메일도 감사에 남긴다 — `mail.send`(단계 2부터)·`mail.fail`(늘), 상세 `kind: "test"` | 6절 감사 대상 "메일 발송 성공·실패". 휴지통 정리 명령처럼 소유 계정으로 직접 넣는다. DB에 닿지 않아도 메일 시험은 한다(경고만, DB 연결은 5초까지) | 없음 |
| 11 | **받는 사람이 주소 하나가 아니면 보내지 않는다**(`isSingleRecipient` — `mail.bad_recipient`), 사내 계정의 email 클레임도 주소 하나일 때만 적고 아니면 비우며 경고한다(`auth.oidc_email_dropped`). 판정은 공유 `isSingleMailAddress` — 쉼표·세미콜론·빈칸·꺾쇠·따옴표·제어 글자, `@`가 하나가 아닌 것만 막고 **모양은 까다롭게 보지 않는다** | 사내 API는 `receivers`의 쉼표를 목록으로 읽는다 — 사내 계정의 email은 로그인 때 받아 적는데 형식을 보지 않았다(병합 전 보안 검토 2·자체 점검 높음). 처음 판은 가입 검사(`emailSchema`)로 봤는데 그것은 `user@corp` 같은 한 단어 도메인을 거절해, 사내 주소가 그 모양이면 부르기 메일이 신호 없이 멈췄다(좁은 재점검 보통 1). 고쳐 보내지 않고 그 한 통을 실패로 친다 | 사내 주소가 그 판정에 걸리는 모양이면 다시 본다 |
| 12 | **보내는 길은 한 곳**(`apps/api/src/mail/post.ts`) — 앱과 시험 명령이 같이 쓴다. 본문은 시험 명령이 **받지 않았을 때만** 앞 4KB까지 읽는다 | 두 벌이면 한쪽만 바뀌어 시험 명령이 앱과 다른 것을 확인하게 된다(코드 리뷰 4) | 없음 |
| 13 | 인증 헤더 이름으로 요청의 모양을 바꾸는 머리말(`Host`·`Content-Type`·`Content-Length`·`Transfer-Encoding` 등)을 받지 않는다. 헤더 값은 보이는 ASCII만. 보내는 이름은 제어 글자·빈칸뿐을 받지 않는다 | 운영자 실수로 요청이 깨지거나(값이 한글이면 보낼 때마다 실패하고 그 오류 문장이 비밀 값의 글자 위치를 로그에 남긴다) 비밀이 다른 머리말에 실린다(병합 전 보안 검토 5·코드 리뷰 2·12) | 사내 API가 ASCII 밖의 값을 요구하면 다시 본다 |
| 14 | 메일의 이름·제목은 **한 줄**이다(줄 끝 CR·C1·유니코드 줄 구분자 포함 — 제목은 보내는 경계에서 한 번 더). 마크다운의 `<`·`>`·`&`는 **엔터티**로 | 줄바꿈이 새 줄을 만들면 가짜 "바로 가기" 줄이나 줄 머리 서식이 되고(보안 검토 3·코드 리뷰 3), `\<`를 이스케이프로 읽지 않는 렌더러(Markdown.pl 계열)에서는 제목의 `<a href=…>`가 숨은 링크가 된다(보안 검토 1) | 없음 |
| 15 | 시험 명령은 앱 상태를 "설정(.env)대로면 앱은 …"으로 말하고 `--force-recreate api`를 붙인다. http 주소에 인증을 실으면 평문으로 간다고 알린다 | 그 명령이 읽는 것은 `.env`다 — 떠 있는 앱은 다시 만들지 않았으면 옛 설정이다(자체 점검 2). 사내 LLM 등록 화면의 http 알림과 같다(보안 검토 5) | 없음 |

## B. 요구사항

| # | 요구사항 | 확인 |
|---|---|---|
| FR-1900 | **요청 모양** — `POST {WF_MAIL_API_URL}`, `content-type: application/json; charset=utf-8`, 본문 `{"subject", "content", "receivers", "sender_name"}`. `receivers`는 주소 하나(A.1-3 — 주소 하나가 아니면 보내지 않는다, A.1-11), `sender_name`은 `WF_MAIL_SENDER_NAME`. 제목은 한 줄(A.1-14) | A등급 `apps/api/src/mail/domain/request.spec.ts` · 통합 `apps/api/src/mail/mail.spec.ts`(가짜 메일 서버가 받은 것) |
| FR-1901 | **형식** — `WF_MAIL_FORMAT`이 `text`면 평문, `markdown`이면 마크다운 본문. 마크다운에서는 문서 제목·부른 사람의 이름에 든 마크다운 글자를 이스케이프하고, 바로 가기는 "문서 열기"라는 글의 링크다. 제목(`subject`)은 둘 다 평문 | A등급 `apps/api/src/mail/domain/compose.spec.ts` |
| FR-1902 | **인증** — `WF_MAIL_AUTH_HEADER`와 `WF_MAIL_AUTH_VALUE`가 둘 다 있으면 그 헤더를 싣는다(예: `Authorization: Bearer …`, `X-API-Key: …`). 하나만 있으면 기동 실패, 쓸 수 없는 머리말 이름·ASCII 밖의 값도(A.1-13). 값은 로그·창·감사에 나가지 않고, 응답이 그 값을(토큰만·JSON 이스케이프로도) 되읊으면 가린다 | A등급(`packages/shared/src/env.spec.ts`·`request.spec.ts`) · 통합 |
| FR-1903 | **성공 판정** — HTTP 2xx만 성공. 넘겨주기를 따르지 않는다. 10초 시간 제한. 실패는 앱 로그에 상태만(`mail.rejected`)·연결 실패(`mail.failed`) — 응답 본문은 싣지 않는다(P6 그대로). 실패해도 앱 동작을 막지 않는다(FR-753 그대로) | 통합(가짜 서버의 200·400·500·302·응답 없음) |
| FR-1904 | **기동할 때 설정을 본다** — 주소는 `http(s)`이고 사용자 정보·질의·조각이 없다. 헤더 이름은 HTTP 토큰 글자, 값에 줄바꿈이 없다. 켰는데(모의 아님) 주소가 비면 기동 실패. **운영(`production`)에서 켰는데 모의면 기동 실패** — 메일이 나간다고 믿는데 로그로만 남는 것은 조용히 잘못되는 유형이다(OIDC 모의와 같은 판단) | A등급 `packages/shared/src/mail.spec.ts`·`packages/shared/src/env.spec.ts` |
| FR-1905 | **시험 명령** — 개발 `pnpm mail:test <받는 주소>`, 운영 `docker compose -f compose.yml --env-file .env run --rm tools node dist/cli/mail-test.js <받는 주소>`. 설정(주소·형식·보내는 이름·인증 헤더 이름 — 값은 가림)과 앱이 지금 메일을 보내는지를 말하고, 시험 메일 한 통을 보내 결과와 까닭(상태 코드마다 무엇을 볼지)을 말한다. 성공 0, 실패 1로 끝난다. 감사에 남긴다(A.1-10) | 통합 `apps/api/src/cli/mail-test.integration.spec.ts`(가짜 서버 · 시험 DB) |
| FR-1906 | **현장 절차** — 설치및실행가이드에 "사내 메일 연결하기" 절(사내 LLM 연결하기와 같은 모양 — 준비할 것·순서·이렇게 되면). 장애대응가이드의 메일 절, 운영이관, 학습가이드 | `pnpm verify:docs` · 가이드의 명령을 이 서버의 컨테이너에서 가짜 메일 서버로 적힌 그대로 친다 |
| NFR-180 | 새 의존성 0, 표 변경 0, 화면 변경 0. compose의 `tools`가 메일 설정과 사내 CA(`ca/ca.pem`)를 받는다(시험 명령이 https 사내 API에 닿게) | `pnpm check` · 컨테이너 |

## C. 보내는 요청 (사내 메일 API — 사용자가 준 모양)

```
POST {WF_MAIL_API_URL}                       예: https://mail.example.internal/api/v1/email/send (형식이 markdown이면 …/send_markdown)
content-type: application/json; charset=utf-8
{WF_MAIL_AUTH_HEADER}: {WF_MAIL_AUTH_VALUE}  둘 다 있을 때만
{"subject": "[위키] 홍길동 님이 회원님을 불렀습니다", "content": "…", "receivers": "user@example.internal", "sender_name": "위키"}
```

- 응답: 200이면 보냈다(`{"message": "Email sent successfully"}` — 본문은 판정에 쓰지 않는다). 400 필수 값 누락, 500 메일 발송 오류(사내 API 설명).
- 멘션 메일의 내용은 Phase 6 그대로다(FR-755 — 문서 본문을 넣지 않는다, 누가·어디서·문서 제목·링크). 부른 사람을 모르면 이름을 적지 않는다(P8).

## D. 모듈과 등급

| 모듈 | 등급 | 시험 |
|---|---|---|
| `packages/shared/src/mail.ts` — 주소·헤더 이름·헤더 값 판정 | A | `packages/shared/src/mail.spec.ts` |
| `packages/shared/src/env.ts` — `WF_MAIL_*` 키와 기동 검사 | A | `packages/shared/src/env.spec.ts` |
| `apps/api/src/mail/domain/compose.ts` — 멘션·시험 메일의 제목·평문·마크다운, 마크다운 이스케이프 | A | `apps/api/src/mail/domain/compose.spec.ts` |
| `apps/api/src/mail/domain/request.ts` — 설정과 메시지로 요청(주소·헤더·본문) 만들기, 응답 글의 비밀 가리기 | A | `apps/api/src/mail/domain/request.spec.ts` |
| `packages/shared/src/markdown.ts` — 마크다운 안에 넣을 글자(`markdownText`)·링크 주소(`markdownLinkTarget`), 줄 끝 CR | A | `packages/shared/src/markdown.spec.ts` |
| `apps/api/src/mail/post.ts` — 보내는 길 한 곳(넘겨주기 안 따름·시간 제한·본문 상한) | B | 통합 `apps/api/src/mail/mail.spec.ts` |
| `apps/api/src/mail/http.sender.ts` · `mention-mail.service.ts` · `mock.sender.ts` | B | 통합 `apps/api/src/mail/mail.spec.ts`·`apps/api/src/mail/mention-mail.service.integration.spec.ts` |
| `apps/api/src/auth/auth.service.ts`(`freeEmail` — 사내 계정의 email 클레임은 email 모양일 때만, A.1-11) | B | 통합 `apps/api/src/auth/auth.integration.spec.ts` |
| `apps/api/src/cli/mail-test.ts`(이미지의 `dist/cli/mail-test.js`) · `scripts/mail-test.ts`(`pnpm mail:test`) | B | 통합 `apps/api/src/cli/mail-test.integration.spec.ts` |
| `deploy/compose.yml`(api·tools의 `WF_MAIL_*`, tools의 `ca`) · `.env.example` | 설정 | `.env.example` 키 대조 시험 · 컨테이너 |

## E. 설정 항목

| 키 | 기본 | 뜻 |
|---|---|---|
| `WF_MAIL_ENABLED` | `false` | 메일 발송 켜기·끄기 (P6 FR-757) |
| `WF_MAIL_MOCK` | `true` | 모의 발송 — 로그로만 남긴다 (P6 FR-752). **운영에서 켰으면 `false`여야 뜬다**(FR-1904) |
| `WF_MAIL_API_URL` | (없음) | 사내 메일 API의 **보내는 주소 전체** — 형식에 맞는 것(`…/send` · `…/send_markdown`). `http(s)`만, 사용자 정보·질의·조각 없이 |
| `WF_MAIL_FORMAT` | `text` | `text`(평문) · `markdown` |
| `WF_MAIL_SENDER_NAME` | `위키` | 받는 사람에게 보이는 보내는 이름(`sender_name`) |
| `WF_MAIL_AUTH_HEADER` | (없음) | 인증 헤더 이름 — 예 `Authorization`, `X-API-Key`. 비면 인증 없음 |
| `WF_MAIL_AUTH_VALUE` | (없음) | 그 헤더의 값 전체 — 예 `Bearer <토큰>`. **비밀 값** — `deploy/.env`에만 |
| `WF_PUBLIC_URL` | (없음) | 메일 링크의 주소 (P6 그대로) |

**없어진 키**: `WF_MAIL_FROM`·`WF_MAIL_API_TOKEN`(A.1-6).

## F. 보류 결정

- **보류 18(사내 메일 API 실연동)** — 트리거를 "개발 서버가 그 API에 나갈 수 있게 되는 날"에서 **"폐쇄망 반입 뒤 현장에서"**로 바꾼다(쟁점 2). 판정은 설치및실행가이드의
  "사내 메일 연결하기"를 순서대로 해 시험 명령이 0으로 끝나고 받는 사람에게 닿는지, 멘션 한 번이 메일로 닿는지다. 현장 기록을 받으면 닫는다. 형식이 다르면
  `apps/api/src/mail/domain/request.ts`를 고친다.

## G. 남는 것 · 하지 않는 것

- 하지 않는다: 관리 화면에서 메일 설정(A.1-1), 받는 사람 여럿을 한 통에(A.1-3), 필드 이름 설정(A.1-2), 비밀번호 재설정 메일(F-011 — 사용자가 정한다).
- 남는 것: 실제 사내 API로 한 통(보류 18 — 현장). 사내 API가 응답 본문으로 실패를 말하면서 200을 주는 경우는 성공으로 친다 — 설명서는 200을 성공이라 한다.
