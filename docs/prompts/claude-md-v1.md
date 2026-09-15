# CLAUDE.md v1 작성 요구사항

- 일자: 2026-09-14
- 요청 LLM 모델: Claude Fable 5.1 (max effort)
- 대응 산출물: [`CLAUDE.md`](../../CLAUDE.md) (저장소 루트)
- 위치 근거: 프로젝트 전체에 적용되는 규칙이므로 Phase 접두사 없이 `docs/prompts/` 직하 (`CLAUDE.md` 11절)
- 개정: 2026-09-14 (커밋 전) 커밋→push 규칙과 로컬 데이터 위치 규칙 추가. 선행 프로젝트의 저장소명·시스템명을 공개 저장소 규칙(`CLAUDE.md` 12.3절)에 따라 제거

## 1. 사용자 요청 (원문, 시간순)

> 금융 폐쇄망 내부에서 사용할 confluence를 개발하려고해. 프로그램 개발 계획 해볼래?

선택형 질문에 대한 답: 기술 스택 **NestJS API + React(Vite) SPA 모노레포**, DB **PostgreSQL**, 인증은
"자체 ID/PW 관리와 함께 사내에 구축해놓은 IDP 시스템이 있어서 그걸 연동해서 사용할 수 있게 해줘.",
편집기 **WYSIWYG 리치 에디터**.

> docker container 로 개발 가능한거야? 이 서버에는 Docker가 없어. 다만 Docker를 사용할 수 있는 linux 서버는
> 별도로 갖춰져있어. 그래서 여기서 어느정도 개발을 하고, github를 통해서 linux 서버로 옮긴 다음에 이미지로
> 만들 생각이야.

> IdP는 OIDC야, 규모는 300명 정도, 동시 편집은 2단계로 해줘.
> 추가로 내가 진행하고 있는 프로젝트 디렉토리 구조와 방법, 단계, 절차가 있는데, 그 방식을 따를 수 있는지 확인해줘.
> 참조 URL: <사내 참조 저장소 URL. 공개 저장소 규칙(`CLAUDE.md` 12.3절)에 따라 생략>
> 위 참조 URL대로 진행이 가능한지 보고, 우리 프로젝트에 더 적합한게 있다면, 그걸 제안해봐.

> 현재 fable max 버전으로 다시 한 번 검토.

> github에 리포지토리 새로 만들어서 진행 안해도 돼?

> https://github.com/hipiboy7/workfluence.git 만들었어, 연결해줘.

> private으로 안바꿔도 될 것 같아. impl-phase0 브랜치 만들고 CLAUDE.md부터 작성해줘

> 추가로 감안해야할 사항이야.
> 1. 커밋하면 push할 것
> 2. 로컬에서는 현재 D드라이브 현재 디렉토리에 프로젝트 데이터를 저장할 것(필요시 D드라이브 증설 예정)

> D드라이브로 옮겨서 현재 디렉토리에 모든 데이터 저장하면서 진행해. 그리고 그 내용을 바탕으로 github에 올리도록해.
> 현재 D드라이브는 16gb까지 확장 예정인데, 얼마나 공간이 더 필요해?

> 만약 현재 용량이 충분하다면, 프로토타입을 별도 브랜치로 만들어서 먼저 만들어봤으면해.
> 확인해보고 용량이 충분하면 바로 프로토타입 브랜치를 만들어서 완성본까지 진행해줘.

반영 (2026-09-15): `pnpm-workspace.yaml`의 `storeDir`·`cacheDir`·`stateDir`(pnpm store·cache를 `.local/`로. 처음엔 `.npmrc`에 썼으나 pnpm 12가 무시함을 실측으로 확인해 옮김), `.gitattributes`(LF 고정), `CLAUDE.md` 8.1절 용량 추정 표.
D 16GB 증설 확인(여유 12GB) → 충분 판정 → 프로토타입은 `exp/prototype` 브랜치(`CLAUDE.md` 12.1절 탐색 브랜치 규칙)에서 진행.

## 2. 확정된 결정 (2026-09-14)

