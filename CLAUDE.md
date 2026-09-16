# CLAUDE.md — 작업 규칙

`workfluence`는 금융 폐쇄망 안에서 쓰는 위키·문서 협업 시스템(Confluence 대체)이다.
이 문서는 이 저장소에서 코드·문서를 만들 때 항상 지키는 규칙이다.

- **무엇을/왜**: [`docs/scope-definition.md`](docs/scope-definition.md) — Phase 0 산출물 (작성 예정)
- **어떻게**: [`docs/설계서_Architecture.md`](docs/설계서_Architecture.md) — Phase 0 산출물 (작성 예정)
- **어떤 규칙으로**: 이 문서. 세 문서가 충돌하면 이 문서가 우선한다.
- 이 문서의 작성 근거와 참조 방법론 각색 내역: [`docs/prompts/claude-md-v1.md`](docs/prompts/claude-md-v1.md)

## 0. 프로젝트 요약 (작업 전 필수 확인)

### 0.1 무엇을 만드는가

- 스페이스 → 계층 페이지 → WYSIWYG 편집·버전 이력·검색·첨부·댓글·라벨, 스페이스·페이지 권한, 관리 콘솔, 감사로그.
- 사용자 약 **300명**, 동시 세션은 수십 수준. 단일 앱 서버 + PostgreSQL 1대로 시작한다. 이중화는 보류 결정 6.
- 실시간 동시 편집은 **2단계(Phase 6)**. 1단계는 편집 잠금 + 저장 시 버전 충돌 감지.

### 0.2 확정된 기술 결정 (2026-09-14)

| 영역 | 결정 | 왜 |
|---|---|---|
| 런타임 | Node.js **24** 고정, pnpm 워크스페이스 (`packageManager`로 버전 고정) | 개발 PC와 이미지의 런타임을 같게 |
| 백엔드 | NestJS — `apps/api` | 모듈·가드·인터셉터가 RBAC·감사로그·OIDC 요구에 맞는 구조 |
| 프론트 | React + Vite SPA — `apps/web` | 빌드 산출물을 api 이미지가 함께 서빙. 배포물은 단일 프로세스 |
| 공유 | `packages/shared` — zod 스키마·상수·문서(ProseMirror) 스키마·권한 판정 순수 로직 | 서버·클라이언트가 같은 계약을 쓰고, 순수 로직을 A등급 테스트로 |
| DB | PostgreSQL + **Drizzle ORM**, 마이그레이션은 SQL 파일 | 바이너리 엔진 없음(오프라인 유리), DBA가 읽는 SQL, PG 기능 직접 사용 |
| 인증 | 로컬 ID/PW(argon2id) + 사내 IdP **OIDC** Authorization Code. 세션은 서버측, PG 테이블 | 서버측 세션이어야 강제 만료·타임아웃을 통제할 수 있다 |
| 편집기 | TipTap(ProseMirror). 서버는 **JSON만** 수신·검증. HTML 수신 금지 | XSS 표면 차단. 검색용 텍스트 추출·HTML 내보내기는 서버가 같은 스키마로 수행 |
| 검색 | PostgreSQL 내장 tsvector + pg_trgm부터 | 반입 표면 최소. pg_bigm 전환은 측정 후 (보류 2) |
| 로그 | 앱 로그는 pino JSON stdout. **감사로그는 별도 DB 테이블**(append-only) | 감사는 증적, 로그는 운영 신호. 섞지 않는다 |
| 테스트 | Vitest 단일 러너 + 실제 PostgreSQL 통합 테스트 + Playwright E2E | 3절 |
| 배포 | 이미지 3종: app(Nest + SPA 정적), nginx(TLS), postgres. `docker save`/`load`로 반입 | 8절 |

### 0.3 환경 3종 (혼동 주의)

| 환경 | 어디 | 하는 일 | 제약 |
|---|---|---|---|
| **개발** | 이 Windows Server. Node 24, **Docker 없음** | 코드·테스트·문서. PostgreSQL 로컬 설치본으로 실행 | 컨테이너 빌드 불가. 명령은 `pnpm` 스크립트로만 (4.1절). 프로젝트 데이터는 전부 **D 드라이브, 이 디렉토리의 `.local/`** (8.1절) |
| **빌드** | Linux 서버 (Docker) | GitHub에서 pull → 이미지 빌드 → `docker save` → 반입 파일 | 빌드 전 디스크 여유 확인 (8.2절) |
| **운영** | 금융 폐쇄망 | `docker load` → compose 기동 | 인터넷 없음. 빌드·다운로드 불가. 모든 의존성은 이미지 안에 |

- 저장소: `https://github.com/hipiboy7/workfluence` — **public** (사용자 결정 2026-09-14). 12.3절 공개 저장소 규칙이 적용된다.
- 기본 브랜치 `main`. Phase 브랜치 `impl-phase{N}`.
- 참조 방법론: 사내 선행 프로젝트의 작업 규율을 웹 앱에 맞게 각색했다. 무엇을 그대로 두고 무엇을 바꿨는지는 `docs/prompts/claude-md-v1.md`. 선행 프로젝트의 저장소명·내부 정보는 공개 저장소인 이곳에 적지 않는다 (12.3절).

## 1. Phase 진행 절차 (반복 사이클)

Phase는 **기능 수직 슬라이스**(DB → API → UI)다. 각 Phase가 끝나면 브라우저에서 동작하는 증분이 있어야 한다. 완료 기준을 충족할 때까지 아래 사이클을 돈다.

