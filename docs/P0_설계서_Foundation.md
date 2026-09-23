# P0_설계서_Foundation — Phase 0 공통 기반: 요구사항과 설계

- 상위 문서: [`docs/scope-definition.md`](scope-definition.md) 5절 Phase 인수 기준, [`docs/설계서_Architecture.md`](설계서_Architecture.md)
- 요청 기록: [`docs/prompts/prototype-v1.md`](prompts/prototype-v1.md) · [v2](prompts/prototype-v2.md) · [v3](prompts/prototype-v3.md) — 프로토타입으로 확인한 요구. 승격 규칙은 `CLAUDE.md` 1.5절
- 규칙: [`CLAUDE.md`](../CLAUDE.md) 4절 1단계 산출물. 다음 산출물은 코드 + 테스트, 그다음 [`docs/P0_검증기록_Foundation.md`](P0_검증기록_Foundation.md)
- 작성일: 2026-09-16 / 작성 LLM: Claude Opus 5

> **개정 이력 (2026-09-16).** 원래 요구사항정의서와 설계서 두 문서였다. 같은 열두 개 주제를 "무엇을"과 "어떻게"로 나눠 두 번 적었고, 그 결과 CI 관련 서술이 한쪽만 고쳐져 실제로 어긋났다. 한 사실은 한 곳에만 둔다는 규칙(`CLAUDE.md` 1.3절)에 따라 합쳤다. 판단 근거는 [`docs/internal/검토서_방법론개정.md`](internal/검토서_방법론개정.md).
>
> **절 번호 규칙.** 코드 주석과 트러블슈팅 기록이 이 문서의 **숫자 절**(0~13)을 가리킨다. 그래서 숫자 절은 건드리지 않고, 합쳐 들어온 요구사항과 제품 대조를 **문자 절**(A·B)로 앞에 붙였다.
>
> **개정 이력 (2026-09-17).** 작업 계획을 별도 문서로 만들지 않기로 하면서(`CLAUDE.md` 11절) 옛 Phase 0 작업 프롬프트에 있던 **착수 쟁점 4건을 A.0절로 옮겼다.** 그 문서의 나머지 여섯 개 절 중 다섯 개는 이 설계서와 같은 내용이었고, 프로토타입 승격 규칙은 `CLAUDE.md` 1.5절로 옮겼다.

## A. 요구사항

### A.0 착수 시 확정한 쟁점 (2026-09-16)

시작 전에 **사용자만 정할 수 있는 것**을 물어 확정한 내용이다 (`CLAUDE.md` 1.1절 1단계).

| # | 쟁점 | 확정 | 근거 |
|---|---|---|---|
| 1 | Linux 빌드 서버 접근 | **사용자가 직접 pull하고 빌드해 결과를 전달한다** | 폐쇄망 인접 서버의 접속 정보를 공개 저장소 작업 세션에 두지 않는다 |
| 2 | CI 실행 위치 | **GitHub이 제공하는 러너** | 공개 저장소라 무료. 이미지 빌드 자동화 시 자체 러너 검토 (`CLAUDE.md` 보류 5) |
| 3 | 프로토타입 DB 데이터 | **Phase 0에서 초기화하고 정식 시드로 다시 만든다** | E2E와 수동 확인이 남긴 합성 계정이 쌓여 있었다 |
| 4 | `main` 병합 시점 | **Phase 0 완료 후 PR 병합** | `CLAUDE.md` 12.1절 매 Phase PR |

### A.1 목적

Phase 1~6이 공유하는 기반을 확정한다.

각 Phase가 필요할 때마다 설정·상수·권한 판정·로거를 따로 만들면 서로 어긋난다. 화면이 자기 방식으로 권한을 판단하고 서버가 또 판단하면, 규칙 하나를 바꿀 때 두 곳을 고쳐야 하고 한 곳을 빠뜨리면 **버튼은 보이는데 누르면 403**이 된다. 공유되는 것을 먼저 확정해 이런 어긋남을 원천 차단한다.

또한 **폐쇄망 반입 경로를 맨 처음 뚫어 둔다.** 이미지 크기·의존성·네트워크 제약은 마지막에 드러나면 설계를 뒤집는다. 그래서 Phase 0의 완료 기준은 문서가 아니라 **Linux 서버에서 빌드한 이미지가 떠서 헬스체크에 응답하는 것**이다.

### A.2 배경과 제약

- **개발 PC에 Docker가 없다.** 컨테이너 빌드는 별도 Linux 서버에서 하고, 개발 명령은 OS 무관해야 한다.
- **운영은 인터넷이 없다.** 런타임에 외부 자원을 참조하면 화면이 깨지거나 기동이 지연된다.
- **저장소가 공개다.** 사내 정보·시크릿이 섞이면 이력에서 지워야 한다. 기계 검사를 CI에 둔다.
- **프로토타입이 있다** (`exp/prototype` 브랜치). 동작을 확인한 코드지만 근거 문서가 없다. 근거를 먼저 세우고 승격한다.

### A.3 범위

**In Scope**

| # | 항목 |
|---|---|
| 1 | pnpm 워크스페이스 모노레포 골격 (`apps/api`, `apps/web`, `packages/shared`) |
| 2 | `packages/shared` — 환경 스키마·상수·문서 계약·권한 판정·보안 유틸·API DTO + 테스트 |
| 3 | `apps/api` — 설정 로딩, DB 연결, 마이그레이션 실행, 시드, 공통 파이프·로거·요청 제한, `/api/health` |
| 4 | `apps/web` — SPA 껍데기 (기동 확인 화면). 기능 화면은 Phase 1부터 |
| 5 | `settings` 테이블과 첫 마이그레이션 |
| 6 | 개발 보조 스크립트 — `check:env`, `dev:db`, `verify:docs`, `e2e` |
| 7 | 검사 도구 — ESLint, `pnpm check`, GitHub Actions CI (gitleaks·라이선스·외부 URL 검사 포함) |
| 8 | 컨테이너·배포 파일 — 멀티스테이지 Dockerfile, compose, nginx 설정, `.dockerignore` |
| 9 | 에이전트·스킬 정의와 설계 근거 문서 |
| 10 | E2E 러너와 기동 확인 시나리오 1건 |

**Out of Scope** — 로그인·세션·CSRF·OIDC·가드·사용자·감사로그는 Phase 1, 스페이스·페이지·편집기는 Phase 2, 검색·첨부·댓글은 Phase 3, 관리 화면·권한 세분화·알림은 Phase 4, 배포·운영 문서와 부하·백업 리허설은 Phase 5다.

데이터 모델 **전체**는 `docs/설계서_Architecture.md` 3절에 그려 두되 마이그레이션은 각 Phase에서 추가한다. Phase 0은 `settings` 하나만 만든다.

### A.4 기능 요구사항

**모노레포·빌드 기반**

