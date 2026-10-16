# 검증기록 — 공개 API v1 (F-015)

- 일자: 2026-10-08 · 브랜치 `tanminkwan-rest-api` · 마지막 검증 커밋 `ccc3731` (4-1절은 2026-10-16 · `impl-phase21` · `87bc85b`)
- 설계: [`설계서_PublicApi.md`](설계서_PublicApi.md). 시행착오의 경위는 쓰지 않는다 (`CLAUDE.md` 4절).

## 1. 검사 (`pnpm check` — 종료 코드 0)

| 영역 | 파일 | 건수 | skip |
|---|---|---|---|
| shared | 17 | 766 | 0 |
| api (실제 PostgreSQL) | 96 | 1,498 | 0 |
| web | 49 | 450 | 0 |

- `pnpm verify:docs` 105개 문서, 위반 없음. `eslint`·`typecheck` 통과.
- 커버리지(`pnpm test:cov`, 자체 점검 시점): shared 라인 99.23% · 브랜치 96.75%, api 라인 95.25% · 브랜치 92.46%, web 92.17% · 84.56%(측정만). 새 모듈은 `markdown-parse.ts` 98.43/97.25, `v1.ts` 99.22/95.04, `v1-spec.ts` 100/92.85, `api-tokens/` 99.22/94.59, `v1/` 97.94/92.03 — A등급 90% 충족.
- 그 뒤 고친 `v1PageTreeQuery`(범위 밖 `limit`·모르는 칸 거절) 시험 3건을 shared에 더했다(763 → 766).

## 2. E2E (Playwright)

`e2e/api-tokens.spec.ts` 2건 통과(7.8초): 발급 → 토큰만으로(쿠키·CSRF 머리말 없이) 스페이스·마크다운 페이지 만들기·읽기 → 폐기 → 401, 관리자가 사용자 관리에서 남의 토큰 폐기 → 401.

## 3. 컨테이너 실호출 (`deploy/build.sh`로 빌드한 이미지, compose로 기동)

- 이미지: 이미지 라벨의 커밋 = HEAD(`c692c2e`). 크기 **382MB**(예산 400MB). 이미지 목록의 87MB는 압축 크기라 쓰지 않는다 — 안의 파일 시스템 278MB(`du`)·`docker images` 382MB.
- `GET /api/health` 200 · `GET /api/v1/openapi.json` 200 · 토큰 없이 `GET /api/v1/pages` 401 `TOKEN_MISSING`.
- 로그인 → `POST /api/tokens`(헤더 `{"alg":"HS256","typ":"JWT"}`, 클레임 `iss`·`aud`·`sub`·`iat`·`exp`·`scope`·`jti`) → 그 토큰으로 `GET /api/v1/spaces` 200, `POST /api/v1/spaces` 201, `POST /api/v1/pages`(마크다운) 만들기 → `GET /api/v1/pages/{id}` 본문이 마크다운 그대로, 스페이스 이름으로 목록 조회, `GET /api/v1/pages?space=x&limit=0` → 400 `INVALID_REQUEST`.

## 4. 검토

보안 검토(취약점 없음)·자체 점검 9건(Windows 러너 로그의 서명 키 마스킹, 문서·코드 불일치, `limit` 검증, 폐기 재시도 등 고침 — 나머지는 의도된 구조)·문서 정합성 33건(확실한 것 반영). 내용은 이 브랜치의 커밋 메시지에 있다.

## 4-1. 누가 만들었나 — 응답 칸과 거르기 (2026-10-16, F-023 · 설계서 FR-2226)

- **시험** — shared A 6건 더함(사람 칸 쿼리, `matchesAuthor`, `withAuthorship`, 스페이스·댓글 변환), api 통합 9건 더함(스페이스 만든 사람·든 사람·두 조건·404, 페이지 읽기·트리 거르기·limit 뒤 자르기·404, 검색 limit 전에 거르기, 댓글 `author`, 라벨의 페이지). 계약 시험이 옮기기 응답(`pages.move`)도 같은 모양임을 잡아 맞췄다. `pnpm check` 종료 코드 0 — api 1583건 통과, `api:spec --check` 같음, `verify:docs` 문서 109개 위반 없음. A등급 시험은 코드와 같은 커밋에 들어갔다(먼저 쓰지 않았다).
- **이미지·스택** — `deploy/build.sh`, `tiffanie-workfluence-app:latest` **383MB**, 라벨의 커밋 `87bc85b`. 마이그레이션 없음 — api만 다시 만들었고 3개 모두 healthy, `/api/health` 200. `openapi.sha256`이 `3f0a9480…`에서 `4283c9bf…`로 바뀌었고 저장소의 `openapi.yaml`과 같다.
- **8444에서 API로 실호출**(에이전트 계정 토큰, 읽기만) — `GET /spaces?createdBy=aiagent` 2개(셋 가운데 — 나머지 하나는 Crew로 든 남의 공간이고 `member=aiagent`에는 3개), 칸 `createdBy·createdByUsername·createdByName·createdAt`이 있고 기존 칸도 그대로다. `GET /pages?space=…` 항목·`GET /pages/{id}`에 만든 사람·고친 사람(id·아이디·이름)과 `createdAt`, `createdBy=aiagent`·`updatedBy=aiagent`로 거른 `total`. `GET /search?q=a4&createdBy=aiagent` 2건 모두 그 사람. 없는 아이디는 404 `USER_NOT_FOUND`. 댓글은 8444에 댓글이 있는 페이지가 없어 통합 시험으로만 봤다.

## 5. 확인하지 못한 것

- **편집 중 409(`PAGE_BEING_EDITED`)**: 실제 WebSocket 편집 연결과 겹친 시험이 없다. 가짜 방(대역)으로만 봤다.
- **빈도 제한 값**(`API_RATE_LIMITS`): 측정 전의 값이다.
- **폐쇄망 반입 묶음**: 이 기능을 넣은 묶음으로 `release:bundle`·반입 리허설을 하지 않았다.
- **세션을 끊는 통지의 토큰 폐기**: 커밋 뒤 비동기라 재시도 3번 뒤에도 실패하면 로그 한 줄(`session.revoke_failed`)만 남는다.
- 문서 정합성 지적 중 아키텍처 2절 구조 그림·4절 입구 서술, 체험판 점검표, `CLAUDE.md` 규칙 문장(감사 대상·CSRF 예외·문서 목록)은 고치지 않았다.