| Phase | 명칭 | 산출물 | 종료 시 확인 가능한 것 |
|---|---|---|---|
| 0 | 범위·아키텍처·공통 기반 | `scope-definition`, `설계서_Architecture`, 모노레포, shared 공통 모듈(설정 스키마·상수·예외·로거), DB 마이그레이션 틀, `/health`, Dockerfile·compose·nginx, `verify:docs`, CI(lint·typecheck·test·gitleaks), 에이전트 정의 | Linux 서버에서 이미지 빌드 후 compose 기동, `/health` 200 |
| 1 | 인증·사용자·권한 골격 | 로컬 계정(정책·잠금) + OIDC 로그인, 세션, 사용자·그룹 JIT 동기화, 역할(RBAC) 골격, 감사로그 모듈, 최소 관리자 화면 | IdP로 로그인해 `groups` 클레임이 역할로 매핑됨. 감사로그에 로그인 이벤트 |
| 2 | 스페이스·페이지·편집기 | 스페이스, 계층 페이지 트리, 페이지 버전(append-only), TipTap 편집기, 서버측 문서 검증, 편집 잠금·충돌 감지 | 페이지 작성·편집·이력 보기·복원 |
| 3 | 검색·첨부·댓글 | 한글 검색(tsvector + pg_trgm, 측정 기록), 첨부(스토리지 추상화·content-hash), 댓글, 멘션 기록, 라벨 | 한글 질의로 페이지가 검색되고 파일이 첨부됨 |
| 4 | 권한 세분화·관리·알림 | 스페이스 권한(그룹), 페이지 제한, 관리 콘솔(사용자·그룹·스페이스·감사로그 조회), 휴지통·복원, 템플릿, HTML 내보내기, 앱 내 알림함 | 관리자가 권한을 바꾸고 감사로그로 추적 |
| 5 | 운영화·반입 | 배포가이드, 운영이관 가이드, 백업·복원 절차와 리허설, 반입 번들 스크립트, 부하 테스트(300명 기준), 보안 점검, 반입 후 체크리스트 | 폐쇄망 반입 리허설 통과 |
| 6 | 2단계 | Yjs + Hocuspocus 동시 편집, 외부 알림, 버전 diff, PDF 내보내기, Confluence 가져오기 | 착수 시 세부화 |

### 1.1 각 Phase의 진행 순서

0. **환경 확인 (필수 선행)** — `pnpm check:env`가 `READY`를 출력해야 시작한다. Node·pnpm 버전, `.env` 존재, PostgreSQL 연결, 마이그레이션 상태, **데이터 경로가 D 드라이브 `.local/` 아래인지와 드라이브 여유 공간**(8.1절)을 검사한다. (Phase 0에서 만든다. 그 전까지는 `node --version`과 DB 접속으로 수동 확인.)
   서비스가 내려간 상태로 테스트하면 "코드 문제"로 오진한다. 가용성은 항상 코드 밖에서 먼저 확인한다.
0-1. **보류 결정 확인 (필수 선행)** — 1.2절 표에서 이번 Phase가 트리거인 항목을 먼저 읽는다.
1. **요구사항 도출** — `scope-definition.md`에서 이 Phase가 책임질 범위와 달성 수준을 확정한다. **제품 기준은 Confluence의 실제 동작**이다. 이 Phase가 다루는 기능을 Confluence와 대조해 채택·변형·제외를 `docs/internal/P{N}_검토서_ReferenceComparison.md`에 남긴다. 산출물 본문에는 우리 근거만 쓴다 (1.3절).
2. **프롬프트 작성·제시** — 그 결과물이 나올 작업 프롬프트를 Claude가 작성해 사용자에게 설명과 함께 제시한다. 확인 후 `docs/prompts/phase{N}/`에 저장한다 (11절).
3. **브랜치 생성** — `main`에서 `impl-phase{N}` 분기.
4. **4단계 산출** — 4절 순서(요구사항정의서 → 설계서 → 코드+테스트 → 테스트결과서)를 지킨다.
5. **실제로 동작시켜 검증** — 9절. IdP·PostgreSQL은 실제 호출, 화면은 브라우저(Playwright)로 확인한다. 의존성·Docker·nginx를 건드린 Phase는 **Linux 서버에서 pull → 빌드 → 기동**까지 확인한다. 확인한 사실과 일자를 테스트결과서에 남긴다.
6. **자체 점검·개선** — 리뷰 전에 완료 기준 대비 누락과 품질 위험을 스스로 점검한다. `self-reviewer` 에이전트와 `/code-review`를 돌리고, 인증·첨부·권한을 다룬 Phase(1·3·4)는 `/security-review`도 돌린다. 결과는 `docs/internal/P{N}_검토서_SelfReview.md`.
7. **학습가이드** — 새 개념이 들어온 Phase(1 OIDC·세션, 2 ProseMirror 문서 모델, 4 권한 모델, 6 CRDT)는 `docs/internal/P{N}_학습가이드_*.md`를 쓰고 대화로 설명한다. 그 외 Phase는 선택. **직접 확인하는 명령**을 반드시 포함한다.
8. **리뷰** — GitHub PR을 올린다 (매 Phase). 리뷰어가 있으면 Direct 리뷰를 병행한다 (확인 필요 C). 지적을 반영할 때는 **Phase 0부터 문서 전체를 다시 읽는다** (4.2절).
8-1. **Phase 종료 루틴** — 병합 전에 한다. 에이전트 산출물은 그 Phase의 산출물이므로 브랜치 안에서 커밋돼 병합에 포함된다.

   ```
   ① doc-consistency("이 Phase에서 바뀐 것" 한 문장) + self-reviewer 동시 기동 (백그라운드)
   ② 메인은 최종 검증: pnpm check (lint·typecheck·test·verify:docs), Linux 빌드 확인,
      테스트결과서의 건수·커버리지·이미지 크기를 실측으로 갱신
   ③ 에이전트 결과 검토·반영
   ④ 브랜치에 커밋
   ⑤ PR 병합 (--no-ff) → push. 브랜치는 삭제하지 않는다 (12.1절)
   ```

9. **`main` 병합** — 12절 Git 규칙.

### 1.2 보류 결정 표

**결정을 문서 각주로만 남기지 않는다.** 보류하는 순간 (a) 트리거, (b) 실측이나 기계로 판정하는 방법, (c) 돌아갈 이정표 문서를 이 표에 등재한다. 기억에 의존하면 돌아오지 못한다. 종료된 항목은 지우지 않고 취소선과 날짜로 남긴다.