| 항목 | 결정 | 결정 주체 |
|---|---|---|
| 제품 | 금융 폐쇄망 내부용 Confluence 대체 위키 | 사용자 |
| 스택 | NestJS API + React(Vite) SPA, pnpm 모노레포(`apps/api`, `apps/web`, `packages/shared`) | 사용자 (제안 채택) |
| DB | PostgreSQL. ORM은 Drizzle + SQL 마이그레이션 | 사용자 / ORM은 Claude 권고 |
| 인증 | 로컬 ID/PW + 사내 IdP OIDC 연동 | 사용자 |
| 편집기 | TipTap(ProseMirror) WYSIWYG, 서버는 JSON만 수신 | 사용자 / JSON 원칙은 Claude 권고 |
| 규모 | 약 300명. 단일 앱 서버 + PG로 시작 | 사용자 |
| 실시간 동시 편집 | 2단계(Phase 6)로 연기 | 사용자 |
| 개발·빌드·운영 환경 | Windows(개발, Docker 없음) → GitHub → Linux(Docker 빌드) → 폐쇄망(docker load) | 사용자 |
| 저장소 | `https://github.com/hipiboy7/workfluence`, **public 유지** | 사용자 |
| 기본 브랜치 | `main` (로컬 `master`에서 개명 후 첫 푸시) | Claude 권고, 사용자 승인 |
| 방법론 | 참조 저장소의 작업 규율을 웹 앱에 맞게 각색 (3절) | Claude 제안, 사용자 승인 |
| 커밋 정책 | 커밋하면 곧바로 push. 로컬 전용 커밋을 남기지 않음 | 사용자 |
| 로컬 데이터 위치 | D 드라이브, 저장소 디렉토리 아래 `.local/`. 부족하면 D 증설 | 사용자 / `.local/` 배치는 Claude 권고 |

## 3. 참조 방법론 각색 내역

참조: 사내 선행 프로젝트 A (임베딩 기반 분류 파이프라인)와 그 안에 보관된 선행 웹 프로젝트 B (FastAPI + OIDC 웹 서비스).
두 프로젝트의 문서·코드·트러블슈팅 기록을 전부 읽고 판정했다. 저장소명·호스트명 등 내부 정보는 `CLAUDE.md` 12.3절에 따라 적지 않는다.

### 3.1 그대로 채택

- 루트 `CLAUDE.md` 단일 규칙서, 0절 프로젝트 요약, 보류 결정 표(트리거·판정 방법·이정표)
- Phase 사이클과 4단계 산출물(요구사항정의서 → 설계서 → 코드+테스트 → 테스트결과서)
- 문서 파일명 `[P<phase>_]<DocType>_<Topic>.md`, `docs/` 대 `docs/internal/` 분리, 제자리 개정 + 정정 이력
- 하드코딩 금지 3분류, "근거는 우리 것으로", "문서가 아니라 동작으로 확인", "부분 치환 금지 전체 재독"
- Git: `impl-phase{N}` 브랜치, 병합 후 삭제 금지, `history/` 세션 기록, `.env`·실데이터 커밋 금지
- `doc-consistency` 에이전트(sonnet, 읽기 전용), `troubleshoot` 스킬, 트러블슈팅 누적 기록, `설계서_Agents`
- 선행 웹 프로젝트의 `IDP_설정가이드`·`권한관리설계서`·`배포가이드`(docker save/load)·`운영이관_가이드` 구조

### 3.2 변형 채택

