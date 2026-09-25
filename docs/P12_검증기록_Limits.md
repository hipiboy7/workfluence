# P12 검증기록 — Limits (답을 기다리는 표시 · 문서 모양의 순서·개수 · 프레임과 값의 상한)

- 작성일: 2026-09-26 / 작성 LLM: Claude Opus 5.5
- 설계: [`docs/P12_설계서_Limits.md`](P12_설계서_Limits.md) · 검토: 8절
- 요청 원문과 착수 쟁점의 답: `docs/prompts/phase12/scope.md`
- 시행착오는 여기 쓰지 않는다 — [`docs/internal/검토서_트러블슈팅.md`](internal/검토서_트러블슈팅.md)
- 시험·커버리지는 `a5e0ca8`(코드의 마지막 커밋 — 그 뒤는 문서)에서 쟀다. 컨테이너 확인은 `workfluence-app:a5e0ca8-p12`로 했다.
  이 계정 소유의 사본에서 일했고(T-040·T-042), 새 빌드는 `:3100`에 띄워 `E2E_BASE_URL`로 E2E를 돌렸다

## 1. 실행 환경

| 항목 | 값 |
|---|---|
| 호스트 | 사내 Linux 서버 (RHEL 9). 개발·빌드 같은 호스트 |
| Node / pnpm | v24.21.0 / 12.4.1 |
| 편집기 | TipTap 3.31.3 · `@tiptap/y-tiptap` 3.0.9 · yjs 13.6 — 실측은 happy-dom에서 |
| 새 의존성·마이그레이션·환경변수 | **없다** (NFR-120) |
| Docker / Compose | 29.6.1 / v5.3.1. 빌드 전 `/` 여유 12GB |

## 2. 실측

### 2.1 받는 편집기가 순서·개수를 어긴 모양에 하는 일 (보류 25 판정 방법)

같은 입력을 두 경로로 넣었다 — 첫 로드의 변환(`initProseMirrorDoc`)과, **열린 편집기**(TipTap + `Collaboration`, 이 프로젝트의 확장 목록).
공유 문서(Y)에 규칙을 어긴 요소를 직접 넣었다.

첫 로드 경로 (`initProseMirrorDoc` → `doc.check()` → 끝·처음 자리에 한 글자 넣기):

```
목록 항목이 표로 시작: check 실패(Invalid content for node doc: <>) · 끝 편집 됨 · 처음 편집 던짐(Position 1 out of range) · Y 바뀜 → (빈 것)
목록 항목이 인용으로 시작: check 실패(Invalid content for node doc: <>) · 끝 편집 됨 · 처음 편집 던짐(Position 1 out of range) · Y 바뀜 → (빈 것)
빈 목록 항목: check 통과 · 끝 편집 됨 · 처음 편집 됨 · Y 바뀜 → <paragraph>글</paragraph>
빈 목록: check 통과 · 끝 편집 됨 · 처음 편집 됨 · Y 바뀜 → <paragraph>글</paragraph>
빈 인용: check 통과 · 끝 편집 됨 · 처음 편집 됨 · Y 바뀜 → <paragraph>글</paragraph>
빈 표 칸: check 통과 · 끝 편집 됨 · 처음 편집 됨 · Y 바뀜 → <table><tablerow></tablerow></table><paragraph>글</paragraph>
줄 없는 표: check 통과 · 끝 편집 됨 · 처음 편집 됨 · Y 바뀜 → <paragraph>글</paragraph>
칸 없는 줄: check 통과 · 끝 편집 됨 · 처음 편집 됨 · Y 그대로
줄마다 칸 수가 다름: check 통과 · 끝 편집 됨 · 처음 편집 됨 · Y 그대로
빈 문서: check 실패(Invalid content for node doc: <>) · 끝 편집 됨 · 처음 편집 던짐(Position 1 out of range) · Y 그대로
```

**이웃은 남는가** — 같은 목록·인용·표 안에 정상 요소를 함께 두었다(첫 로드 경로):

```
정상 항목 둘 + 인용으로 시작하는 항목 → Y: <bulletlist><listitem><paragraph>남의 글 1</paragraph></listitem><listitem><paragraph>남의 글 2</paragraph></listitem></bulletlist>
정상 항목 둘 + 빈 항목 → Y: (같다 — 빈 항목만 빠진다)
인용 안에 정상 문단 + 빈 인용 → Y: <blockquote><paragraph>남의 인용</paragraph></blockquote>
표: 정상 칸 + 빈 칸 → Y: <table><tablerow><tablecell colspan="1" rowspan="1"><paragraph>남의 칸</paragraph></tablecell></tablerow></table>
```