| # | 요구 | 왜 |
|---|---|---|
| FR-001 | pnpm 워크스페이스로 `apps/*`·`packages/*`를 구성하고 Node와 pnpm 버전을 `engines`·`packageManager`로 고정한다 | 개발 PC와 컨테이너의 런타임이 달라 생기는 "여기선 되는데 저기선 안 되는" 상황을 막는다 |
| FR-002 | pnpm 데이터(store·cache)는 저장소 안 `.local/` 아래에 둔다. 설정 위치는 `pnpm-workspace.yaml`이다 | 프로젝트와 같은 드라이브여야 하드링크가 동작한다. pnpm 12는 `.npmrc`의 pnpm 설정을 읽지 않는다(실측) |
| FR-003 | 줄바꿈을 LF로 고정한다 | Windows에서 쓴 셸 스크립트·Dockerfile이 Linux에서 깨지지 않게 |
| FR-004 | 네이티브 모듈의 설치 스크립트는 명시적으로 허용한 것만 실행한다 | 임의 패키지의 postinstall 실행을 막는다 |

**환경 설정** (`packages/shared/src/env.ts`, `apps/api/src/config`) — 설계는 1절

| # | 요구 | 왜 |
|---|---|---|
| FR-010 | 앱 환경변수는 모두 `WF_` 접두사를 쓴다 | 다른 도구의 환경변수와 섞이지 않는다 |
| FR-011 | 스키마는 strict다. `WF_`로 시작하는데 스키마에 없는 키가 있으면 **기동에 실패**한다 | 오타 난 키나 코드가 읽지 않는 키를 즉시 드러낸다. "설정에 값은 있는데 아무 일도 일어나지 않는" 실패가 가장 비싸다 |
| FR-012 | 타입·범위가 맞지 않으면 기동에 실패한다 | 포트에 문자열이 들어가는 일을 런타임 중간이 아니라 기동 시점에 잡는다 |
| FR-013 | 빈 문자열 값은 미설정으로 취급하고 기본값을 쓴다 | `.env`에 키만 남기고 값을 지운 경우를 자연스럽게 처리 |
| FR-014 | `WF_ENV=production`에서 `WF_DB_AUTO_MIGRATE=true`를 거부한다 | 설정 실수로 운영 DB가 기동과 함께 조용히 바뀌는 것을 막는다 |
| FR-015 | `.env.example`의 키 집합과 스키마의 키 집합이 같음을 테스트로 강제한다 | 키를 추가하고 예시 파일을 안 고치는 실수를 기계가 잡는다 |
| FR-016 | `.env.example`에는 placeholder만 둔다 | 공개 저장소 |
| FR-017 | 설정 로더는 `.env` 파일과 `process.env`를 함께 읽고 `process.env`를 우선한다 | 컨테이너는 환경변수 주입, 개발은 파일이 편하다 |

**공유 계약** (`packages/shared`) — 설계는 2절

| # | 요구 | 왜 |
|---|---|---|
| FR-020 | 역할 3종, 사용자 상태, 스페이스 종류·상태, Crew 역할, 감사 이벤트 종류, 문서 스키마 버전, 페이지 트리 최대 깊이, CSRF 헤더, 비밀번호 정책 기본값, 요청 제한 기본값을 단일 정의한다 | 화면 문구와 서버 판정이 같은 목록을 봐야 한다 |
| FR-021 | 문서(ProseMirror JSON) 검증기를 제공한다. 허용 노드·마크·속성 목록 밖은 거부하고 위반 위치를 알려준다 | 차단 목록 방식은 새 위험이 생길 때마다 뚫린다 |
| FR-022 | 문서에서 검색용 평문을 추출한다 | 서버가 추출하므로 클라이언트가 보낸 텍스트를 믿지 않는다 |
| FR-023 | 권한 판정 함수를 제공한다. 기본 거부이며 알 수 없는 역할은 아무 권한도 없다 | 화면의 버튼 노출과 서버의 403이 같은 규칙이어야 한다 |
| FR-024 | 비밀번호 정책 판정 함수는 위반 사유를 **목록으로** 돌려준다 | 화면이 "무엇이 부족한지"를 보여줄 수 있어야 한다 |
| FR-025 | 보안 유틸(ID·email 마스킹, 임시 비밀번호 생성, 스페이스 식별자 생성)은 **난수 소스를 인자로 받는다** | 서버는 암호학적 난수를, 테스트는 결정적 수열을 넣는다 |
| FR-026 | 임시 비밀번호는 정책을 항상 만족하고 혼동 문자(0/O, 1/l/I)를 쓰지 않는다 | 화면에서 읽어 옮겨 적는 값이다 |
| FR-027 | API 요청 DTO와 응답 뷰 타입을 정의한다 | 서버 검증과 클라이언트 타입이 한 정의에서 나온다 |

**DB** (`apps/api/src/db`) — 설계는 3절

| # | 요구 | 왜 |
|---|---|---|
| FR-030 | 연결 풀을 제공하고 종료 시 정리한다. `WF_ENV=test`면 테스트 DB를 쓴다 | 통합 테스트가 개발 데이터를 지우지 않게 |
| FR-031 | 마이그레이션은 SQL 파일로 커밋하고 순서대로 적용한다. 이미 적용된 것은 건너뛴다 | 멱등 |
| FR-032 | 마이그레이션 적용은 별도 실행 가능해야 한다 | 운영 배포 절차가 기동과 분리된 단계로 실행한다 |
| FR-033 | `settings` 테이블을 만든다 | 운영 조절값의 저장 위치 |
| FR-034 | 시드는 멱등이다. Phase 0은 틀만 둔다 | 계정 시드는 Phase 1 |

**헬스체크·로깅·공통 요청 처리** — 설계는 4·5·6절

| # | 요구 | 왜 |
|---|---|---|
| FR-040 | `GET /api/health`는 **DB 질의까지 수행**하고 성공 시 `{status, db, time}`을 반환한다 | 앱은 떴는데 DB를 못 쓰는 상태를 "정상"으로 보고하지 않는다 |
| FR-041 | DB 연결 실패 시 503을 반환한다 | 컨테이너 헬스체크가 실패로 인식해야 한다 |
| FR-050 | 로그는 stdout에 JSON 한 줄로 출력한다. 파일에 직접 쓰지 않는다 | 컨테이너 표준. 수집기가 가져간다 |
| FR-051 | 비밀번호·토큰·세션 ID·쿠키를 로그에 남기지 않는다 | |
| FR-052 | 프레임워크 로그도 같은 형식으로 나간다 | 기동 로그만 형식이 달라 파싱이 깨지는 일을 막는다 |
| FR-060 | 요청 본문·쿼리는 zod 파이프를 통과한다. 실패는 400과 위반 항목 목록 | 어느 필드가 왜 틀렸는지 화면이 보여줄 수 있어야 한다 |
| FR-061 | 공개 엔드포인트용 IP별 요청 제한 가드를 제공한다 | 단일 인스턴스 전제. 이중화 시 공유 저장소로 옮긴다 |
| FR-062 | 보안 응답 헤더를 전역으로 붙인다 | CSP·nosniff·Referrer-Policy·frame-ancestors·HSTS |
| FR-063 | `/api/*` 응답은 `no-store`. 해시 파일명 정적 자산만 `immutable` | |
| FR-064 | 신뢰 프록시 설정을 둔다 | `X-Forwarded-Proto`가 반영되지 않으면 리다이렉트·쿠키 보안 판정이 깨진다 |

