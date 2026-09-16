# Phase 0 작업 프롬프트 — 범위·아키텍처·공통 기반 (v1)

- 일자: 2026-09-16
- 작성 LLM: Claude Opus 5
- 상태: **승인 대기.** `CLAUDE.md` 1.1절 2단계 — 사용자 확인 후 이 파일이 Phase 0의 수행 근거가 된다.
- 대응 산출물: `docs/scope-definition.md`, `docs/설계서_Architecture.md`, `docs/P0_요구사항정의서_Foundation.md`, `docs/P0_설계서_Foundation.md`, 코드, `docs/P0_테스트결과서_Foundation.md`
- 입력 자료: `exp/prototype` 브랜치 (`PROTOTYPE.md`, `docs/prompts/prototype-v1~v3.md`)

## 1. 왜 Phase 0인가

Phase 1~6이 공유하는 기반을 먼저 확정한다. 각 Phase가 필요할 때마다 설정·상수·권한 판정·로거를 따로 만들면 서로 어긋나고, 한 곳을 빠뜨리면 조용히 실패한다.

또한 **폐쇄망 반입 경로를 맨 처음에 한 번 뚫어 둔다.** 마지막에 확인하면 이미지 크기·의존성·네트워크 제약이 설계를 뒤집을 수 있다. Phase 0의 완료 기준을 "Linux 서버에서 빌드한 이미지가 compose로 떠서 `/health` 200"으로 두는 이유다.

## 2. 프로토타입과의 관계 — 승격 규칙

`exp/prototype`에 동작하는 코드가 있다. 그러나 **복사해 오는 것이 아니라, 요구사항·설계를 우리 손으로 다시 세우고 그 결과로 같은 코드가 나오는 것**이다 (`CLAUDE.md` 1.3절 "근거는 우리 것으로").

| 단계 | 하는 일 |
|---|---|
| 1 | 프로토타입 코드를 읽고 **무엇을 왜 그렇게 했는지**를 요구사항·설계 문서에 우리 말로 쓴다 |
| 2 | 문서에 근거가 없는 코드는 가져오지 않는다. 근거를 쓸 수 없으면 그 결정을 다시 검토한다 |
| 3 | 가져온 모듈에는 A등급이면 테스트가 먼저 있었음을 커밋 이력으로 남긴다. 프로토타입에서 이미 테스트가 있는 것(`packages/shared`)은 그 테스트를 함께 옮긴다 |
| 4 | 프로토타입에 없던 것(lint·verify:docs·CI·에이전트)은 Phase 0에서 새로 만든다 |

**Phase 0에서 승격할 것**

| 대상 | 프로토타입 경로 | 비고 |
|---|---|---|
| 모노레포 골격 | `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json` | pnpm 12 `storeDir`·`allowBuilds` 실측 반영 (교훈 1·2) |
| 공유 계약 | `packages/shared/src/{env,constants,document,permissions,security,schemas}.ts` + `*.spec.ts` | A등급. 49건·99% 커버리지를 그대로 유지 |
| 설정·DB·공통 | `apps/api/src/{config,db,common}` | `WF_*` strict 파싱, Drizzle 마이그레이션 틀, ZodPipe, pino 로거, rate limit |
| 헬스체크 | `apps/api/src/health` | 컨테이너 헬스체크 대상 |
| 스크립트 | `scripts/{check-env,dev-db,e2e}.ts` | 명령은 `pnpm <script>`로만 (4.1절) |
| 배포 | `deploy/{Dockerfile,compose.yml,nginx.conf}`, `.dockerignore` | **Linux에서 실제 빌드해 검증** |
| E2E 러너 | `e2e/playwright.config.ts` | 시나리오는 Phase 1부터 |

**Phase 0에서 승격하지 않는 것** (해당 Phase로): 인증·사용자(1), 스페이스·페이지·편집기(2), 검색(3), 관리 화면·권한 세분화(4). 단 **데이터 모델 전체**는 설계서에 그려 둔다 — 테이블이 Phase마다 따로 설계되면 관계가 어긋난다. 마이그레이션은 각 Phase에서 추가한다.

## 3. 산출물별 요구사항

### 3.1 `docs/scope-definition.md` — 무엇을·왜

- 목적·배경, 대상 사용자(약 300명), 폐쇄망 제약
- **기능 범위**: 스페이스(개인/팀)·카테고리·Crew, 페이지 트리·버전·충돌, 검색, 첨부, 댓글, 권한, 관리 콘솔, 감사로그. 각 항목에 Phase 번호
- **In / Out of Scope 표** — Out에는 사유와 재검토 시점을 적는다 (실시간 동시 편집, PDF, Confluence 가져오기, 알림 외부 연동)
- **Phase 로드맵** — `CLAUDE.md` 1절 표를 상세화. 각 Phase의 "종료 시 확인 가능한 것"을 인수 기준 문장으로
- **비기능 목표**: 동시 50세션 p95 1초, 이미지 400MB 이하, 백업·복원 절차 보유, 외부 자원 0
- **확정된 결정과 그 이유** — 프로토타입 v2 가정 16개를 우리 판단으로 재서술. 바뀐 것은 정정 이력으로
- 용어 정의(스페이스·Crew·역할 3종·상태)

### 3.2 `docs/설계서_Architecture.md` — 어떻게