| # | 열린 결정 | 트리거 | 판정 방법 | 이정표 |
|---|---|---|---|---|
| 1 | IdP가 PKCE를 지원하는가. 선행 프로젝트의 설정 주석은 "미지원"이라 했지만 실측이 아니다 | Phase 1 착수 | Discovery 응답의 `code_challenge_methods_supported` 확인. 코드는 PKCE on/off를 설정으로 둔다 | `P1_설계서_Auth` |
| 2 | pg_bigm 커스텀 DB 이미지. pg_trgm은 2글자 부분 일치 질의에 인덱스를 못 쓴다 | Phase 3 검색 측정 후 | 2글자 한글 질의 재현율과 p95 지연을 실측. 기준 미달이면 Linux에서 pg_bigm 포함 이미지를 빌드해 반입 목록에 추가 | `P3_테스트결과서_Search` |
| 3 | 첨부 파일 바이러스 스캔(ClamAV 컨테이너 반입) | Phase 3 착수 | 사내 보안 정책 확인 (확인 필요 B). 정책이 요구하면 스캔 훅 구현, 아니면 훅 지점만 남김 | `P3_설계서_Attachment` |
| 4 | 실시간 편집 도입 시 저장 모델 (Yjs 상태 vs JSON 정본) | Phase 6 착수 | Phase 2에서 문서 저장을 인터페이스 뒤에 두고 `page_versions.content_json`을 정본으로 유지한다. Phase 6은 실시간 상태를 별도 테이블로 추가 | `P2_설계서_Page` |
| 5 | 이미지 자동 빌드 (GitHub Actions self-hosted runner) | Phase 0에서 수동 빌드 3회 연속 성공 후 | 수동 절차가 안정되면 runner 등록. 그 전까지 `git pull && docker compose build` 수동 | 배포가이드 (Phase 5) |
| 6 | 앱 서버 이중화 | Phase 5 부하 테스트 | 동시 50세션에서 p95 1초 초과 또는 가용성 요구가 있으면 2대 + 세션 공유 (이미 PG) | `P5_테스트결과서_Load` |
| 7 | PDF 내보내기 (헤드리스 브라우저 이미지 추가) | Phase 6 | 사용자 요구가 있을 때. Phase 4는 HTML + 인쇄 CSS | `P4_설계서_Export` |
| 8 | 중앙 로그 수집 사이드카 (Promtail 등) | Phase 5 | 운영 측 수집 인프라 유무 확인. 없으면 stdout JSON + `docker logs`로 운영 | 운영이관 가이드 (Phase 5) |
| 9 | ~~저장소 공개 여부~~ → **public 유지로 결정 (2026-09-14, 사용자)**. 대신 12.3절 규칙을 엄격히 적용 | 종료 | — | 이 문서 12.3절 |

**확인 필요 (사용자 답변 대기)** — 답이 오면 위 표나 상수 기본값에 반영한다.

| # | 항목 | 답이 없을 때의 가정 |
|---|---|---|
| A | 개발 PC에서 사내 IdP에 접근 가능한가 | 불가로 가정. 개발은 로컬 계정 + 모의 OIDC 서버, 실연동 검증은 Linux 서버에서 |
| B | 사내 비밀번호·세션·감사로그 보존 정책 문서가 있는가 | 없다고 가정. 7절 기본값 사용, 정책 확인 후 조정 |
| C | Direct 리뷰어가 있는가, PR 리뷰어를 지정하는가 | 없다고 가정. PR은 셀프 머지, 자체 점검(1.1절 6단계)을 강화 |
| D | Linux 서버의 Docker 버전·디스크 여유 | Docker 24+ · compose v2, 여유 20GB 이상으로 가정. Phase 0 첫 빌드에서 실측 기록 |

### 1.3 원칙

**근거는 우리 것으로.** 참조 방법론·Confluence·외부 자료를 참고할 수 있다. 그러나 산출물(문서·코드)에는 우리 판단의 근거만 남긴다. "Confluence가 그렇게 하므로"는 근거가 아니다. 이유를 쓸 수 없는 결정은 다시 검토한다. 판단이 바뀌면 지우지 않고 정정 이력으로 남긴다 (11절).

**문서가 아니라 동작으로 확인한다.** IdP 스펙 문서·라이브러리 README만으로 동작을 단정하지 않는다. 실제로 호출·클릭·빌드해 본 결과와 일자를 기록한다. 테스트가 skip으로 통과하면 통과가 아니다. skip 건수를 테스트결과서에 적는다.

## 2. 경계와 SOLID

- **SRP**: 모듈·클래스·함수는 하나의 책임. "권한 판정", "페이지 저장", "검색 인덱싱", "감사 기록"은 별도 모듈.
- **OCP**: 정책값(비밀번호 규칙·타임아웃·업로드 제한·허용 확장자)은 코드 수정 없이 설정으로 바뀐다 (5절).
- **LSP / ISP**: 인터페이스는 작게. 호출부는 필요한 메서드만 아는 인터페이스에 의존한다.
- **DIP**: 아래 4축은 **이 프로젝트에서 변경 가능성이 가장 높은 축**이다. 반드시 인터페이스(Nest 주입 토큰) 뒤에 두고, 상위 로직은 구체 구현을 import하지 않는다.

| 축 | 지금 | 바뀔 수 있는 것 |
|---|---|---|
| 인증 제공자 | 로컬 + OIDC(사내 IdP) | SAML, 다른 IdP, 인증서 로그인 |
| 파일 스토리지 | 로컬 디스크(볼륨·NAS) | MinIO·S3 호환 |
| 검색 백엔드 | PostgreSQL 내장 | pg_bigm, 외부 검색엔진 |
| 문서 실시간 상태 | 없음 (JSON 정본) | Yjs 상태 저장 (Phase 6) |