**웹 셸** (`apps/web`) — 설계는 7절

| # | 요구 | 왜 |
|---|---|---|
| FR-070 | SPA를 빌드하고 api가 정적 서빙한다. 딥링크는 `index.html`로 폴백하되 `/api/*`는 제외 | 배포물을 한 프로세스로 |
| FR-071 | Phase 0의 화면은 기동 확인 화면 하나다. `/api/health` 결과와 버전을 보여준다 | 브라우저에서 확인 가능한 증분 |
| FR-072 | 외부 폰트·아이콘·스크립트를 참조하지 않는다 | 폐쇄망 |

**스크립트·검사·CI** — 설계는 8·9절

| # | 요구 | 왜 |
|---|---|---|
| FR-080 | `pnpm check:env`는 Node·pnpm 버전, `.env`, 데이터 경로, 드라이브 여유, DB 연결, 마이그레이션 상태를 검사하고 전부 통과하면 `READY`를 출력한다 | 서비스가 내려간 상태의 오진을 막는다 |
| FR-081 | `pnpm dev:db`는 임베디드 PostgreSQL을 `.local/pgdata`에서 기동한다. 최초 실행 시 초기화와 DB 생성까지 한다 | 관리자 설치 없이, 데이터는 프로젝트 안에 |
| FR-082 | `pnpm verify:docs`는 문서의 명령·경로·링크를 기계 검사한다. 항목은 pnpm 스크립트 실재, **백틱 경로가 저장소에 커밋돼 있는지**, 마크다운 링크, 표 열 수, `deploy/*.sh` 실행 비트, 코드블록 안 pnpm 명령이다 | 사람이 매번 대조하는 것은 신뢰할 수 없다 |
| FR-083 | `pnpm test:e2e`는 Playwright를 저장소 안 브라우저 경로로 실행한다 | OS별 환경변수 문법을 문서에 노출하지 않는다 |
| FR-084 | `pnpm check`는 lint + typecheck + test + verify:docs를 한 번에 돌린다. 개발 PC가 CI와 **같은 검사**를 해야 한다. CI는 같은 검사를 단계로 나눠 돌린다 (FR-091) | "로컬은 통과했는데 CI가 실패"를 줄인다 |
| FR-090 | ESLint로 import 경로 대소문자 불일치를 잡는다 | Linux 빌드에서만 실패하는 유형이다 |
| FR-091 | CI는 push·PR마다 `pnpm check`와 같은 검사를 돌린다. CI에서는 **관문마다 별도 단계**로 나눈다 | 어느 관문이 걸렸는지 로그를 뒤지지 않고 알기 위해서다 |
| FR-092 | CI에 gitleaks를 넣는다 | 공개 저장소에 시크릿이 들어가는 것을 막는다 |
| FR-093 | CI에서 의존성 라이선스를 검사한다 | 허용은 MIT·Apache-2.0·BSD·ISC·0BSD |
| FR-094 | CI에서 빌드 산출물의 외부 URL 참조를 검사한다 | 폐쇄망에서 깨지는 자산을 반입 전에 잡는다 |

**컨테이너·배포·에이전트** — 설계는 10·11절

| # | 요구 | 왜 |
|---|---|---|
| FR-100 | 멀티스테이지 Dockerfile로 app 이미지를 만든다. 런타임 스테이지에는 산출물과 production 의존성만 | 이미지 크기·공격 표면 |
| FR-101 | 컨테이너는 non-root로 실행하고 헬스체크를 포함한다 | |
| FR-102 | compose에 app·postgres·nginx를 정의하고 전부 `restart: unless-stopped`를 둔다 | 재부팅 후 자동 기동이 안 되면 "서비스가 내려간 것을 코드 문제로 오진"한다 |
| FR-103 | nginx는 TLS를 종단하고 `X-Forwarded-*`를 전달한다. WebSocket 업그레이드를 프록시한다 | Phase 6 대비. 업로드 상한은 첨부 상한과 맞춘다 |
| FR-104 | `.dockerignore`로 `node_modules`·`.env`·`.local`·`docs`·`e2e`를 제외한다 | 빌드 컨텍스트 축소 |
| FR-110 | `doc-consistency`·`self-reviewer` 에이전트와 `troubleshoot` 스킬을 정의한다 | 13절 |
| FR-111 | 설계 근거·모델 배정·실행 기록을 `docs/internal/설계서_Agents.md`에 남긴다 | 정의 파일은 "무엇을 하라"만 담는다. **왜 맡기는지**가 저장소 안에 없으면 다음 담당자가 알 수 없다 |

### A.5 비기능 요구사항

| # | 항목 | 기준 |
|---|---|---|
| NFR-01 | A등급 커버리지 | `packages/shared` 라인·브랜치 **≥ 90%** |
| NFR-02 | 테스트 신뢰 | skip 0건. skip이 있으면 검증기록에 건수와 사유 |
| NFR-03 | 이미지 크기 | app 이미지 **≤ 400MB** (실측 기록) |
| NFR-04 | 기동 시간 | compose 기동 후 **30초 이내** 헬스체크 통과 |
| NFR-05 | 외부 의존 | 빌드 산출물의 외부 URL 참조 **0건** |
| NFR-06 | 이식성 | Windows·Linux 양쪽에서 같은 `pnpm` 명령이 동작 |
| NFR-07 | 재현성 | `pnpm install --frozen-lockfile`로 같은 의존성 트리 |
| NFR-08 | 문서 정합 | `pnpm verify:docs` 위반 0건 |
| NFR-09 | 보안 | gitleaks·라이선스 검사 통과. `.env` 미커밋 |
| NFR-10 | 추적성 | 이 문서 1.1절 설정 항목 표에 없는 `WF_*`가 코드에 0개 |

### A.6 완료 기준

- [ ] 3단계 산출물이 순서대로 커밋에 남는다 (설계서 → 코드+테스트 → 검증기록)
- [ ] `pnpm check` 통과
- [ ] `packages/shared` 커버리지 실측 ≥ 90%, skip 0건
- [ ] `.env.example` 키 집합 == 스키마 키 집합 (테스트가 강제)
- [ ] 1.1절 설정 항목 표에 없는 `WF_*` 0개 (대조 기록)
- [ ] `pnpm check:env`가 `READY`
- [ ] E2E 기동 확인 시나리오 통과
- [ ] CI가 push마다 동작하고 gitleaks·라이선스·외부 URL 검사를 포함
- [ ] **Linux 서버에서 pull → 빌드 → compose 기동 → `/api/health` 200** (응답 원문·일자·Docker 버전·디스크 여유·이미지 크기 기록)
- [ ] 재부팅 후 자동 기동 확인
- [ ] 에이전트 정의 2개 + 스킬 1개 + `docs/internal/설계서_Agents.md`
- [ ] `docs/internal/P0_검토서_SelfReview.md`