- 시스템 구성도: 브라우저 → nginx(TLS) → api(Nest + SPA 정적) → PostgreSQL. IdP는 외부
- 모듈 구조와 의존 방향(순환 없음). **CJS 순환 import가 런타임 DI를 깨뜨린 사례**(교훈 5)를 규칙으로: 공용 변환 함수는 별도 파일
- **데이터 모델 전체**: users·space_categories·spaces·space_members·pages·page_versions·audit_events·settings + 첨부·댓글·라벨(Phase 3 예정) 자리. 인덱스·제약·append-only 정책
- 권한 판정 경계: `shared/permissions.ts` 한 곳, 가드는 판정 결과만 쓴다
- 문서(ProseMirror) 계약: 허용 노드·마크 목록이 서버와 편집기에서 같아야 하는 이유와 유지 방법
- 4축 인터페이스(인증·스토리지·검색·실시간)와 교체 시나리오
- 환경 3종과 명령 표, 테스트 전략(등급별 대상·커버리지 관문)
- 배포 경로: 빌드 → `docker save` → 반입 → `load` → 마이그레이션 → 기동

### 3.3 `docs/P0_요구사항정의서_Foundation.md`

FR/NFR 번호로. 최소 포함:

- FR: `WF_*` strict 환경 스키마(스키마에 없는 `WF_` 키는 기동 실패), `.env.example` 키 집합 일치 테스트, 마이그레이션 적용·멱등 시드, `/api/health`(DB까지 확인), 구조화 로그, `pnpm check:env` READY 판정, `pnpm verify:docs` 검사 항목 6종
- NFR: A등급 ≥90%, 이미지 ≤400MB, 기동 30초 이내, non-root 컨테이너, 외부 URL 참조 0

### 3.4 `docs/P0_설계서_Foundation.md`

모듈 표(등급 포함), **설정 항목 표**(`WF_*` 전량 — 이 표에 없는 환경변수는 코드에 존재할 수 없다), 마이그레이션 파일 규약, CI 관문 목록, 에이전트 정의 근거(`docs/internal/설계서_Agents.md`로 분리)

### 3.5 코드

승격(2절) + 신규:

| 신규 | 내용 |
|---|---|
| lint | ESLint flat config. **import 경로 대소문자 검사**(Linux 대소문자 구분 — `CLAUDE.md` 8.1절), 미사용 변수, `import type` 강제 규칙은 DI를 깨뜨리므로 주의(교훈 5) |
| `pnpm verify:docs` | pnpm 스크립트 존재, 저장소 경로 실재, 마크다운 링크, 표 쪼개짐, 백틱 경로, `deploy/*.sh` 실행 비트 |
| `pnpm check` | lint + typecheck + test + verify:docs (CI와 동일) |
| CI (GitHub Actions) | `pnpm check` + `pnpm audit` + 라이선스 검사 + **gitleaks** + 빌드 산출물의 외부 URL 참조 검사 |
| 에이전트 | `.claude/agents/doc-consistency.md`(sonnet, 읽기 전용), `.claude/agents/self-reviewer.md`(fable), `.claude/skills/troubleshoot/SKILL.md` |

### 3.6 `docs/P0_테스트결과서_Foundation.md`

실행 환경·명령·건수·등급별 **실측** 커버리지·skip 건수, **Linux 빌드 기록**(Docker 버전·디스크 여유·이미지 크기·기동 확인·`/health` 응답 원문·일자), 실패·재작업 내역

## 4. 완료 기준 (Acceptance Criteria)

- [ ] `scope-definition.md`·`설계서_Architecture.md` 작성, 4.2절 읽기 순서로 서로 모순 없음
- [ ] 4단계 산출물(요구사항정의서→설계서→코드+테스트→테스트결과서)이 순서대로 커밋에 남음
- [ ] `pnpm check` 통과. A등급 커버리지 ≥90% 실측 기록
- [ ] `.env.example` 키 집합 == 스키마 키 집합 (테스트로 강제)
- [ ] 설계서 설정 항목 표에 없는 `WF_*`가 코드에 0개 (`grep`으로 확인)
- [ ] CI가 push마다 돌고 gitleaks 포함
- [ ] **Linux 서버에서 `git pull` → 이미지 빌드 → `docker compose up -d` → `/health` 200** (확인 필요 D 실측 기록)
- [ ] 이미지 크기 실측 ≤ 400MB (초과 시 사유와 감축 계획)
- [ ] 재부팅 후 자동 기동 확인 (`restart: unless-stopped`)
- [ ] 에이전트 정의 3개 + `docs/internal/설계서_Agents.md`
- [ ] `docs/internal/P0_검토서_ReferenceComparison.md`(Confluence 기능 대조)·`P0_검토서_SelfReview.md`

## 5. 착수 전 확인이 필요한 쟁점 (사용자 결정)

| # | 쟁점 | 선택지 | 권고 |
|---|---|---|---|
| 1 | Linux 빌드 서버 접근 | (a) 사용자가 직접 `git pull` + 빌드하고 결과를 붙여 준다 (b) 접속 정보를 주고 Claude가 원격 실행 | (a). 폐쇄망 인접 서버의 접속 정보를 공개 저장소 작업 세션에 두지 않는다 |
| 2 | CI 실행 위치 | (a) GitHub-hosted runner (공개 저장소라 무료) (b) self-hosted (Linux 서버) | (a)로 시작. 이미지 빌드까지 자동화할 때 (b) 검토 (보류 5) |
| 3 | 프로토타입 DB 데이터 | (a) 유지 (b) Phase 0에서 초기화 후 정식 시드로 다시 | (b). E2E·수동 확인이 남긴 합성 계정이 쌓여 있다 |
| 4 | `main` 병합 시점 | (a) Phase 0 완료 후 PR 병합 (b) 모든 Phase 후 | (a). `CLAUDE.md` 12.1절대로 매 Phase PR |

## 6. 하지 않는 것

- 인증·스페이스·페이지 기능 구현 (Phase 1·2)
- IdP 실연동 (Phase 1, 보류 1)
- 프로토타입 코드를 근거 없이 복사
- `main`에 직접 커밋