테스트에서는 이 인터페이스의 fake를 쓴다. 단 **PostgreSQL은 fake하지 않는다** (3절 B등급).

## 3. TDD — 등급별 선별 적용

판단 기준은 **"입출력이 결정적인가"**(같은 입력 → 항상 같은 출력)다. 등급은 디렉토리로 고정해 측정을 기계적으로 만든다.

| 등급 | 대상 (디렉토리) | 규칙 | 커버리지 |
|---|---|---|---|
| **A. 핵심 순수 로직** | `packages/shared/src/**`, `apps/api/src/**/domain/**` — 권한 판정, 페이지 트리·경로 연산, 문서 JSON 검증·텍스트 추출·HTML 변환, OIDC 클레임→역할 매핑, 비밀번호 정책 판정, slug·버전 규칙 | Red→Green→Refactor로 **테스트 먼저**. 테스트 없는 변경은 미완료 | **≥ 90%** (라인·브랜치) |
| **B. 통합** | `apps/api/src/**` 나머지(서비스·컨트롤러·리포지토리·가드), `apps/web/src/**` 컴포넌트 | 구현 후 테스트 허용. api는 **실제 PostgreSQL**(테스트 DB) 대상. 외부(IdP·스토리지)는 2절 인터페이스 fake | api **≥ 70%**. web은 측정·기록하되 관문 없음 (아래) |
| **C. E2E** | `e2e/**` (Playwright) | Phase당 핵심 사용자 흐름 1~3개. 통과/실패만 판정 | 측정 제외 |

- A+B(shared + api) 가중 평균 **≥ 80%**.
- **web에 커버리지 관문을 두지 않는 이유**: 렌더링 코드의 라인 커버리지는 품질과 상관이 약하고, 숫자를 맞추려는 테스트를 낳는다. 무시되는 관문은 없는 것보다 나쁘다. 대신 상태·분기가 있는 컴포넌트(권한별 메뉴, 편집기 툴바, 트리 조작)는 컴포넌트 테스트를 쓰고, 흐름은 E2E가 본다.
- 테스트 배치: A·B는 대상 파일 옆 `*.spec.ts(x)` (1:1 대응). E2E는 루트 `e2e/`.
- 테스트도 하드코딩 금지. 테스트 DB는 `WF_DATABASE_URL_TEST`. fixture는 **합성 데이터만** (12.3절).
- `P{N}_테스트결과서`에 그 Phase가 건드린 모듈의 등급과 **실측 커버리지·테스트 건수·skip 건수**를 기록한다. "95% 이상" 같은 수치 없는 서술은 미완료다.

## 4. Phase 내부 작업 순서

건너뛰거나 역순으로 하지 않는다.

1. **요구사항정의서** `docs/P{N}_요구사항정의서_<Topic>.md` — 무엇을, 왜. FR/NFR 번호.
2. **설계서** `docs/P{N}_설계서_<Topic>.md` — 데이터 모델(테이블·인덱스), API 계약(zod 스키마), 화면 흐름, 모듈 표와 등급, 설정 항목 표.
3. **코드 + 테스트** — 3절 등급. A는 테스트 먼저.
4. **테스트결과서** `docs/P{N}_테스트결과서_<Topic>.md` — 실행 환경·명령·건수·등급별 커버리지·실호출 기록·Linux 빌드 기록·실패·재작업.

요구사항–설계–코드–결과가 서로 추적 가능해야 한다: 문서는 코드 경로를, 코드의 JSDoc은 설계서 절 번호를 가리킨다. 설계서의 **설정 항목 표**에 없는 환경변수는 코드에 있을 수 없다 (5절).

### 4.1 문서에 적은 명령은 적은 그대로 실행해 확인한다

개발할 때 쓴 명령과 문서에 적은 명령이 다르면 실패하는 것은 독자뿐이다. 이 저장소는 Windows(개발)와 Linux(빌드·운영)를 오가므로 OS별 명령이 갈리기 쉽다. 그래서:

- **문서의 모든 실행 명령은 `pnpm <script>` 형태로만 적는다.** 스크립트 구현은 TypeScript(`tsx`)로 두 OS에서 같게 동작하게 한다. `.sh`는 `deploy/`(Linux 전용)에만 둔다.
- 편집기에서 복사한 명령을 터미널에 그대로 붙여 실행한다. 요약하거나 줄이지 않는다. 오류 메시지는 실제 출력을 복사한다.
- 기계가 검사한다: `pnpm verify:docs` — pnpm 스크립트 존재, 저장소 경로 실재, 마크다운 링크, 표 쪼개짐, 백틱 경로 실재, `deploy/*.sh` 실행 비트. `pnpm check`에 포함된다.

표준 스크립트 (Phase 0에서 만든다. 이름은 여기서 고정한다):

| 스크립트 | 하는 일 |
|---|---|
| `pnpm check:env` | 1.1절 0단계 환경 확인 → `READY` |
| `pnpm dev` | api + web 개발 서버 |
| `pnpm db:generate` / `pnpm db:migrate` | 마이그레이션 SQL 생성 / 적용 |
| `pnpm test` / `pnpm test:cov` | A·B 테스트 / 커버리지 |
| `pnpm test:e2e` | Playwright |
| `pnpm verify:docs` | 문서 검사 |
| `pnpm check` | lint + typecheck + test + verify:docs (CI와 동일) |
| `pnpm build` | api·web 빌드 |

### 4.2 리뷰·수정 반영은 Phase 0부터 전체를 다시 읽고 한다

부분 치환(찾아 바꾸기)은 같은 뜻의 다른 표현을 놓친다. 본문은 고쳤는데 표·In/Out-of-Scope·완료 기준·데이터 흐름 그림·다른 Phase 문서·학습가이드 Q&A·절 번호 참조가 옛 상태로 남는다. 기계 검사(`verify:docs`)는 "이 문장대로 하면 되는가"만 보고 "두 문장이 서로 반대말인가"는 못 본다.