### A.7 리스크

| # | 리스크 | 대응 |
|---|---|---|
| 1 | 프로토타입 코드를 근거 없이 옮겨 문서와 코드가 따로 논다 | 모듈별로 "왜 이 형태인가"를 이 문서에 쓰고, 쓸 수 없으면 가져오지 않는다 |
| 2 | Phase 0이 비대해져 기반이 아닌 기능까지 들어온다 | A.3절 Out of Scope를 관문으로 |
| 3 | Linux 빌드가 개발 PC와 달라 늦게 실패한다 | 완료 기준에 넣어 Phase 0 안에서 확인한다. 실패하면 Phase 0을 닫지 않는다 |
| 4 | `shared`가 전 Phase DTO를 담아 Phase 진행 중 자주 바뀐다 | 바뀌는 것은 정상이다. **호출자가 붙는 Phase에서 계약을 확정하고 커버리지를 다시 측정한다** (`CLAUDE.md` 보류 10) |
| 5 | CI 도구가 오탐으로 관문을 무력화한다 | 예외는 파일로 관리하고 사유를 주석에 남긴다. 무시되는 관문은 없는 것보다 나쁘다 |

## B. 제품 기준 대조 (Confluence)

Phase 0은 사용자에게 보이는 기능이 없다. 그래서 기능 대조가 아니라 **기반 수준의 선택**을 견준다. 목적은 따라 하기가 아니라 **다른 선택을 했다면 그 대가를 알고 있는가**를 확인하는 것이다.

| 항목 | Confluence (Data Center 기준) | workfluence | 판정 | 이유 |
|---|---|---|---|---|
| 런타임 | JVM, 자체 설치 프로그램 | Node.js 단일 프로세스, 컨테이너 | 변형 | 반입 묶음을 이미지 tar로 단순화한다. 설치 마법사가 폐쇄망 반입 절차를 늘린다 |
| 데이터베이스 | PostgreSQL·Oracle·MySQL·SQL Server | PostgreSQL 고정 | 제외 | 여러 DB를 지원하면 SQL·인덱스·전문검색이 최소공배수로 수렴한다. 우리는 JSONB·trigram을 쓴다 |
| 스키마 관리 | 기동 시 자동 업그레이드 | SQL 커밋 + **명시적 실행** | 변형 | 폐쇄망에서 기동과 함께 스키마가 바뀌면 되돌릴 방법이 없다 |
| 설정 | 설정 파일 + 관리 화면 + 시스템 속성 | `.env` / 상수 / DB `settings` **3분류** | 변형 | 성격으로 위치를 정해 "어디를 고쳐야 하나"를 규칙화했다 |
| 미지의 설정 키 | 무시 | **기동 실패** | 변형 | 오타·미배선 키가 조용히 아무 일도 하지 않는 것이 가장 비싼 실패다 |
| 헬스체크 | 앱 상태 위주 | **DB 질의까지 수행** | 채택하고 강화 | 앱만 살아 있는 상태를 정상으로 보고하면 컨테이너 재시작이 동작하지 않는다 |
| 로그 | 파일 기반, 회전 정책 설정 | **stdout JSON 한 줄** | 변형 | 컨테이너 표준. 앱이 파일 회전·권한을 신경 쓰지 않는다 |
| 감사로그 | 앱 기능으로 제공 | 앱 기능 + **DB 권한·트리거로 수정 차단** | 채택하고 강화 | 금융 감사에서는 앱을 통하지 않은 변경도 막아야 증적이 된다 |
| 플러그인 | 마켓플레이스·런타임 설치 | **없음** | 제외 | 런타임 코드 설치는 반입 통제를 우회하는 경로가 된다 |
| 프론트엔드 | 서버 렌더 + 부분 SPA | SPA를 api가 함께 서빙 | 변형 | 배포물을 한 프로세스로 줄여 기동·헬스체크를 단순화 |
| 클러스터링 | 다중 노드 | 단일 노드, 세션은 DB | 제외하고 연기 | 300명 규모에 동기화 비용을 먼저 지불할 이유가 없다. 세션만 미리 DB에 두어 확장 경로를 막지 않았다 |
| 전문 검색 | Lucene 색인 | PostgreSQL 내장 (Phase 3) | 변형하고 보류 | 반입 표면을 늘리지 않는다. 한글 2글자 질의 실측 후 판단 (`CLAUDE.md` 보류 2) |

**우리가 포기한 것과 그 대가.** 다중 DB 지원을 버려 이식 비용을 감수한다. 자체 운영 시스템이라 DB는 우리가 정한다. 플러그인 생태계를 버려 확장을 직접 만든다. 폐쇄망에서 외부 코드 반입은 어차피 통제 대상이다. 성숙한 전문 검색을 버려 한글 검색 품질을 직접 검증한다. Phase 3에서 실측하고 미달이면 대안을 반입한다. 다중 노드를 버려 단일 장애점을 안는다. Phase 5 부하 실측 후 판단하고, 세션은 이미 공유 가능하다.

**Phase 1 대조 예고.** 계정·권한 모델을 대조한다. 사용자 상태, 그룹과 권한의 관계, SSO 연동 방식, 감사 이벤트 목록이다. 그 결과는 `P1_설계서_Auth`의 같은 절에 쓴다.

## 0. 모듈 구성과 등급

```
packages/shared/src/
├── env.ts            [A] WF_* 스키마·파싱                     ← zod만 import
├── constants.ts      [A] 설계 고정값                          ← 없음
├── security.ts       [A] 마스킹·임시 비밀번호·식별자 생성      ← constants, permissions
├── permissions.ts    [A] 권한 판정·비밀번호 정책 판정          ← constants
├── document.ts       [A] 문서 JSON 검증·텍스트 추출            ← 없음
└── schemas.ts        [A] API DTO·응답 뷰 타입                 ← constants, document, permissions

apps/api/src/
├── config/config.module.ts   [B] .env 로딩 → APP_ENV 제공
├── db/db.module.ts           [B] 풀·Drizzle 인스턴스
├── db/schema.ts              [B] 테이블 정의 (P0: settings)
├── db/migrate.ts             [B] 마이그레이션 실행 (CLI 겸용)
├── db/seed.ts                [B] 멱등 시드 (P0: 틀만)
├── common/zod.pipe.ts        [B] 요청 검증
├── common/logger.ts          [B] pino JSON stdout
├── common/rate-limit.guard.ts[B] IP별 요청 제한
├── health/health.controller.ts [B] /api/health
├── app.module.ts             [B] 모듈 조립 + SPA 정적 서빙
└── main.ts                   [B] 부트스트랩·보안 헤더

apps/web/src/                 [B] SPA 셸 (기동 확인 화면)
scripts/                      [—] setup-env · check-env · dev-db · verify-docs · check-licenses · e2e
e2e/                          [C] 기동 확인 시나리오
```