| 항목 | 참조 | workfluence |
|---|---|---|
| Phase 축 | ML 파이프라인 단계, 파일 입출력 연동 | 기능 수직 슬라이스. Phase 종료 시 브라우저에서 동작하는 증분 |
| 워크플로우 친화 절 | status 파일·멱등 재실행 | DB 마이그레이션 멱등성, 페이지 버전 append-only, 감사로그 append-only (6절) |
| TDD 등급 | A 순수 ≥90 / B 통합 ≥70 / C 탐색 | A = shared + `domain/`, B = api 나머지(실 PG) + web 컴포넌트(관문 없음), C = Playwright E2E |
| 외부 서비스 기동 | 레거시 서비스 기동 스크립트 | `pnpm check:env` (Node·pnpm·PG·마이그레이션·데이터 경로) + IdP 실호출은 Linux 서버에서 |
| "참조 저장소 먼저 읽기" | 완성본 코드 비교 | Confluence 실제 동작을 제품 기준으로 대조 (`P{N}_검토서_ReferenceComparison`) |
| `verify_docs.py` | Python, `.venv` 전제 | TypeScript `verify:docs`. 문서 명령은 `pnpm <script>`로만 (Windows·Linux 동일) |
| 데이터 품질 절 | JSONL·클래스 균형 | 문서 데이터 규칙: 스키마 버전, 버전 불변, soft delete, content-hash 첨부 |
| 프롬프트 페어링 | v1→vN 누적 + `prompt-finest` 압축 | Phase당 프롬프트 제자리 개정. `prompt-finest`는 두지 않음 |
| 학습가이드 | 매 Phase | 새 개념 도입 Phase(1·2·4·6)만 필수 |
| PR | Phase 3·4만 | 매 Phase. GitHub가 Linux 서버로 가는 통로 |
| `docs/` 의미 | 심사 제출용 | 운영 이관 산출물 |

### 3.3 제외

- `report-writer` 에이전트, `심사기준.md` 대조 절차 (AI인증 심사 전용)
- 선행 웹 프로젝트 CLAUDE.md의 "커버리지 95% 일률" 규칙 (바깥 프로젝트가 등급제로 완화한 판단을 따름)

### 3.4 새로 추가 (참조에 없음)

- 7절 보안 규칙: 외부 자원 0, 서버측 세션·타임아웃, 비밀번호 정책 기본값, 감사로그 범위, PII 마스킹, TLS 검증 유지 + 사내 CA,
  의존성 라이선스·SBOM·gitleaks 관문, non-root 컨테이너
- 12.3절 공개 저장소 규칙 (저장소가 public이라는 결정의 대가)
- `WF_` 접두사 + zod strict 파싱 + `.env.example` 키 집합 테스트 (참조 T-003 "설정 키 미배선" 사고에서)

## 4. 재검토(fable max)에서 참조의 실측 기록으로부터 옮긴 규칙

| 참조에서 실제로 겪은 것 | 반영 위치 |
|---|---|
| 컨테이너 restart 정책 부재로 재부팅 후 내려감 | 7절·8.3절 `restart: unless-stopped` + 헬스체크 |
| 설정 키를 파일에 넣고 코드에 배선 안 함 | 5절 배선 확인 규칙, `WF_` strict 파싱 |
| 디스크 99%로 빌드 실패, 옆 컨테이너의 디스크 쓰기 실패가 500으로 보임 | 8.2절 `df -h` 절차, 이미지 크기 예산. 8.1절 D 드라이브 여유 경고 |
| E2E가 skip으로 조용히 통과 | 1.3절·3절 skip 건수 기록 |
| nginx 호스트 매핑 포트 유실, `redirect_uri` 한 글자 불일치 | 8.3절 `absolute_redirect off`, 9.1절 redirect_uri 그대로 사용 |
| JWKS 매 요청 조회, 자가서명이라 TLS 검증 끔 | 9.1절 JWKS 캐시, 7절 TLS 검증 유지 |
| 예시 env 파일에 실제 형태의 값이 들어갈 수 있음 | 5절·12.3절 placeholder만 + gitleaks |
| 앱 응답 전체 `no-store` | 7절 정적 자산은 immutable 캐시 허용 |
| WebSocket 헤더가 앱 vhost에 없음 | 8.3절 Phase 0부터 Upgrade 프록시 |
| 초기 테스트결과서에 수치 없음 | 3절 "수치 없는 서술은 미완료" |
| 문서 명령과 실행 명령 불일치 (`python` vs `.venv/bin/python`) | 4.1절 `pnpm <script>`만 |

## 5. 확인 필요 (미답, `CLAUDE.md` 1.2절)

| # | 항목 |
|---|---|
| A | 개발 PC에서 사내 IdP 접근 가능 여부 |
| B | 사내 비밀번호·세션·감사로그 보존 정책 문서 유무 |
| C | Direct 리뷰어 유무, PR 리뷰어 지정 여부 |
| D | Linux 서버의 Docker 버전·디스크 여유 |

## 6. 이 프롬프트가 낳은 산출물

- `CLAUDE.md` v1 (2026-09-14, `impl-phase0`)