읽는 순서 (상위부터): `CLAUDE.md` → `docs/scope-definition.md` → `docs/설계서_Architecture.md` → `docs/P0_*` → `docs/P1_*` → … → `docs/*.md`(배포·운영 가이드) → `docs/internal/*.md` → `README.md` → `docs/prompts/**` 최신본.

전체 재독은 `doc-consistency` 에이전트에 맡길 수 있다 (13절). 처음 2~3회는 메인이 결과를 독립 재검토한다.

## 5. 설정과 하드코딩 금지

값은 성격에 따라 세 곳 중 한 곳에만 둔다.

| 질문 | 위치 | 예 |
|---|---|---|
| 환경(개발/빌드/운영)마다 달라지는가 | `.env` → `WF_*` 환경변수 | DB URL, IdP issuer·client, 쿠키 도메인, 스토리지 경로, 로그 레벨 |
| 바꾸면 데이터·마이그레이션을 다시 만들어야 하는 설계 고정값인가 | `packages/shared/src/constants.ts` | 역할 이름, 문서 스키마 버전, 감사 이벤트 종류, 페이지 트리 최대 깊이 |
| 운영 중 관리자가 조절하는 정책값인가 | 기본값은 `constants`. 조절은 Phase 1은 `.env`, **Phase 4부터 DB `settings` + 관리 화면** | 비밀번호 규칙, 세션 타임아웃, 업로드 크기·확장자, 감사로그 보존 기간 |

규칙:

- **모든 앱 환경변수는 `WF_` 접두사.** `packages/shared`의 zod 스키마가 `WF_*`만 골라 파싱하고, 스키마에 없는 `WF_` 키가 있으면 **기동 실패**. 잘못된 타입도 기동 실패.
- `.env.example`의 키 집합 == 스키마 키 집합을 **테스트로 강제**한다. 키를 추가·삭제·개명하면 같은 커밋에서 ① `.env.example` ② 해당 설계서의 설정 항목 표 ③ `deploy/compose*.yml`·`deploy/envs/*.template`를 함께 갱신한다.
- **설정 키를 만들었으면 코드가 그 값을 실제로 쓰는지 확인한다.** 파일에 넣고 배선하지 않은 키는 로그에 값이 찍혀도 동작하지 않는다. 로그는 "읽었다"를 보여주지 "썼다"를 보여주지 않는다. 테스트는 값이 소비 지점에 전달되는지를 본다.
- `.env`는 커밋 금지. `.env.example`은 **placeholder만** (실제 호스트명·시크릿 금지, 12.3절).
- 매직 넘버·URL·경로·시크릿을 코드에 리터럴로 쓰지 않는다. 예외: 수학 상수, HTTP 상태코드, 테스트 fixture 값.

## 6. 데이터·문서 규칙

| 항목 | 규칙 |
|---|---|
| 마이그레이션 | Drizzle가 생성한 **SQL 파일**을 커밋. forward-only. 운영에서는 기동 시 자동 적용하지 않고 배포 절차의 명시적 단계(`pnpm db:migrate`). 개발만 `WF_DB_AUTO_MIGRATE=true` 허용 |
| 시드 | 멱등. 두 번 실행해도 결과가 같다. 운영 시드는 최소 관리자 계정·기본 역할만 |
| 페이지 본문 | ProseMirror JSON. `packages/shared`의 스키마로 서버가 검증. 문서에 `schemaVersion` 포함. 검증 실패는 400 |
| 페이지 버전 | `page_versions`는 **append-only**. 수정은 새 버전 추가, 현재 포인터만 이동. 저장 시 클라이언트가 기준 버전을 보내고 서버가 불일치면 409 |
| 삭제 | soft delete + 휴지통. 물리 삭제는 보존 기간 뒤 배치로, 감사로그에 남김 |
| 첨부 | 내용 해시(SHA-256)로 저장, 원본 파일명은 메타데이터. MIME·확장자 화이트리스트, 크기 상한. 스토리지는 2절 인터페이스 |
| 감사로그 | `audit_events` **append-only** (앱 DB 계정에 INSERT만 부여). 대상: 인증 성공·실패, 권한 변경, 스페이스·페이지·첨부·댓글의 생성·수정·삭제·이동·복원, 첨부 다운로드, 내보내기, 관리자 작업 |
| 시각 | DB는 UTC `timestamptz`. 표시만 KST |
| 검색 인덱스 | 본문 JSON에서 서버가 텍스트를 추출해 `tsvector` 컬럼 유지. 인덱스는 파생 데이터라 언제든 재생성 가능해야 한다. 재생성 명령은 Phase 3에서 제공한다 |
| 실데이터 | 실제 업무 문서·실제 직원 정보·실제 운영 로그는 저장소에 넣지 않는다. fixture·시드·스크린샷은 **합성 데이터만** |

## 7. 보안 규칙 (금융 폐쇄망)

기본값은 아래와 같다. 사내 정책(확인 필요 B)이 확인되면 정책값을 그 값으로 바꾸되, 여기 적힌 **구조 규칙**은 유지한다.