등급은 `CLAUDE.md` 3절. A는 테스트 먼저, ≥90%. `[—]`는 개발 보조 스크립트로 커버리지 측정 대상이 아니며 **실행 자체가 검증**이다.

### 0.1 의존 방향 규칙

- `shared`는 zod 외에 아무것도 import하지 않는다. Node 전용 API(`fs`·`crypto`)를 쓰지 않는다 — 브라우저 번들에 들어간다.
  - 예외: `env.spec.ts`는 `.env.example`을 읽으므로 `node:fs`를 쓴다. **테스트 파일은 번들되지 않는다.**
- api 기능 모듈끼리 순환 import를 만들지 않는다. 두 모듈이 함께 쓰는 변환 함수는 제3의 파일로 뺀다 (`설계서_Architecture.md` 2.1절).

## 1. 환경 설정 (FR-010 ~ FR-017)

### 1.1 설정 항목 표 — Phase 0 전량

**이 표에 없는 `WF_*`는 코드에 존재할 수 없다** (NFR-10). Phase 1 이후 키가 늘면 그 Phase 설계서에 표를 추가한다.

| 키 | 타입 | 기본값 | 용도 |
|---|---|---|---|
| `WF_ENV` | `development`\|`test`\|`production` | `development` | 실행 환경. 운영 제약 판정에 쓴다 |
| `WF_PORT` | 정수 1~65535 | `3000` | HTTP 수신 포트 |
| `WF_LOG_LEVEL` | pino 레벨 | `info` | 로그 수준 |
| `WF_DATABASE_URL` | URL | (필수) | PostgreSQL 연결 문자열 |
| `WF_DATABASE_URL_TEST` | URL | (선택) | 테스트 DB. `WF_ENV=test`에서 사용 |
| `WF_DB_AUTO_MIGRATE` | `true`\|`false` | `false` | 기동 시 마이그레이션 자동 적용. **운영에서 `true`면 기동 실패** |
| `WF_PG_EMBEDDED_DIR` | 경로 | `.local/pgdata` | 개발용 임베디드 PostgreSQL 데이터 |
| `WF_PG_EMBEDDED_PORT` | 정수 1024~65535 | `5433` | 임베디드 PostgreSQL 포트. 기본 설치본(5432)과 겹치지 않게 |
| `WF_PG_EMBEDDED_PASSWORD` | 문자열 | `workfluence` | 개발 전용. 운영 컨테이너에는 넘기지 않는다 |
| `WF_TRUST_PROXY` | `true`\|`false` | `false` | nginx 뒤에서 `X-Forwarded-*` 신뢰 |
| `WF_SERVE_WEB` | `true`\|`false` | `false` | api가 빌드된 SPA를 함께 서빙 |
| `WF_WEB_DIST` | 경로 | `../web/dist` | SPA 산출물 경로 (api 기준 상대) |

**Phase 1에서 추가 예정**: `WF_SESSION_SECRET`, `WF_COOKIE_SECURE`, `WF_SESSION_IDLE_MINUTES`, `WF_SESSION_ABSOLUTE_HOURS`, `WF_ROOT_USERNAME`, `WF_ROOT_INITIAL_PASSWORD`, `WF_ROOT_EMAIL`, `WF_OIDC_*`.

#### compose 전용 변수 (앱 스키마가 아니다)

아래는 **docker compose 파일이 읽는 값**이고 앱에는 전달되지 않는다. 앱 환경 스키마에 넣으면 "코드가 읽지 않는 키"가 되므로 분리해 둔다.

| 키 | 용도 |
|---|---|
| `WF_PG_PASSWORD` | postgres 컨테이너 비밀번호. compose가 `WF_DATABASE_URL` 조립에도 쓴다 |
| `WF_APP_IMAGE` | 기동할 app 이미지 태그 |
| `WF_HTTPS_PORT` | nginx가 노출할 호스트 포트 |

테스트 러너 전용 변수는 `WF_` 접두사를 쓰지 않는다 (`E2E_BASE_URL`). **`WF_`는 앱 환경변수만**을 뜻한다.

> **왜 Phase 1 키를 미리 넣지 않는가.** 스키마가 strict라 선언만 하고 코드가 읽지 않는 키는 "값을 바꿔도 아무 일이 없는" 상태가 된다. 그것이 바로 strict로 잡으려던 실패 유형이다. 반면 `schemas.ts`의 미사용 DTO는 **자기 테스트로 동작이 검증되는 타입 계약**이라 성격이 다르다.

### 1.2 파싱 설계

```
process.env + .env 파일 ──▶ WF_로 시작하는 키만 추출 ──▶ zod strict 파싱 ──▶ AppEnv
                                                            │
                                                 실패 시 EnvValidationError (기동 중단)
```

- **빈 문자열은 제외**한다(FR-013). `.env`에 `WF_PORT=`처럼 값을 비운 경우 기본값을 쓴다.
- `.strict()`로 미지의 `WF_` 키를 거부한다(FR-011).
- 파싱 후 **교차 검증**: `WF_ENV=production` && `WF_DB_AUTO_MIGRATE=true` → 거부(FR-014).
- `ENV_KEYS`를 export해 `.env.example` 대조 테스트가 쓴다(FR-015).

> **zod 4 주의**: `.default()`는 입력 문자열이 아니라 **출력 타입** 값을 받고, 값이 없으면 파싱을 건너뛴다. 따라서 `intString(min, max, 기본값:number)`처럼 변환 뒤 기본값을 붙인다. `z.email()`은 검증만 하므로 정규화(`trim`·`toLowerCase`)를 앞에 두고 `.pipe()`로 잇는다.

### 1.3 로딩 위치

`ConfigModule`이 저장소 루트의 `.env`를 찾아 읽고 `process.env`를 덮어쓴다(`process.env` 우선, FR-017). 컨테이너는 compose가 환경변수를 주입한다.

`app.module.ts`는 SPA 서빙 여부를 모듈 구성 시점에 알아야 해서 같은 로더를 한 번 더 호출한다. 두 번 읽어도 결과가 같다(순수 함수).

## 2. 공유 계약 (FR-020 ~ FR-027)

### 2.1 `constants.ts`

값 배치 기준은 `CLAUDE.md` 5절이다. 여기 두는 것은 **바꾸면 데이터·마이그레이션을 다시 만들어야 하는 값**이다.

