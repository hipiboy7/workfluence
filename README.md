# workfluence

금융 폐쇄망 내부용 위키·문서 협업 시스템 (Confluence 대체).

[![CI](https://github.com/hipiboy7/workfluence/actions/workflows/ci.yml/badge.svg)](https://github.com/hipiboy7/workfluence/actions/workflows/ci.yml) · 라이선스 [Apache-2.0](LICENSE) · [기여 방법](CONTRIBUTING.md) · [보안 제보](SECURITY.md)

> **In English** — workfluence is a self-hosted wiki and document collaboration system (a Confluence alternative) built for air-gapped networks. NestJS + React + PostgreSQL, real-time co-editing (TipTap/Yjs), Korean-friendly search, OIDC SSO plus local accounts, append-only audit log, an optional in-house LLM (OpenAI-compatible) menu, and an offline release bundle (`docker save`/`load`) that references no internet resource at runtime. Documentation is written in Korean. Licensed under [Apache-2.0](LICENSE).

| 무엇을 하는가 | |
|---|---|
| 문서 | 스페이스 → 계층 페이지, WYSIWYG 편집, 버전 이력·비교·복원, 템플릿, HTML 내보내기 |
| 같이 쓰기 | 실시간 동시 편집, 댓글, 멘션과 알림(앱 안 알림함·사내 메일 API) |
| 찾기 | 한글 질의 검색(PostgreSQL `pg_trgm`), 라벨, 첨부 |
| 권한과 관리 | 개인·팀 스페이스와 Crew(owner·editor·viewer), 관리 콘솔, 고쳐 쓸 수 없는 감사로그 |
| 로그인 | 로컬 계정(argon2id) + 사내 IdP OIDC |
| 사내 LLM | 관리자가 등록한 OpenAI 호환 LLM(vLLM)에 메뉴에서 묻는다 — 서버만 LLM을 부른다 |
| 폐쇄망 | 이미지 3종(app·nginx·postgres)을 tar 하나로 반입, 런타임에 인터넷 자원을 참조하지 않는다 |

**현재 단계**: Phase 20까지 완료. Phase마다 무엇을 끝냈는지(인수 기준)는 [`docs/scope-definition.md`](docs/scope-definition.md) 5절에 있다.

## 설치와 체험 — 어디서 시작하나

| 하려는 것 | 이렇게 한다 | 자세히 |
|---|---|---|
| **폐쇄망의 RHEL 9 서버에 설치한다** | 들고 갈 파일은 둘이다 — 반입 묶음 `workfluence-<날짜>.tar`와 그 `.tar.sha256`(서버에 Docker가 없으면 Docker 묶음 `docker-rhel9-<날짜>.tar`와 그 `.tar.sha256`도). 빌드 서버에서 `pnpm release:bundle`·`pnpm release:docker`로 만들고, 두 지문 값을 반입 신청서에 적는다. 대상 서버에서는 묶음을 풀어 맨 위의 `반입절차.md`를 **맨 앞의 "한눈에" 표**부터 따른다 | 만들기 — [linux서버배포가이드](docs/guide/shortcut/linux서버배포가이드.md) 12·12-1절 · 설치 — [설치및실행가이드](docs/guide/설치및실행가이드.md) "한눈에"·0~8절 · 막히면 — [장애대응](docs/guide/장애대응가이드.md) |
| **Windows에서 새 판을 써 본다** | 설치 없이 zip 하나다 — GitHub에 로그인해 [Actions → Windows 묶음 (F-009)](https://github.com/hipiboy7/workfluence/actions/workflows/windows-local.yml)의 맨 위 초록 실행에서 `workfluence-windows-trial`을 받아 짧은 영문 경로에 풀고 `시작.cmd`를 누른다. 그 실행의 커밋 번호가 받은 판이다 | [windows시연가이드](docs/guide/shortcut/windows시연가이드.md) **0절** — 처음 보는 사람을 위한 순서(찾기·받기·풀기·띄우기·새 판 확인·멈추기·잘 안 될 때) |

## 처음 온 사람이 읽는 순서

| 순서 | 문서 | 왜 |
|---|---|---|
| 1 | [`docs/learnSystem/학습가이드_시스템이해.md`](docs/learnSystem/학습가이드_시스템이해.md) | 개발 용어 없이 전체 그림을 잡는다. 30분 |
| 2 | [`docs/guide/사용자가이드.md`](docs/guide/사용자가이드.md) | 화면에서 무엇을 누르면 무엇이 되는가 — 모든 사용자(1부)·관리자(2부)·자주 묻는 것(3부) |
| 3 | [`docs/scope-definition.md`](docs/scope-definition.md) | 무엇을 왜 만드는가, 어디까지가 범위인가 |
| 4 | [`docs/설계서_Architecture.md`](docs/설계서_Architecture.md) | 구조·데이터 모델·확장점. 코드를 읽기 전에 본다 |
| 5 | [`CLAUDE.md`](CLAUDE.md) | 이 저장소에서 코드·문서를 만드는 규칙 |
| 6 | [`docs/P0_설계서_Foundation.md`](docs/P0_설계서_Foundation.md) | Phase 0이 만든 것의 요구사항과 설계 |
| 7 | 아래 "개발 환경 준비"를 직접 실행 | 문서를 믿지 말고 돌려 본다 |

그다음 필요할 때 보는 문서다. 따라 하는 가이드는 `docs/guide/`(설치및실행·운영·장애대응·사용자)와 `docs/guide/shortcut/`(windows시연·linux서버배포)에, 학습가이드는 `docs/learnSystem/`에 있다(`CLAUDE.md` 10.4절).

| 상황 | 문서 |
|---|---|
| 장애가 났다 | [`docs/guide/장애대응가이드.md`](docs/guide/장애대응가이드.md) |
| 폐쇄망에 반입한다 · 새 버전을 들여온다 | [`docs/guide/설치및실행가이드.md`](docs/guide/설치및실행가이드.md) — 맨 앞의 "한눈에" 표부터 |
| 운영을 넘겨받았다 | [`docs/guide/운영가이드.md`](docs/guide/운영가이드.md) |
| 인터넷이 되는 Windows에서 써 본다 | [`docs/guide/shortcut/windows시연가이드.md`](docs/guide/shortcut/windows시연가이드.md) — 처음이면 0절 |
| 리눅스 서버에서 이미지를 만들고 반입 묶음을 싼다 | [`docs/guide/shortcut/linux서버배포가이드.md`](docs/guide/shortcut/linux서버배포가이드.md) |
| 새 기능을 넣고 싶다 | [`docs/기능백로그.md`](docs/기능백로그.md) |
| 이 오류 본 적 있나 | [`docs/internal/검토서_트러블슈팅.md`](docs/internal/검토서_트러블슈팅.md) |
| 무엇을 어떻게 검증했나 | Phase별 검증기록 — [`docs/P0_검증기록_Foundation.md`](docs/P0_검증기록_Foundation.md) · [`docs/P1_검증기록_Auth.md`](docs/P1_검증기록_Auth.md) · [`docs/P2_검증기록_Page.md`](docs/P2_검증기록_Page.md) · [`docs/P3_검증기록_Content.md`](docs/P3_검증기록_Content.md) · [`docs/P4_검증기록_Admin.md`](docs/P4_검증기록_Admin.md) · [`docs/P5_검증기록_Release.md`](docs/P5_검증기록_Release.md) · [`docs/P6_검증기록_Collab.md`](docs/P6_검증기록_Collab.md) · [`docs/P7_검증기록_Hardening.md`](docs/P7_검증기록_Hardening.md) · [`docs/P8_검증기록_Mention.md`](docs/P8_검증기록_Mention.md) · [`docs/P9_검증기록_Gate.md`](docs/P9_검증기록_Gate.md) · [`docs/P10_검증기록_Llm.md`](docs/P10_검증기록_Llm.md) · [`docs/P11_검증기록_Ops.md`](docs/P11_검증기록_Ops.md) · [`docs/P12_검증기록_Limits.md`](docs/P12_검증기록_Limits.md) · [`docs/P13_검증기록_Readiness.md`](docs/P13_검증기록_Readiness.md) · [`docs/P14_검증기록_Spaces.md`](docs/P14_검증기록_Spaces.md) · [`docs/P15_검증기록_Grants.md`](docs/P15_검증기록_Grants.md) · [`docs/P16_검증기록_Crew.md`](docs/P16_검증기록_Crew.md) · [`docs/P17_검증기록_Ui.md`](docs/P17_검증기록_Ui.md) · [`docs/P18_검증기록_Mail.md`](docs/P18_검증기록_Mail.md) · [`docs/P19_검증기록_Recovery.md`](docs/P19_검증기록_Recovery.md) · [`docs/P20_검증기록_Install.md`](docs/P20_검증기록_Install.md) |
| 왜 이런 작업 방식인가 | [`docs/internal/검토서_방법론개정.md`](docs/internal/검토서_방법론개정.md) |

## 구조

```
apps/api/          NestJS API (빌드된 SPA도 함께 서빙)
apps/web/          React + Vite SPA
packages/shared/   서버·클라이언트 공유 계약 (환경 스키마·상수·문서 검증·권한·DTO)
e2e/               Playwright
deploy/            Dockerfile · compose · nginx (Linux 서버에서 빌드)
scripts/           check-env · setup-env · dev-db · verify-docs · e2e · check-licenses
                   reindex · trash-purge · audit-purge · backup-create · backup-restore
                   release-bundle · release-verify · load-test · mail-test        (전부 tsx, OS 무관)
docs/              운영·인수인계 산출물 / docs/internal 작업 기록 / docs/prompts 2026-11-14까지의 요청 원문
.local/            (git 무시) PostgreSQL 데이터·pnpm store·Playwright 브라우저 — 전부 저장소 안
```

## 개발 환경 준비

Node 24와 pnpm 12가 필요하다. 프로젝트 데이터는 전부 저장소 안 `.local/`에 생긴다.

```bash
pnpm install
pnpm setup:env
```

## 실행

터미널 두 개를 쓴다.

```bash
pnpm dev:db          # 터미널 1: 임베디드 PostgreSQL (첫 실행 시 초기화까지). Ctrl+C로 종료
```

```bash
pnpm db:migrate      # 터미널 2: 마이그레이션 적용
pnpm db:seed         # 처음 한 번: root 계정. 비밀번호는 .env의 WF_ROOT_PASSWORD, 첫 로그인에서 바꾼다
pnpm check:env       # 마지막 줄에 READY 확인
pnpm dev             # 개발 서버 (web http://127.0.0.1:5173, api :3000)
```

`pnpm db:seed`를 건너뛰면 **아무도 로그인하지 못한다** — 계정을 만드는 화면은 없고, 가입 요청은 승인할 관리자가 있어야 한다.
두 번 쳐도 된다(있는 계정의 비밀번호는 바꾸지 않는다).

운영과 같은 단일 프로세스로 확인하려면 `.env`에 `WF_SERVE_WEB=true`를 두고:

```bash
pnpm build
pnpm start           # http://127.0.0.1:3000
```

## 검사

```bash
pnpm check           # lint + typecheck + test + verify:docs (CI와 같은 검사)
pnpm test:cov        # 커버리지
pnpm test:e2e        # Playwright (api가 떠 있어야 한다 — 메일을 켠 채: scripts/e2e.ts 머리의 사전 조건)
```

## 배포

Linux 서버에서 이미지를 빌드해 폐쇄망으로 반입한다. 경로는 [`docs/설계서_Architecture.md`](docs/설계서_Architecture.md) 9절에 있다. 이미지를 만들고(빌드한 커밋을 라벨로 단다) 반입 묶음을 만들어 tar로 싸는 순서는 [`docs/guide/shortcut/linux서버배포가이드.md`](docs/guide/shortcut/linux서버배포가이드.md), 반입 당일의 설치(첫 root 계정까지)와 새 버전 들여오기는 [`docs/guide/설치및실행가이드.md`](docs/guide/설치및실행가이드.md), 평소의 운영은 [`docs/guide/운영가이드.md`](docs/guide/운영가이드.md)에 있다.

## 기여 · 보안 · 라이선스

- **기여**: [`CONTRIBUTING.md`](CONTRIBUTING.md) — 이슈와 fork의 PR로 받는다. 지켜야 할 규칙은 [`CLAUDE.md`](CLAUDE.md)다. 참여하는 사람의 약속은 [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md)
- **보안 결함**: 공개 이슈로 올리지 않는다 — [`SECURITY.md`](SECURITY.md)의 비공개 제보로 보낸다
- **라이선스**: [Apache License 2.0](LICENSE) · Copyright 2026 Kalius ([`NOTICE`](NOTICE)). 의존성은 허용적 라이선스(MIT·Apache-2.0·BSD·ISC·0BSD)만 쓰고 `pnpm licenses:check`가 CI에서 본다