| 영역 | 규칙 |
|---|---|
| 외부 자원 | 런타임에 인터넷 자원을 **하나도** 참조하지 않는다. 폰트·아이콘·Swagger UI 자산 전부 번들. CI에서 빌드 산출물의 외부 URL 참조를 검사한다 |
| 세션 | 서버측 세션(PG). 쿠키 `HttpOnly; Secure; SameSite=Lax`. 유휴 30분 · 절대 12시간 기본. 로그아웃·비밀번호 변경·관리자 강제 종료 시 서버측 파기 |
| CSRF | SameSite + 상태 변경 요청에 커스텀 헤더 요구 |
| 로컬 계정 | argon2id. 기본 정책: **8자 이상, 영문 대·소문자·숫자·특수 중 2종** (사용자 결정 2026-09-15 — "엄청난 보안을 요하는 곳이 아니다". 이전 초안은 12자·3종), 5회 실패 시 15분 잠금(관리자 해제 가능). 주기 변경·재사용 금지는 사내 정책 확인 후. 로그인·가입·계정 복구는 IP별 rate limit |
| 계정 생명주기 | 가입 요청 → `승인 대기` → 관리자 승인 → `활성`. 임시 비밀번호(관리자 초기화·PWD 찾기)는 화면에 1회 표시, 다음 로그인에서 변경 강제. ID 찾기는 email + 이름 일치 시 마스킹된 ID만 (계정 열거 방지) |
| 역할 | `root`(시스템) ⊃ `admin`(사용자·스페이스 관리) ⊃ `member`. root만 root 부여, admin은 admin·member 생성. 스페이스는 `개인`/`팀`, 팀은 Crew(owner·editor·viewer)만 접근. 판정은 `packages/shared/src/permissions.ts` 한 곳 |
| 권한 | 기본 거부. 모든 엔드포인트에 가드. 권한 판정은 shared 순수 함수(A등급)로 한 곳에서 |
| 입력 | 모든 요청 본문·쿼리는 zod 검증. 문서는 JSON만. 링크는 `http(s)`·내부 경로만, 이미지 출처는 내부 첨부 URL만 |
| 응답 헤더 | CSP(`default-src 'self'` 기준), `X-Content-Type-Options`, `frame-ancestors 'none'`, HSTS. HTML·API는 `Cache-Control: no-store`, **해시 파일명 정적 자산은 immutable 캐시 허용** |
| 로그 | 비밀번호·토큰·세션 ID·문서 본문을 로그에 남기지 않는다. 사용자는 불투명 ID로. 감사로그는 6절 |
| TLS | 검증을 끄지 않는다. 사내 CA는 `NODE_EXTRA_CA_CERTS`로 신뢰. nginx가 종단 |
| 의존성 | lockfile 고정(`--frozen-lockfile`). 허용 라이선스 MIT·Apache-2.0·BSD·ISC·0BSD. GPL·AGPL·SSPL·상용은 승인 없이 금지. TipTap은 npm 공개 MIT 확장만(Pro 레지스트리 금지). `pnpm audit`·라이선스 검사·gitleaks를 CI 관문으로. 반입 번들에 SBOM(CycloneDX)과 라이선스 목록 포함 |
| 컨테이너 | non-root, 불필요 패키지 없음, 헬스체크, `restart: unless-stopped`. 시크릿은 이미지에 넣지 않고 `.env`·파일 마운트로 |

## 8. 실행 환경·Docker·반입

### 8.1 개발 (Windows)

- 명령은 `pnpm` 스크립트만 (4.1절). PowerShell/bash 차이를 문서에 노출하지 않는다.
- 줄바꿈: `.gitattributes`에 `* text=auto eol=lf` (Phase 0). Linux에서 `.sh`·Dockerfile이 CRLF로 깨지는 것을 막는다.
- 경로 대소문자: Linux는 구분한다. import 경로는 파일명과 대소문자까지 일치. lint로 잡는다.
- 네이티브 모듈은 prebuilt 바이너리가 있는 것만 (argon2 등). 빌드 도구 체인을 요구하는 패키지는 피한다.
- PostgreSQL은 로컬 설치본 또는 **임베디드 실행**(`embedded-postgres` 패키지가 `.local/pgdata`에 initdb·기동. 관리자 설치 불필요, 데이터가 프로젝트 디렉토리 안에 남음). **메이저 버전은 이미지와 같게** (Phase 0에서 고정). 개발 DB와 테스트 DB를 분리. 주의: PostgreSQL 서버 프로세스는 관리자 권한(elevated) 셸에서는 기동을 거부한다. 이 PC의 작업 셸은 비상승(2026-09-15 확인).
- **프로젝트 데이터는 전부 D 드라이브, 이 저장소 디렉토리 아래 `.local/`에 둔다** (git 무시. 사용자 지시 2026-09-14). C 드라이브(사용자 프로필·ProgramData)에 두지 않는다. D 드라이브가 부족하면 증설한다.

  | 데이터 | 위치 | 지정 방법 |
  |---|---|---|
  | PostgreSQL 데이터 디렉토리 (개발·테스트 DB) | `.local/pgdata/` | 서비스 초기화(`initdb`) 시 지정 |
  | 첨부 스토리지 | `.local/attachments/` | `WF_STORAGE_PATH` |
  | pnpm store | `.local/pnpm-store/` | `pnpm-workspace.yaml`의 `storeDir` (pnpm 12는 `.npmrc`의 pnpm 설정을 읽지 않는다 — 2026-09-15 실측). 프로젝트와 같은 드라이브여야 하드링크가 된다 |
  | Playwright 브라우저 | `.local/ms-playwright/` | `PLAYWRIGHT_BROWSERS_PATH` |
  | 임시 파일·로그·DB 덤프 | `.local/tmp/`, `.local/logs/`, `.local/dumps/` | 스크립트 기본값 |

  실측: 2026-09-14 D 전체 8.0GB·여유 4.0GB → **2026-09-15 16GB로 증설, 여유 12GB** (타 프로젝트가 4.2GB 사용). C 드라이브 여유 4.8GB (89% 사용). npm 캐시는 이미 `D:\claude\.cache\npm`, pnpm은 `pnpm-workspace.yaml`의 `storeDir`로 `.local/` 아래.

  필요 용량 추정 (개발 PC, 2026-09-15):

  | 항목 | 추정 |
  |---|---|
  | pnpm store + `node_modules` (같은 드라이브라 하드링크, 이중 계산 없음) | 1.5GB |
  | Playwright 브라우저 (Chromium만 0.5GB, 3종이면 1.2GB) | 0.5~1.2GB |
  | PostgreSQL 임베디드 바이너리 0.3GB + 개발·테스트 데이터·WAL 1GB | 1.3GB |
  | 빌드 산출물·Vite/tsc 캐시·커버리지 | 0.5GB |
  | 첨부 fixture·DB 덤프·임시 | 0.5GB |
  | 소스 + git 이력 | 0.3GB |
  | **합계** | **약 5GB, 버전 갱신 누적을 감안한 여유치 7GB** |

  → 16GB(여유 12GB)로 Phase 0~5 개발이 충분하다. `pnpm check:env`는 D 여유가 3GB 미만이면 경고한다. 분기마다 `pnpm store prune`으로 옛 버전을 정리한다.