| 상수 | 내용 | 왜 여기인가 |
|---|---|---|
| `ROLES` | `root`·`admin`·`member` | DB `role` 컬럼 값. 바꾸면 데이터 이행 필요 |
| `USER_STATUSES` | `pending`·`active` | 같음. `잠김`은 저장하지 않고 파생 |
| `SPACE_KINDS` / `SPACE_STATUSES` | `personal`·`team` / `active`·`suspended` | 같음 |
| `SPACE_MEMBER_ROLES` | `owner`·`editor`·`viewer` | 같음 |
| `AUDIT_ACTIONS` | 감사 이벤트 종류 | 기록된 값이라 이름을 바꾸면 과거 로그와 어긋난다 |
| `DOCUMENT_SCHEMA_VERSION` | 문서 스키마 버전 | 저장된 문서에 박힌다 |
| `PAGE_TREE_MAX_DEPTH` | 트리 최대 깊이 | 경로 계산 비용 상한 |
| `CSRF_HEADER` / `_VALUE` | 상태 변경 요청에 요구하는 헤더 | 서버·클라이언트가 같아야 한다 |
| `PASSWORD_POLICY` | 8자·2종·5회·15분 | **기본값**. 운영 조절은 Phase 4에서 `settings`로 |
| `RATE_LIMITS` | 엔드포인트별 제한 | 기본값 |
| `TEMP_PASSWORD_LENGTH` | 12 | 기본값 |
| `ASSIGNABLE_MEMBER_ROLES` | `editor`·`viewer` | owner는 생성자에게 자동 부여라 지정 대상이 아니다 |
| `SETTINGS_KEYS` | `settings` 테이블 키 | 키 문자열이 코드 여러 곳에 흩어지면 오타가 조용히 통과한다 |

### 2.2 `document.ts` (FR-021, FR-022)

- **허용 목록 방식**: `ALLOWED_NODES`(노드 → 허용 속성 키), `ALLOWED_MARKS`. 목록 밖이면 거부. 차단 목록 방식은 새 위험이 생길 때마다 뚫린다.
- 속성 값은 원시값 또는 원시값 배열만 허용한다. 중첩 객체를 허용하면 검증 표면이 무한해진다.
- 링크는 `ALLOWED_LINK_HREF = /^(https?:\/\/|\/(?!\/)|#)/i`. `//evil.example`(프로토콜 상대)을 막기 위해 `/` 뒤에 `/`가 오는 것을 제외한다.
- 상한: 노드 50,000개·깊이 64. 오류는 20건에서 멈춘다 — 전부 모으면 응답이 비대해진다.
- `extractText()`는 블록 경계에 줄바꿈을 넣고 인라인은 이어 붙인다. 연속 3줄 이상 줄바꿈은 2줄로 줄인다.

### 2.3 `permissions.ts` (FR-023, FR-024)

```
can(principal, action)                                   → boolean   시스템 행위
spaceAccess(principal, space, membership, memberCount)   → SpaceAccess
canAssignRole(actor, role) / canManageUser(actor, target) → boolean   역할 간 우열
checkPasswordPolicy(password, policy)                    → string[]  위반 사유 목록
```

- `GRANTS`는 역할 → 허용 행위 집합. **없는 조합은 전부 거부**. 알 수 없는 역할도 거부한다.
- `spaceAccess`는 **읽기·쓰기·구성원 관리·상태 변경·삭제**를 한 번에 판정해 돌려준다. 호출부가 개별 규칙을 다시 조합하지 않게 한다.
- 삭제 규칙: 생성자는 `memberCount < 2`일 때만, 관리자는 `status !== 'active'`일 때만. 중지가 예고 단계 역할을 한다.
- 중지 상태는 **누구도 쓰기 불가**. 관리자도 예외가 아니다 — "얼렸다"가 관리자에게만 녹으면 상태의 의미가 흐려진다.

### 2.4 `security.ts` (FR-025, FR-026)

- 난수 소스를 `RandomInt = (maxExclusive: number) => number`로 주입받는다. 서버는 `node:crypto.randomInt`, 테스트는 결정적 수열.
- 임시 비밀번호: 4종(소문자·대문자·숫자·특수)을 각 1자 이상 보장한 뒤 Fisher–Yates로 섞는다. 섞지 않으면 앞 4자리 종류 순서가 항상 같아 예측 가능해진다. 생성 후 정책을 다시 검사해 **계약 위반이면 예외**를 던진다.
- 혼동 문자(`0 O 1 l I i o`)를 제외한다. 화면에서 읽어 옮겨 적는 값이다.
- `maskUsername`: 앞 2자 + (길이 5 이상이면) 뒤 1자만 남긴다.

### 2.5 `schemas.ts` (FR-027)

- 요청 DTO는 zod, 응답은 타입만. 응답을 런타임 검증하지 않는 이유는 서버가 만든 값이고 검증 비용이 이득보다 크기 때문이다.
- `documentSchema`는 `z.unknown().superRefine(...)`로 `document.ts` 검증기를 감싼다. `z.custom`은 오류 메시지 조립이 어렵다.
- DTO에 기본값이 필요하면 `.default()`를, 부분 수정 DTO는 `.partial()` 대신 **명시적으로 optional 필드를 나열**한다. zod 4의 `.partial()`은 default를 유지해 "보내지 않은 필드가 빈 값으로 덮이는" 사고를 낸다.

## 3. DB (FR-030 ~ FR-034)

### 3.1 연결

`PG_POOL`(pg `Pool`) → `DB`(Drizzle 인스턴스) 두 토큰을 제공한다. 세션 저장소(Phase 1)가 같은 풀을 써야 해서 풀을 따로 노출한다. `OnModuleDestroy`에서 풀을 닫는다.

연결 문자열 선택은 `config.module.ts`의 `databaseUrl(env)` **한 함수**가 한다. 앱·마이그레이션·시드·스키마 생성이 모두 이 함수를 쓴다 — 경로마다 따로 고르면 스키마를 만든 DB와 앱이 붙는 DB가 갈린다.

`WF_ENV=test`면 `WF_DATABASE_URL_TEST`를 쓰고, **그 값이 없으면 개발 DB로 대체하지 않고 실패한다.** 통합 테스트가 개발 데이터를 지우는 사고를 막는다.

### 3.2 스키마 — Phase 0

| 테이블 | 컬럼 | 비고 |
|---|---|---|
| `settings` | `key` text PK, `value` jsonb NOT NULL, `updated_by` uuid, `updated_at` timestamptz | 운영 조절값. `updated_by`는 Phase 1에서 `users`를 참조하도록 제약을 추가한다 |

나머지 테이블은 `설계서_Architecture.md` 3.1절에 그려 두고 각 Phase에서 만든다.

> `updated_by`에 지금 FK를 걸지 않는 이유: `users` 테이블이 Phase 1에 생긴다. 참조 무결성은 Phase 1 마이그레이션에서 `ALTER TABLE ... ADD CONSTRAINT`로 추가한다.

### 3.3 마이그레이션

- `apps/api/drizzle/`에 SQL 파일과 메타데이터를 커밋한다.
- `migrate.ts`는 **모듈로도 CLI로도** 동작한다. 기동 시 자동 적용(개발)과 배포 절차의 명시적 단계(운영)가 같은 코드를 쓴다.
- 파일명은 Drizzle 생성 규칙(`NNNN_<name>.sql`)을 따른다. 문장 구분은 `--> statement-breakpoint`.
  > **정정 2026-09-22 (보류 17).** 여기 적었던 `--custom`으로 빈 파일을 만드는 절차는 더 이상 쓰지 않는다. **마이그레이션은 파일을 직접 만들어 쓰고 `_journal.json`에 손으로 등재한다.** 생성기는 스냅샷 사슬이 0004에서 끊겨 이미 있는 표를 다시 만드는 파일을 낸다 (`P6_검증기록_Collab` 3절).