열린 편집기 (처음 입력까지):

```
항목이 인용으로 시작: 편집기 {bulletList[listItem[paragraph "남의 글 1"]] …} · Y <bulletlist><listitem><paragraph>남의 글 1</paragraph></listitem></bullet… · 처음 입력 됨
빈 인용: 편집기 {paragraph "끝"} · Y <paragraph>끝</paragraph> · 처음 입력 됨
빈 표 칸: 편집기 {paragraph "끝"} · Y <table><tablerow></tablerow></table><paragraph>끝</paragraph> · 처음 입력 됨
빈 문서: 편집기 {"type":"doc","content":[{"type":"paragraph"}]} · Y (빈 것) · 처음 입력 됨
연 뒤에 남이 비움: 편집기 {"type":"doc","content":[{"type":"paragraph"}]} · Y (빈 것) · 입력 뒤 Y <paragraph>x</paragraph>
```

→ **남의 글은 지워지지 않고, 열린 편집기는 깨지지 않는다.** 편집기는 어긴 요소만 공유 문서에서 지운다. 그래서 관문이 아니라 정본에서 지킨다
(설계서 A.1-3). 첫 로드 경로의 `check` 실패·처음 자리 편집 오류는 열린 편집기에서 나지 않았다 — 편집기가 빈 문단을 채워 그린다.

### 2.2 프레임의 크기 (보류 27 판정 방법)

`yDocFromDoc` → `Y.encodeStateAsUpdate`, 굵게·링크가 섞인 문단:

| 문단 | JSON | Yjs 전체 상태 |
|---|---|---|
| 500 | 167KiB | 169KiB |
| 2,000 | 671KiB | 687KiB |
| 6,000 | 2,015KiB (REST 상한 2MB 근처) | 2,070KiB |

가장 큰 정상 프레임(접속 직후의 전체 상태)은 저장할 수 있는 가장 큰 문서와 같은 크기다 — 상한을 그 8배인 16MiB로 두었다.

### 2.3 컨테이너 — nginx를 거친 실시간 편집 연결 (`a5e0ca8-p12`)

합성 계정 `p12-member`로 nginx(TLS, 8443)를 거쳐 로그인하고 페이지를 만든 뒤, 진짜 WebSocket(`ws`)으로 그 페이지에 붙어 프레임 하나를 보냈다.
끝나고 계정·공간·페이지를 지웠다.

| 보낸 프레임 | 결과 |
|---|---|
| 17MiB | **닫힘 코드 1009**. 앱 로그 `{"level":40,…,"event":"collab.frame_too_large","pageId":"…","userId":"…","limitBytes":16777216,"msg":"너무 큰 편집 프레임 — 연결을 닫았다"}` |
| 15MiB | 닫히지 않는다(20초 동안 열려 있었다) — 크기로는 받고 내용을 읽었다 |

기동: `up -d api nginx` → 헬스체크 200까지 2초, 경고·오류 줄 0, 재시작 0. 이미지 **380MB**(Phase 11과 같다).

### 2.4 옛 데이터 (설계서 E절)

개발 DB의 모든 버전·템플릿을 새 정본 검증에 대었다 — `page_versions 25건 · 새 검증에 걸린 것 0` · `page_templates 0건` · `page_realtime 0건`.

## 3. 자동 검사

| 항목 | 값 | 비고 |
|---|---|---|
| shared 테스트 | **336건** (Phase 11 종료 326) | 순서·개수, 표 칸 값의 범위, 상한 |
| api 테스트 | **912건** (Phase 11 종료 907) | 편집기처럼 읽는 변환(어긴 요소·비게 된 부모·빈 문서), 프레임 상한(설정과 warn 한 줄) |
| web 테스트 | **106건** (Phase 11 종료 98) | 대조 시험의 순서·개수 증명, 붙여 넣은 표 칸 값 줄이기(happy-dom), 기다림(상태 기계·화면 — 가짜 시계), 1009 |
| E2E | **31건 전부 통과** (2.0분) | +1 — 가짜 LLM이 첫 조각을 6초 늦추면 `답변을 기다리고 있습니다 · 0~3s` → 5초부터 `답변이 늦어지고 있습니다.` → 답이 오면 사라진다(8.8초) |
| skip | **0건** | |
| `pnpm check` | 종료 코드 0 (125초) | lint + typecheck + test + `verify:docs`(문서 60개, 위반 없음) |
| CI (GitHub Actions) | 8절 뒤에 적는다 | |