- 권장 git 설정: `core.quotepath=false` (한글 파일명 표시).

### 8.2 빌드 (Linux)

- 빌드 전 `df -h /`를 확인한다. 여유 5GB 미만이면 빌드하지 않고 정리한다. 미사용 이미지·빌드 캐시가 디스크를 채우고, 디스크 풀은 **옆 컨테이너(DB)의 쓰기 실패**로 번진다.
- 멀티스테이지 Dockerfile. 베이스 `node:24-bookworm-slim` (alpine은 네이티브 모듈 호환 위험). `pnpm install --frozen-lockfile`. 런타임 스테이지에는 산출물과 production 의존성만.
- 이미지 크기 예산: app **400MB 이하** 목표. 실측을 테스트결과서에 기록한다.
- 태그는 `workfluence-app:<git-sha>`와 `:<version>`. `docker save`로 tar 생성, SHA-256 체크섬 파일 동반.
- `node_modules`는 커밋하지 않고 이미지 안에서 설치한다. `.dockerignore`에 `node_modules`·`.env`·`e2e`·`docs`.

### 8.3 운영 (폐쇄망)

- 반입 묶음: 이미지 tar 3종(app·nginx·postgres) + 체크섬 + 운영용 compose·nginx 설정 + `.env` 템플릿 + 마이그레이션 절차 + SBOM·라이선스 목록. 목록의 단일 출처는 Phase 5에서 쓰는 배포가이드다.
- `docker load` → `.env` 작성 → `pnpm db:migrate`(컨테이너 안에서) → `docker compose up -d` → 사후 검증 체크리스트.
- 모든 서비스 `restart: unless-stopped` + 헬스체크. 재부팅 후 자동 기동을 실제로 확인한다.
- nginx: TLS 종단, `absolute_redirect off` (호스트 매핑 포트 유실 방지), `X-Forwarded-*` 전달, WebSocket `Upgrade` 프록시 (Phase 6 대비), `client_max_body_size`는 첨부 상한과 일치.
- 볼륨: `postgres_data`, `attachments`. 백업은 `pg_dump` + 첨부 디렉토리. 복원 리허설은 Phase 5 완료 기준.

## 9. 외부 연동 규칙

### 9.1 사내 IdP (OIDC)

- Discovery(`/.well-known/openid-configuration`)를 쓰고 캐시한다. 엔드포인트 URL 하드코딩 금지.
- Authorization Code Flow. `state`·`nonce` 필수. PKCE는 보류 1 실측 후 설정으로.
- `id_token` 검증: 서명(RS256, JWKS `kid` 기준 **캐시**, 미지 `kid`면 1회 재조회) · `iss` · `aud` · `exp` · `nonce`.
- `redirect_uri`는 설정값을 **그대로** 보낸다. 요청 헤더로 조립하지 않는다. IdP 등록값과 포트·슬래시까지 일치해야 한다.
- 클레임: `sub`(불변 식별자, 사용자 키), `preferred_username`, `email`, `groups`. 로그인 시 사용자·그룹을 **JIT 동기화**한다. 스페이스 권한은 그룹 이름에 매핑한다 (설계서에서 확정).
- 프록시 뒤에서 동작하므로 Nest에 `trust proxy` 설정. `X-Forwarded-Proto`가 없으면 https 리다이렉트가 깨진다.
- TLS 검증 유지 (7절). 개발 PC에서 IdP 접근이 불가하면 (확인 필요 A) 모의 OIDC 서버로 개발하고, **실연동 확인은 Linux 서버에서 하고 그 응답·일자를 테스트결과서에 남긴다.** 모의 서버 통과는 완료가 아니다.
- IdP의 실제 호스트명·client_id·secret은 `.env`에만. 문서·`.env.example`은 placeholder (`https://idp.example.internal`).

### 9.2 PostgreSQL

- 확장은 contrib(`pg_trgm`, `ltree` 등)만 기본. 그 외(pg_bigm)는 보류 결정을 거쳐 커스텀 이미지로.
- 앱 계정은 DDL 권한 없음. 마이그레이션 계정과 분리. 감사로그 테이블은 앱 계정에 INSERT만.
- 통합 테스트는 실제 PG. 트랜잭션 롤백 또는 테이블 초기화로 격리.

## 10. 문서 파일명·배치 규칙

`docs/` 아래 flat하게 두고 아래 패턴을 따른다.

```
[P<phase>_]<DocType>_<Topic>.md
```

| DocType | 의미 | 4절 단계 |
|---|---|---|
| `요구사항정의서` | 무엇을·왜 | 1 |
| `설계서` | 데이터·API·화면·모듈·설정 | 2 |
| `테스트결과서` | 실행 결과 + **등급별 커버리지·실호출·빌드 기록 수치 필수** | 4 |
| `검토서` | 정규 4단계 밖의 점검·조사 (자체 점검, 기능 대조, 트러블슈팅, 부하·보안 점검) | 보조 |
| `학습가이드` | 사용자 숙지용. 직접 확인 명령 포함 | 보조 |