### 3.4 시드

Phase 0은 만들 것이 없다. **틀만** 둔다: 로더 → 연결 → (비어 있음) → 종료. Phase 1이 root 계정과 기본 카테고리를 넣는다.

멱등 규칙: "있으면 건너뜀"으로 끝내지 않고 **빠진 필드를 채우는 것**까지 포함한다. 스키마가 늘어난 뒤 기존 행이 비어 있는 상태를 시드가 고쳐야 한다.

## 4. 헬스체크 (FR-040, FR-041)

```
GET /api/health
  → select 1 성공: 200 {"status":"ok","db":"ok","time":"..."}
  → 실패:          503 {"status":"degraded","db":"unreachable"}
```

DB까지 확인하는 이유: 앱 프로세스는 살아 있는데 DB를 못 쓰는 상태가 가장 흔한 장애다. 이때 200을 주면 로드밸런서·compose가 "정상"으로 보고 트래픽을 계속 보낸다.

컨테이너 헬스체크는 이 엔드포인트를 `node -e "fetch(...)"`로 호출한다. `curl`을 이미지에 넣지 않기 위해서다(이미지 크기·공격 표면).

## 5. 로깅 (FR-050 ~ FR-052)

- pino, JSON 한 줄, stdout. `base: { service }`, ISO 시각.
- `redact`: 쿠키·인증 헤더·`password`·`passwordHash`.
- `PinoNestLogger`가 Nest의 `LoggerService`를 구현해 프레임워크 로그도 같은 형식으로 낸다. `NestFactory.create(..., { bufferLogs: true })`로 로거 준비 전 로그를 버퍼링한다.

## 6. 공통 요청 처리 (FR-060 ~ FR-064)

| 항목 | 설계 |
|---|---|
| 검증 | `ZodPipe<T>` — 실패 시 400 + `issues[{path, message}]`. 어느 필드가 왜 틀렸는지 화면이 보여줄 수 있어야 한다 |
| 요청 제한 | `RateLimitGuard` + `@RateLimit({max, windowSec})`. 키는 `컨트롤러.핸들러:IP`. 메모리 맵이며 주기적으로 오래된 항목을 정리한다. 이중화 시 공유 저장소로 옮긴다 |
| 보안 헤더 | 전역 미들웨어. CSP `default-src 'self'`, `img-src 'self' data:`, `style-src 'self' 'unsafe-inline'`(에디터·인라인 스타일), `frame-ancestors 'none'`, `base-uri 'self'`, `form-action 'self'`. `WF_ENV=production`일 때 HSTS |
| 캐시 | `/api/*` → `no-store`. 정적 자산은 해시 파일명(`assets/<name>-<8자 이상>.<ext>`)만 `immutable`. **Vite 해시는 base64url이라 16진수 정규식으로는 못 잡는다** |
| 프록시 | `WF_TRUST_PROXY=true`면 `app.set('trust proxy', 1)` |
| 본문 크기 | JSON 2MB. 첨부는 Phase 3에서 별도 경로 |

> CSRF 헤더 검사와 세션은 **Phase 1**에서 붙인다. 보호할 세션이 없는 상태에서 CSRF 미들웨어만 두면 의미 없는 관문이 된다.

## 7. 웹 셸 (FR-070 ~ FR-072)

- Vite + React. `@workfluence/shared`는 **소스를 직접 별칭**으로 번들한다(api는 빌드된 `dist`를 쓴다). 개발 중 shared를 고치면 바로 반영된다.
- 개발 서버는 `/api`를 api로 프록시한다. 같은 출처처럼 동작해 쿠키·CSRF 흐름이 운영과 같아진다.
- Phase 0 화면: 앱 이름·버전과 `/api/health` 결과(성공/실패)를 보여준다. 실패 시 원인을 그대로 표시한다.
- 스타일은 시스템 폰트, 아이콘은 인라인 SVG. 외부 요청 0.

## 8. 스크립트 (FR-080 ~ FR-084)

| 스크립트 | 설계 |
|---|---|
| `check-env.ts` | 검사 항목을 배열로 모아 전부 출력한 뒤 판정한다. 첫 실패에서 멈추면 사용자가 문제를 한 번에 못 본다. 통과 시 마지막 줄 `READY`, 실패 시 종료 코드 1 |
| `dev-db.ts` | `embedded-postgres`로 `.local/pgdata`에 기동. 최초 실행이면 `initdb` + DB 2개(개발·테스트) 생성. `SIGINT`/`SIGTERM`에서 정상 종료 |
| `verify-docs.ts` | 6종 검사(FR-082). 검사 대상은 `README.md`·`CLAUDE.md`와 `docs/` 아래 모든 마크다운이다. 경로 검사 기준은 디스크가 아니라 **git이 추적하는 목록**이다 — 개발 PC에만 있는 것이 통과하고 갓 클론한 CI에서만 실패하는 일을 막는다 (트러블슈팅 T-010) |
| `e2e.ts` | `PLAYWRIGHT_BROWSERS_PATH`를 저장소 안 경로로 설정해 Playwright를 실행. OS별 환경변수 문법을 문서에서 없앤다 |
| `setup-env.ts` | `.env`가 없으면 `.env.example`을 복사한다. 문서의 실행 명령을 `pnpm <script>`로만 유지하기 위해(`cp`/`copy`는 OS마다 다르다) |
| `check-licenses.ts` | production 의존성 라이선스를 `CLAUDE.md` 7절 목록과 대조한다. 넓히려면 개별 예외에 사유를 적는다 |

### 8.1 각 명령은 자기 전제를 스스로 만든다

`apps/api`는 `@workfluence/shared`를 **빌드된 `dist`**로 참조한다. 따라서 `typecheck`·`test`·`test:cov`는 실행 전에 `build:shared`를 먼저 돌린다. 그러지 않으면 **개발 PC에서만 통과하고 갓 클론한 CI에서 실패한다** (실제로 겪었다 — `docs/internal/검토서_트러블슈팅.md` T-007).

`tsc`가 빠르므로 중복 빌드 비용(명령당 약 1초)보다 "어떤 상태에서 실행해도 같은 결과"가 낫다고 판단했다.

`check-env.ts`는 `statfsSync`로 드라이브 여유를 보고 3GB 미만이면 실패로 처리한다. 디스크 부족은 빌드·DB 쓰기를 **옆에서** 깨뜨려 원인 추적이 어렵다.

## 9. 검사와 CI (FR-090 ~ FR-094)

### 9.1 ESLint

flat config. TypeScript 파서 + `import-x` 플러그인.