### 커버리지 (`pnpm test:cov`, 관문 통과 — 종료 코드 0)

| 범위 | 줄 | 분기 | 기준 |
|---|---|---|---|
| shared 전체 | 99.86% (716/717) | 96.76% (659/681) | A ≥ 90 |
| └ `document.ts` | 99.20% | 97.25% | 빠진 한 줄은 `stampSchemaVersion`(앞 Phase의 것 — api 시험이 부른다) |
| └ `constants.ts` | 100% | — | |
| api `pages/domain/ydoc.ts` (A) | 100% | 96.25% | A ≥ 90 |
| api `pages/domain/gate.ts` (A) | 98.79% | 95.20% | 바뀌지 않았다 |
| api `pages/collab/collab.gateway.ts` (B) | 83.04% | 76.66% | |
| api 전체 | 95.67% (2500/2613) | 90.26% (1948/2158) | B ≥ 70 |
| web 전체 | 90.92% | 84.04% | 기록만 (3절) |
| └ `llmStream.ts` | 100% | 98.75% | |
| └ `LlmPage.tsx` | 91.89% | 88.27% | |
| └ `collabLink.ts` | 100% | 84.84% | |
| └ `extensions.ts` | 93.54% | 91.89% | |

### A등급 테스트 선행 (3절)

| Red 커밋 | 무엇 | 그 판에서 | 뒤따른 구현 |
|---|---|---|---|
| `97b62ed` | 순서·개수·표 칸 값의 범위·상한·편집기처럼 읽는 변환 | shared **10 실패** / 326 통과, api `pages/domain/ydoc` **5 실패** / 30 통과 | `f511ec1` |

커밋하기 직전의 작업 트리(= 그 커밋)에서 셌다.

## 4. 브라우저 — E2E

| 시험 | 본 것 |
|---|---|
| 답을 기다리는 동안 기다린 초가 보이고, 5초부터 "답변이 늦어지고 있습니다." (`e2e/llm.spec.ts`) | 2.1의 문구가 그 차례로 보이고, 첫 조각(생각 과정)이 오면 둘 다 사라지며, 답이 저장돼 주소가 `/llm/<id>`가 된다(T-050의 교훈대로 저장까지 기다린다) |

전체 31건 — 편집기 확장(표 칸)을 바꿨으므로 실시간 편집의 붙여 넣기 시험(정렬된 표·링크)도 함께 봤다.

## 5. 이미지

`workfluence-app:a5e0ca8-p12` **380MB** (예산 400MB, 여유 20MB). 새 운영 의존성이 없다.

## 6. 보류 결정 처리

| # | 처리 |
|---|---|
| 30 | **닫았다** — 제한을 두지 않는다(사용자 결정), 기다린 초를 보인다(F-005) |
| 25 | **닫았다** — 규칙 둘을 정본 검증과 변환에, 대조 시험이 편집기와 같음을 증명(2.1) |
| 27 | **닫았다** — 프레임 16MiB(2.2·2.3), 표 칸 값의 범위와 편집기의 줄이기 |
| 16 | 그대로 — 사용자가 뜻을 물었고 정하지 않았다 |

## 7. 기능백로그

F-005(답을 기다리는 시간을 보인다) — 이 Phase에서 만들었다.

## 8. 검토

병합 전에 돌린다. 결과와 처리는 검토서에 모은다.

## 9. 확인하지 못한 것

- **사내 LLM이 실제로 붐빌 때** — 가짜 LLM의 6초 지연으로만 봤다. 붐비는 서버가 첫 조각 전에 무엇을 보내는지(살아 있음 줄이 오는지)는
  현장에서 본다(보류 29)
- **실제 브라우저에서 순서·개수를 어긴 모양을 받는 것** — happy-dom에서 TipTap으로 쟀다(2.1). Chromium에서 조작한 연결로 보내 보지는 않았다
- 셀 병합으로 1000칸을 넘기는 것(관문이 끊는다 — 설계서 D.5)은 재현하지 않았다
- 화면 읽기 프로그램이 1초마다 바뀌는 기다림 줄을 어떻게 읽는지는 보지 않았다(`role="status"`)