- `P<phase>`는 특정 Phase 종속 문서에만. 전체 문서(`scope-definition`, `설계서_Architecture`, `배포가이드`, `운영이관_가이드`)는 생략.
- `<Topic>`은 코드 모듈명과 맞춘다 (`Auth`, `Page`, `Search`).
- **`docs/` = 운영 이관 산출물** (요구사항정의서·설계서·테스트결과서·scope·Architecture·배포·운영 가이드). **`docs/internal/` = 작업 기록** (학습가이드·SelfReview·ReferenceComparison·트러블슈팅·용어집·설계서_Agents·반입후체크리스트·qa). 운영 담당자는 `docs/`만 읽어도 시스템을 운영할 수 있어야 한다.
- 개정은 **제자리 개정 + 머리에 개정 사유(정정 이력)**. 전면 재작성만 `_v2` 새 파일.
- 예외: `docs/scope-definition.md`, `README.md`, 디렉토리 안내 README, 용어집(`docs/internal/`에 두며 특정 Phase·DocType에 속하지 않는 공용 참조 문서).
- 트러블을 해결한 직후 `.claude/skills/troubleshoot/SKILL.md`에 따라 `docs/internal/검토서_트러블슈팅.md`에 기록한다. 조용히 잘못되던 유형은 반드시 쓴다.

## 11. 요구사항–산출물 페어링

대화로 진행되므로 대화 중 생기는 요구사항을 파일로 남긴다.

- 산출물에 반영되는 프롬프트는 예외 없이 `docs/prompts/`에 저장한다. Phase 종속: `docs/prompts/phase{N}/<산출물명>-v{버전}.md`. 전체 적용: `docs/prompts/<산출물명>-v{버전}.md`.
- 요구사항이 갱신되면 대응 산출물도 같은 버전으로 갱신해 **최신본 ↔ 최신본**이 항상 한 쌍이다.
- 판단이 바뀌면 이전 기록을 지우지 않고 **정정 이력**으로 남긴다. 왜 바뀌었는지가 중요하다.
- 사용자와의 개념 질의응답이 판단 근거가 되면 `docs/internal/qa/P{N}_질의응답_<주제>.md`에 보존한다.

## 12. Git·협업·공개 저장소 규칙

### 12.1 브랜치·병합

- **`main`에 직접 작업하지 않는다.** Phase당 `impl-phase{N}`을 `main`에서 분기. 탐색·실험은 `exp/<주제>`.
- **Phase 브랜치는 병합 후에도 삭제하지 않는다.** 병합 커밋은 결과만 보여주고, 브랜치는 과정을 보여준다.
- 매 Phase **PR**을 올리고 `--no-ff`로 병합한다. 리뷰어 유무는 확인 필요 C.
- 세션 단위 히스토리 `history/<YYYY-MM-DD>_<작업자>_<주제>.md`. 종료 시점 상태와 다음 단계를 포함해 다음 세션이 이어받는다. 히스토리는 사후에 고치지 않는다 (기록 위조).

### 12.2 커밋

- **커밋하면 곧바로 push한다** (사용자 지시 2026-09-14). 로컬에만 있는 커밋을 남기지 않는다. 이 PC는 개발 전용이고 Linux 빌드가 GitHub에서 pull하므로, 푸시되지 않은 커밋은 없는 것과 같다.
- 형식 `type(scope): 요약`. type은 `feat | fix | docs | test | refactor | chore | ci`, scope는 `phase{N}` 또는 모듈명. 예: `feat(phase1): OIDC 콜백에서 groups 클레임을 역할로 매핑`.
- **커밋 금지**: `.env`, 토큰·PAT·개인키·인증서 개인키, `node_modules`, 빌드 산출물, 실데이터 (6절), 실제 운영 로그·스크린샷.

### 12.3 공개 저장소 규칙

이 저장소는 public이다 (보류 9). 금융기관 내부 시스템의 설계가 공개되므로 아래를 지킨다.

- 사내 실제 호스트명·IP·포트·계정명·조직 구성·IdP 등록값을 커밋하지 않는다. 문서·예시는 `example.internal`류 placeholder만. 실제 값은 서버의 `.env`에만 있다.
- 시크릿은 예시값도 실제 형태로 쓰지 않는다 (`<발급받은 값>`). gitleaks가 CI에서 검사한다. 걸리면 커밋 이력에서 제거하고 값을 교체한다.
- 스크린샷·fixture·시드는 합성 데이터만 (6절).
- 참조한 사내 프로젝트의 내부 정보를 이 저장소에 옮겨 적지 않는다.

## 13. 에이전트·스킬

정의는 `.claude/agents/*.md`, `.claude/skills/*/SKILL.md`. **설계 근거·모델 배정·실행 기록은 `docs/internal/설계서_Agents.md`** (Phase 0에서 작성). 에이전트는 "무거운 읽기 · 닫힌 범위 · 승인 관문 없음 · 독립 시각이 결과를 바꿈" 네 기준 중 셋 이상일 때만 만든다.

| 이름 | 형태 | 모델 | 하는 일 | 언제 |
|---|---|---|---|---|
| `doc-consistency` | 에이전트 | sonnet | 4.2절 순서로 문서 전체를 읽고 변경과 어긋난 문장 목록을 낸다. **읽기 전용**, 수정은 메인 | 리뷰·판단 변경 반영 시, Phase 종료 |
| `self-reviewer` | 에이전트 | fable | 코드·설정·요구사항의 어긋남을 결함 찾기 전용으로 본다. 설정 키 배선, 권한 가드 누락, 등급 A 테스트 선행 여부 | Phase 종료 전 |
| `troubleshoot` | 스킬 | (메인) | 문제 해결 직후 트러블슈팅 기록 서식 | 해결 직후 |
| `/code-review`, `/security-review` | 내장 스킬 | — | 변경분 리뷰 · 보안 점검 | Phase 종료 전. 보안은 Phase 1·3·4 필수 |

- 정의 파일의 `model:`을 비우지 않는다. 자주 도는 것만 싼 모델.
- 결과에서 놓침·오탐이 확인되면 그 에이전트를 최고 모델로 올리고 되돌리지 않는다. 사유를 `설계서_Agents.md`에 한 줄 남긴다.
- Phase 진행 자체, IdP 탐색, 테스트결과서 본문은 에이전트에 맡기지 않는다. 승인 관문이 있거나, 그 자리에 있던 메인만 아는 맥락이 필요하다.