| 규칙 | 이유 |
|---|---|
| `import-x/no-unresolved` (대소문자 포함) | Linux는 파일명 대소문자를 구분한다. Windows에서만 통과하는 import를 잡는다 |
| `@typescript-eslint/no-unused-vars` | 죽은 코드 |
| `no-restricted-syntax`: `import type`으로 주입 대상 클래스 가져오기 금지 | `import type`은 런타임에 사라져 Nest DI가 `undefined`를 받는다 |

### 9.2 CI (GitHub Actions)

작업 두 개다. `check`는 순차 단계로, `gitleaks`는 전체 이력을 따로 받아야 해서 **별도 작업**으로 돈다.

**작업 `check`** — 각 관문을 한 단계씩 나눈다. 실패하면 모두 중단한다.

| 단계 | 명령 |
|---|---|
| 의존성 설치 (lockfile 고정) | `pnpm install --frozen-lockfile` |
| lint | `pnpm lint` |
| typecheck | `pnpm typecheck` |
| 단위·통합 테스트 | `pnpm test` |
| 문서 검사 (verify:docs) | `pnpm verify:docs` |
| 취약점 점검 | `pnpm audit --audit-level high --prod` |
| 라이선스 검사 | `pnpm licenses:check` |
| 빌드 | `pnpm build` |
| 빌드 산출물의 외부 URL 참조 검사 | 워크플로 안 인라인 스크립트 (`http(s)://` 절대 주소를 찾고 예외 목록과 대조) |

**작업 `gitleaks`** — 저장소 전체 이력에서 시크릿을 찾는다. 얕은 체크아웃으로는 과거 커밋을 못 보므로 전체 이력을 받는다.

> **왜 `pnpm check` 한 줄이 아닌가.** 한 덩어리로 돌리면 로그를 뒤져야 어느 관문이 걸렸는지 안다. 실제로 CI가 세 번 실패하는 동안 단계를 나눈 뒤에야 문서 검사가 범인임이 한눈에 보였다 (`docs/internal/검토서_트러블슈팅.md` T-010). **검사 내용은 `pnpm check`와 같다** — FR-084가 요구하는 "로컬과 CI가 같은 검사"는 유지된다. 개발 PC에서는 한 줄로, CI에서는 나눠서 같은 것을 돌린다.
>
> **`--prod`를 붙이는 이유.** 개발 의존성의 취약점은 운영 이미지에 들어가지 않는다. 반입물에 없는 것으로 관문을 세우면 무시하는 습관이 생긴다.

이미지 빌드는 CI에서 하지 않는다. Docker가 필요한 작업은 Linux 서버에서 수동으로 하고, ~~안정되면 self-hosted runner를 검토한다~~ → **두지 않는다** (보류 5 닫음 2026-09-22).

## 10. 컨테이너·배포 (FR-100 ~ FR-104)

```
FROM node:24-bookworm-slim AS build   # 의존성 설치 → pnpm build → deploy --prod
FROM node:24-bookworm-slim            # 산출물 + production 의존성만, USER node
```

- 매니페스트만 먼저 복사해 의존성 레이어를 캐시한다.
- `HEALTHCHECK`는 `node -e "fetch('http://127.0.0.1:3000/api/health')..."`.
- compose: `postgres`(healthcheck, 볼륨) → `api`(`depends_on: service_healthy`) → `nginx`(TLS, 포트 매핑). 전부 `restart: unless-stopped`.
- nginx: `absolute_redirect off`(호스트 매핑 포트 유실 방지), `X-Forwarded-*`, WebSocket `Upgrade` 프록시, `client_max_body_size`.
- 개발 전용 키(`WF_PG_EMBEDDED_*`)는 컨테이너에 넘기지 않는다. 스키마가 strict라도 **선언된 키**이므로 넘겨도 기동은 되지만, 쓰이지 않는 값을 운영 환경에 두지 않는다.

## 11. 에이전트·스킬 (FR-110, FR-111)

| 이름 | 형태 | 모델 | 왜 그 형태인가 |
|---|---|---|---|
| `doc-consistency` | 에이전트 | sonnet | 문서 전체를 읽어야 해서 컨텍스트가 무겁고(무거운 읽기), 결과가 "어긋난 곳 목록"이라 닫힌 범위다. **읽기 전용** — 고치는 판단은 메인이 한다. 자주 돌아 비용을 아낄 자리 |
| `self-reviewer` | 에이전트 | fable | 작성자가 자기 실수를 못 보므로 독립된 시각이 결과를 바꾼다. Phase당 1회라 최고 모델을 쓴다 |
| `troubleshoot` | 스킬 | (메인) | **트러블이 터진 순간의 맥락을 아는 것은 메인**이다. 에이전트에 넘기면 기록으로 재구성해야 해서 부정확하다 |

근거·모델 배정·실행 기록은 `docs/internal/설계서_Agents.md`에 남긴다.

## 12. 구현 순서

A등급은 테스트를 먼저 쓴다 (`CLAUDE.md` 3절).

| 순서 | 작업 | 등급 |
|---|---|---|
| 1 | 모노레포 기반 — `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `.gitattributes`, `.gitignore`, `.env.example` | — |
| 2 | `shared`: `constants` → `permissions` → `security` → `document` → `env` → `schemas` (각각 테스트 먼저) | A |
| 3 | `api/config` → `api/db` → `api/common` → `api/health` → `app.module`·`main` | B |
| 4 | 마이그레이션 `0000_foundation` (settings) | B |
| 5 | `apps/web` 셸 | B |
| 6 | `scripts/*` | — |
| 7 | ESLint·`pnpm check`·CI | — |
| 8 | `deploy/*` | — |
| 9 | E2E 기동 확인 | C |
| 10 | 에이전트·스킬 정의 + `설계서_Agents.md` | — |
| 11 | 실측 → `docs/P0_검증기록_Foundation.md` | — |

## 13. Phase 1 인계 사항

| 항목 | 내용 |
|---|---|
| 환경변수 | 세션·계정·OIDC 키를 1.1절 표에 추가하고 `.env.example`·compose를 같은 커밋에서 갱신 |
| `settings.updated_by` | `users` 생성 후 FK 제약 추가 |
| 세션 | `connect-pg-simple`이 `PG_POOL`을 재사용. 쿠키는 `HttpOnly; Secure; SameSite=Lax`, 유휴는 `rolling` maxAge, 절대 타임아웃은 가드에서 |
| CSRF | 상태 변경 요청에 `CSRF_HEADER` 요구. 상수는 이미 `shared`에 있다 |
| 시드 | root 계정·기본 카테고리. 개발 환경 전용 계정은 `WF_ENV=development`에서만 |
| 가드 | `AuthGuard`가 `UsersService`를 쓰므로 해당 모듈을 `@Global()`로 둔다 — 가드의 의존성은 **가드를 쓰는 컨트롤러의 모듈**에서 해석된다 |
| E2E | 시나리오는 **자기 계정을 직접 만든다.** 시드 계정 상태를 전제하지 않는다 |
