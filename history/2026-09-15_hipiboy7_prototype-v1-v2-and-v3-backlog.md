# 2026-09-14 ~ 15 — 규칙서 확정, 프로토타입 v1·v2 완성, v3 요청 누적

- 작업자: hipiboy7 + Claude Code (Fable 5.1, max)
- 브랜치: `exp/prototype` (`impl-phase0`에서 분기). 규칙 변경은 `impl-phase0`에도 반영
- 이전 세션: 없음 (첫 세션)

## 1. 브랜치 상태 (종료 시점)

| 브랜치 | 커밋 | 내용 |
|---|---|---|
| `main` | `3f76fa7` | 초기 README만. 아직 아무것도 병합하지 않음 |
| `impl-phase0` | `424f036` | `CLAUDE.md` v1 + pnpm 12 설정 실측 반영 + 7절 비밀번호 8자·2종·계정 생명주기·역할 3단계. `pnpm-workspace.yaml`, `.gitattributes`, `.gitignore`, `docs/prompts/claude-md-v1.md` |
| `exp/prototype` | `d8f719b` | 프로토타입 v1(`bb9e264`)·v2(`d289348`) + v3 요청 누적 파일. 이 세션의 모든 코드 |

전부 `origin`에 푸시됨. 저장소는 **public** (사용자 결정) — 문서에 시크릿·사내 정보 금지 (`CLAUDE.md` 12.3절).

## 2. 이 세션에서 한 일

1. 참조 방법론(사내 선행 프로젝트)을 읽고 웹 앱용으로 각색 → `CLAUDE.md` 13절 규칙서. 재검토(fable max)로 실측 교훈 10건 추가. 근거·각색 내역은 `docs/prompts/claude-md-v1.md`
2. 환경 확인: Windows 개발 PC(Docker 없음, Node 24), D 드라이브 16GB 증설(여유 12GB). 데이터는 전부 `.local/` (pnpm store·PG·Playwright). pnpm 12는 `.npmrc` 무시 → `pnpm-workspace.yaml`
3. **프로토타입 v1**: 모노레포(shared·api·web), NestJS API, React+TipTap, Drizzle 마이그레이션, 임베디드 PostgreSQL 17.10(`pnpm dev:db`), 로컬 로그인·세션·CSRF, 스페이스·페이지·append-only 버전·409 충돌·복원, pg_trgm 한글 검색, 감사로그, SPA 서빙, Playwright E2E 3건
4. **프로토타입 v2** (사용자 요청 → `docs/prompts/prototype-v2.md` 해석·가정 16개): 비밀번호 8자·2종, 가입 요청→승인, ID/PWD 찾기, 담당자 확인, 눈 아이콘, 개인/팀 스페이스·카테고리·Crew·상태(활성/중지)·삭제 규칙, 역할 root⊃admin⊃member, 관리 대시보드(5건×3) + 사용자·스페이스·감사로그 페이지, root 시스템 페이지. shared 49 tests 99%, **E2E 9/9**
5. v3 요청 누적 시작 (`docs/prompts/prototype-v3.md`, 미반영): 첫 페이지 버튼 배치, 초기화 확인 문구, 임시 비밀번호 클립보드 복사
6. 사용자 질문 "프로토타입 먼저 → Phase 진행이 괜찮은가"에 답함: 좋다. 단 ① v3를 마지막 기능 반영으로 두고 종료 ② 판단 근거는 prompts 파일에 계속 ③ 승격은 모듈 단위로 4단계 문서를 밟으며. 이후 불확실 항목은 Phase별 작은 스파이크로

## 3. 실행 상태와 재시작

세션 종료로 API·DB 프로세스는 내려간다. 재시작 (`PROTOTYPE.md` 2절):

```
pnpm dev:db            # 터미널 1
pnpm check:env         # READY
pnpm build && pnpm start   # http://127.0.0.1:3000  (.env에 WF_SERVE_WEB=true)
```

시드 계정 `root`(시스템 관리자, 옛 `admin`) · `admin1` · `member1` · `pending1`(승인 대기). 비밀번호는 `.env`의 `WF_ROOT_INITIAL_PASSWORD` (저장소에 적지 않는다).
DB에는 E2E가 만든 합성 데이터가 남아 있다: `e2e*` 계정, `E2E 팀 공간 *` 스페이스, `분류*` 카테고리, v1의 `user1`(잠김). 지우려면 `.local/pgdata` 삭제 후 `pnpm dev:db` → `pnpm db:migrate` → `pnpm db:seed`.

## 4. 판단·관찰

- 사용자 작업 스타일: 화면을 직접 실행해 보고 요청을 준다. 요청은 "지금 반영하지 말고 모아서 한 번에" — v3 파일에 누적
- 사용자 계정으로 `admin` 로그인 실패 사례: v2 시드가 `admin`→`root`로 이름을 바꿨는데 안내가 늦었다. 이름을 바꾸는 이행은 사용자에게 먼저 알린다
- 실측 교훈 11건은 `PROTOTYPE.md` 4절. Phase 0 설계서에 그대로 옮길 것
- `CLAUDE.md` 1.2절 확인 필요 A~D(IdP 접근, 사내 정책 문서, 리뷰어, Linux 서버 사양)는 여전히 미답

## 5. 다음 세션 (사용자 지시 2026-09-15: "내일 v3부터 반영하고, 다시 기존 impl-phase0 브랜치로 돌아와서 프로토타입을 참조하면서 페이즈 진행하자")

1. `exp/prototype`에서 **v3 반영**: `docs/prompts/prototype-v3.md` 항목 1~3 (+ 그때까지 추가된 것). E2E 갱신(순서 단언·confirm 문구·클립보드), `PROTOTYPE.md` 갱신, 커밋·푸시. 이후 프로토타입은 **기능 추가 종료**
2. `impl-phase0`로 전환해 **Phase 0** 시작 (`CLAUDE.md` 1.1절 순서):
   - 0단계 환경 확인 → 보류 결정 표 확인
   - 요구사항 도출: `docs/scope-definition.md` 작성. 프로토타입 v1~v3의 결정·가정 표를 재료로. In/Out-of-Scope 표에 Phase 로드맵
   - `docs/설계서_Architecture.md`: 모듈 구조·데이터 모델(users/spaces/space_members/space_categories/pages/page_versions/audit_events/settings)·API 계약·환경 3종·테스트 전략. 프로토타입 실측 교훈 11건 반영
   - Phase 0 프롬프트를 `docs/prompts/phase0/`에 저장 → 4단계 산출물(요구사항정의서→설계서→코드+테스트→테스트결과서)
   - 코드 승격(모듈 단위, 프로토타입에서 가져오되 근거를 문서에): `packages/shared`, `apps/api/src/{config,db,common,health}`, `scripts/`, `deploy/`, `e2e/` 러너. 여기에 lint·`verify:docs`·CI(lint·typecheck·test·gitleaks)·`.claude/agents/{doc-consistency,self-reviewer}.md`·`docs/internal/설계서_Agents.md` 추가
   - 완료 기준: Linux 서버에서 `docker build -f deploy/Dockerfile` → compose 기동 → `/health` 200 (확인 필요 D 실측)
3. 인증·사용자(Phase 1)·스페이스·페이지(Phase 2)·관리(Phase 4)는 각 Phase에서 프로토타입 모듈을 승격하며 B등급 통합 테스트와 `/security-review`를 붙인다. E2E 9건은 인수 테스트로 재사용
