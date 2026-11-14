# 기여 방법 (Contributing)

workfluence에 관심을 가져 주어 고맙다. 버그 제보·문서 고치기·코드 기여 모두 환영한다.

> **In English** — Issues and pull requests from forks are welcome. Run `pnpm check` before you push, write tests first for pure logic, never include secrets or real data, and note that contributions are accepted under Apache-2.0. Docs and commit messages are in Korean, but English issues and PRs are fine.

## 시작하기 전에

| 하려는 것 | 이렇게 한다 |
|---|---|
| 버그를 알린다 | 이슈를 연다 — 다시 일으키는 순서와 커밋 번호를 적는다 |
| 기능을 제안한다 | 이슈를 연다. 바로 만들지 않고 [`docs/기능백로그.md`](docs/기능백로그.md)에 받아 적은 뒤 순서를 정한다 |
| 보안 결함을 알린다 | **이슈로 올리지 않는다** — [`SECURITY.md`](SECURITY.md) |
| 코드·문서를 고친다 | 작은 것은 바로 PR, 큰 것(새 표·새 화면·새 의존성)은 이슈로 먼저 이야기한다 |

## 개발 환경

Node 24와 pnpm 12가 필요하다. 준비·실행·검사 명령은 [`README.md`](README.md)의 "개발 환경 준비"부터 "검사"까지에 있다. PostgreSQL은 따로 깔지 않는다 — `pnpm dev:db`가 저장소 안 `.local/`에 띄운다.

## 보내는 순서

1. 저장소를 fork하고 `main`에서 브랜치를 만든다
2. 고친다. 커밋 메시지는 `type(scope): 요약` — type은 `feat | fix | docs | test | refactor | chore | ci`
3. `pnpm check`가 **종료 코드 0**으로 끝나는지 본다 (lint + typecheck + test + 문서 검사 — CI와 같다)
4. `main`으로 PR을 연다. 무엇을·왜 바꿨는지, 어떻게 확인했는지(실행한 명령과 결과), 확인하지 못한 것을 적는다
5. 유지보수자가 검토하고 `--no-ff`로 병합한다. 혼자 유지하는 프로젝트라 답이 며칠 걸릴 수 있다

## 지켜야 할 것

규칙의 단일 출처는 [`CLAUDE.md`](CLAUDE.md)다. 기여할 때 가장 자주 걸리는 것만 추린다.

- **시험** — 핵심 순수 로직(`packages/shared/src`, `apps/api/src/**/domain`)은 시험을 먼저 쓴다. 통합 시험은 실제 PostgreSQL로 돈다 (3절)
- **설정** — 환경변수는 `WF_` 접두사. 키를 더하거나 바꾸면 `.env.example`·설계서의 설정 항목 표·`deploy/compose.yml`을 같은 커밋에서 고친다 (5절)
- **외부 자원** — 런타임에 인터넷 자원을 참조하지 않는다. 폰트·아이콘도 번들한다 (7절)
- **의존성** — 라이선스는 MIT·Apache-2.0·BSD·ISC·0BSD만. `pnpm licenses:check`가 본다 (7절)
- **비밀과 실데이터** — 시크릿, 사내 호스트명·계정, 실제 업무 문서·직원 정보·운영 로그를 넣지 않는다. 예시는 `example.internal`류와 합성 데이터만 (12.3절)
- **문서** — 문서에 적은 명령은 적은 그대로 돌려 보고, `pnpm verify:docs`를 통과시킨다 (4.1절)

## 라이선스

이 프로젝트는 [Apache License 2.0](LICENSE)이다. 보낸 기여는 그 5조에 따라 **같은 라이선스로** 받는다 — 따로 서명하는 약정(CLA)은 없다. 자기에게 권리가 있는 것만 보낸다. 회사 업무로 만든 것이면 회사의 허락을 먼저 받는다.
