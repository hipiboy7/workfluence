# 설계서_Architecture — 시스템 아키텍처 (v1)

- 상위 문서: [`docs/scope-definition.md`](scope-definition.md) — 무엇을·왜
- 규칙: [`CLAUDE.md`](../CLAUDE.md) — 어떤 규칙으로
- 요청 기록: [`docs/prompts/`](prompts/) 아래 사용자 요청 원문 (`CLAUDE.md` 11절)
- 작성일: 2026-09-16 / 작성 LLM: Claude Opus 5
- 상태: **Phase 8까지 구현 완료** (2026-09-24). 계획으로 남은 표기는 없다. Phase별 상세는 `P{N}_설계서_*.md`에 있다

## 0. 범위 문서와의 경계

같은 표를 두 문서에 두면 한쪽만 고쳐졌을 때 어느 것이 맞는지 알 수 없다. 그래서 **범위 문서는 결정과 기준, 설계서는 구현 방법**으로 나눈다.

| 내용 | 위치 |
|---|---|
| 기능 범위, In/Out of Scope, Phase 인수 기준, 비기능 목표, 결정의 이유 | `scope-definition.md` |
| 모듈 구조, 데이터 모델, 인터페이스, API 계약, 배포 경로, 테스트 전략 | **본 문서** |
| 코딩 규칙, TDD 등급, 하드코딩 금지, Git·보안 규칙 | `CLAUDE.md` |

## 1. 시스템 구성

```
[브라우저]
    │ HTTPS
    ▼
[nginx]  TLS 종단 · X-Forwarded-* 전달 · WebSocket 프록시(실시간 편집) · 업로드 상한
    │ HTTP (컨테이너 네트워크)
    ▼
[api]    NestJS. REST API + 빌드된 SPA 정적 서빙 (한 프로세스)
    │                                   │
    │ SQL                               │ OIDC · 메일 발송 (HTTP)
    ▼                                   ▼
[postgres]  문서·사용자·감사로그       [사내 IdP]  외부. Discovery·JWKS
                                       [사내 메일 API]  외부. 멘션 알림 (보류 18)
    │
    ▼
[볼륨]  postgres_data · attachments(Phase 3)
```

### 1.1 왜 api가 SPA를 함께 서빙하는가

배포물을 한 프로세스로 줄이면 반입·기동·헬스체크가 단순해진다. 정적 서버를 따로 두면 컨테이너가 하나 늘고, SPA 딥링크 폴백 규칙을 두 곳(정적 서버·nginx)에서 맞춰야 한다. 개발 중에는 Vite 개발 서버가 `/api`를 api로 프록시하므로 두 모드가 공존한다.

- 정적 자산 캐시: 해시 파일명(`assets/<name>-<hash>.<ext>`)만 `immutable`, 나머지와 API 응답은 `no-store` (`CLAUDE.md` 7절).

### 1.2 왜 단일 앱 서버인가

300명·동시 수십 세션 규모에서 이중화는 세션·파일·검색 동기화 비용을 먼저 지불하게 만든다. 세션을 처음부터 PostgreSQL에 두어 **나중에 대수를 늘려도 코드가 바뀌지 않게** 해 둔다. ~~판단은 Phase 5 부하 실측~~ → **하지 않는다** (보류 6 닫음 2026-09-22. p95 602ms / 목표 1,000ms).

## 2. 코드 구조

```
workfluence/
├── apps/
│   ├── api/                      NestJS
│   │   ├── src/
│   │   │   ├── config/           [P0] .env 로딩·검증 (WF_* strict)
│   │   │   ├── db/               [P0] Drizzle 연결·스키마·마이그레이션·시드
│   │   │   ├── common/           [P0] ZodPipe · 로거 · rate limit 가드 / [P7] revocation.bus.ts
│   │   │   ├── health/           [P0] /api/health (DB까지 확인)
│   │   │   ├── auth/             [P1] 로컬 로그인·OIDC·세션·가드
│   │   │   ├── users/            [P1] 가입·승인·초기화·역할
│   │   │   ├── audit/            [P1] append-only 기록·조회
│   │   │   ├── settings/         [P0 테이블 / P4 화면] 운영 정책값 (세 겹 출처 · 캐시)
│   │   │   ├── spaces/           [P2] 스페이스·카테고리·Crew
│   │   │   ├── pages/            [P2] 페이지·버전 / [P6] collab/(WebSocket 게이트웨이) ·
│   │   │   │                     domain/{realtime,ydoc}.ts / [P7] domain/liveness.ts / [P8] domain/makers.ts
│   │   │   ├── search/           [P3] 검색
│   │   │   ├── attachments/      [P3] 첨부 (domain 판정 · storage 경계)
│   │   │   ├── comments/         [P3] 댓글
│   │   │   ├── notifications/    [P4] 멘션 알림 (domain 추출 · 채널 경계) / [P8] scanMentions·callerFor
│   │   │   ├── trash/            [P4] 휴지통·되살리기
│   │   │   ├── labels/           [P4] 라벨
│   │   │   ├── templates/        [P6] 페이지 템플릿
│   │   │   └── mail/             [P6] 메일 발송 경계 (MAIL_SENDER · mock/http)
│   │   └── drizzle/              마이그레이션 SQL (커밋)
│   └── web/                      React + Vite SPA
│       └── src/{components,pages,api.ts,auth.tsx}
├── packages/shared/              [P0] 서버·클라이언트 공유 계약
│   └── src/{env,constants,document,permissions,policy,security,schemas,release,diff,html}.ts
├── e2e/                          Playwright
├── scripts/                      check-env · setup-env · dev-db · verify-docs · e2e · check-licenses
│                                 reindex · trash-purge · audit-purge · backup-create · backup-restore
│                                 release-bundle · release-verify · load-test   (전부 tsx, OS 무관)
├── deploy/                       Dockerfile · compose · nginx.conf
└── docs/                         산출물 / docs/internal 작업 기록 / docs/prompts 요청 기록
```

`[P0]`는 Phase 0에서 만드는 것, `[P1]`~`[P8]`은 해당 Phase에서 추가한다.

### 2.1 의존 방향

```
shared  ←  api(config → db → common → 기능 모듈)
  ↑
 web
```

- **`shared`는 아무것도 import하지 않는다** (zod 외). 서버·클라이언트 양쪽이 쓰므로 Node 전용 API를 넣지 않는다.
- api의 기능 모듈은 `config`·`db`·`common`에 의존하고, 기능 모듈끼리는 **인터페이스나 서비스 export를 통해서만** 의존한다.
- **순환 import를 만들지 않는다.** CommonJS에서 순환이 생기면 타입 검사는 통과하지만 런타임에 클래스가 `undefined`가 되어 의존성 주입이 실패한다. 실제로 프로토타입에서 `pages.service ↔ spaces.module` 순환이 기동 실패를 냈다. **두 모듈이 함께 쓰는 변환 함수·타입은 제3의 파일로 뺀다** (예: `pages/page-view.ts`).

### 2.2 공유 계약 (`packages/shared`)

| 파일 | 내용 | 왜 공유인가 |
|---|---|---|
| `env.ts` | `WF_*` 환경 스키마(strict), 파싱, `.env.example` 키 추출 | 서버가 쓰고, 테스트가 `.env.example`과 대조한다 |
| `constants.ts` | 역할·상태·Crew 역할·감사 이벤트·문서 스키마 버전·정책 기본값·CSRF 헤더 | 화면 문구와 서버 판정이 같은 목록을 봐야 한다 |
| `document.ts` | 문서 JSON 허용 노드·마크, 검증, 텍스트 추출 | **서버 검증과 편집기 확장이 어긋나면 편집기가 만든 문서를 서버가 거부한다** |
| `permissions.ts` | `can()`·`spaceAccess()`·역할 간 우열·비밀번호 정책 판정 | 화면의 버튼 노출과 서버의 403이 같은 규칙이어야 한다 |
| `security.ts` | ID·email 마스킹, 임시 비밀번호·식별자 생성 (난수 소스 주입) | 난수를 주입받아 순수 함수로 두면 테스트가 결정적이다 |
| `schemas.ts` | API 요청 DTO(zod) + 응답 뷰 타입 | 서버 검증과 클라이언트 타입이 한 정의에서 나온다 |
| `release.ts` | 반입 묶음의 필수 구성 목록 | 문서가 아니라 코드가 단일 출처다 (`CLAUDE.md` 8.3절) |
| `diff.ts` | 두 문서 JSON의 블록·단어 비교 (LCS) | 화면이 그리고 서버가 같은 결과를 내야 한다 |
| `html.ts` | 문서 JSON → HTML 렌더링·이스케이프·인쇄 CSS | 허용 노드 목록이 `document.ts`와 한 곳에서 나와야 한다 |

전부 **A등급**(테스트 먼저, ≥90%)이다. 입출력이 결정적이고 외부 의존이 없다.

> **Phase 0이 전 Phase의 DTO를 포함하는 이유.** 계약을 한 곳에 모아야 화면·서버가 어긋나지 않는다. 프로토타입에서 실제로 동작시켜 확인한 형태라 추측이 아니다. 다만 각 Phase에서 바뀔 수 있고, 바뀌면 그 Phase 문서에 정정 이력으로 남긴다.

## 3. 데이터 모델

전체를 여기에 그린다. **테이블이 Phase마다 따로 설계되면 관계가 어긋나기 때문**이다. 마이그레이션 파일은 각 Phase에서 추가한다.

### 3.1 테이블

| 테이블 | 핵심 컬럼 | 도입 | 비고 |
|---|---|---|---|
| `settings` | `key` PK, `value` jsonb, `updated_by`, `updated_at` | **P0** | 운영 조절값 (`CLAUDE.md` 5절 세 번째 분류) |
| `users` | `id`, `username` uq, `display_name`, `email` uq, `password_hash`, `oidc_sub` uq, `role`, `status`, `must_change_password`, `failed_attempts`, `locked_until`, `approved_at/by` | P1 | `status`: `pending`/`active`. **`잠김`은 저장하지 않고 `locked_until`로 파생**. `password_hash`와 `oidc_sub`는 각각 null 가능하지만 **둘 다 null인 행은 CHECK로 막는다** — 로컬 계정과 IdP 계정을 구분한다 |
| `sessions` | (connect-pg-simple 관리) | P1 | 서버측 세션 |
| `space_categories` | `id`, `name` uq, `created_by` | P2 | |
| `spaces` | `id`, `key` uq(자동), `name`, `description`, `kind`, `status`, `category_id`, `created_by`, `suspended_at/by`, `deleted_at` | P2 | `kind`: `personal`/`team`, `status`: `active`/`suspended` |
| `space_members` | (`space_id`,`user_id`) PK, `role`, `added_by` | P2 | Crew. `owner`/`editor`/`viewer` |
| `pages` | `id`, `space_id`, `parent_id`, `title`, `position`, `current_version_no`, `search_text`, `created_by`, `updated_by`, `deleted_at` | P2 | `search_text`는 파생 데이터 |
| `page_versions` | `id`, `page_id`, `version_no`, `title`, `content_json`, `content_text`, `created_by` — (`page_id`,`version_no`) uq | P2 | **append-only** |
| `audit_events` | `id`, `action`, `actor_id`, `target_type`, `target_id`, `detail` jsonb, `ip`, `created_at` | P1 | **append-only** (트리거로 UPDATE/DELETE 차단) |
| `attachments` | `id`, `page_id`, `sha256`, `filename`, `mime`, `size`, `uploaded_by`, `deleted_at` | P3 | 내용 해시로 저장, 원본 파일명은 메타데이터 |
| `comments` | `id`, `page_id`, `parent_id`, `body_json`, `created_by`, `deleted_at` | P3 | |
| `labels` / `page_labels` | `id`,`name` / (`page_id`,`label_id`) | P3 | |
| `notifications` | `id`, `user_id`, `kind`, `page_id`, `comment_id`, `actor_id`, `read_at`, `created_at` | P4 | 앱 내 알림함. **`actor_id`는 P8부터 null 가능** — 같이 쓴 문서에서 부른 사람을 확실히 모를 때다 (`P8_설계서_Mention` D절) |
| `page_realtime` | `page_id` PK, `state` bytea, `version_no`, `authors` jsonb, `updated_by`, `updated_at` | P6 · P8(`authors`) | Yjs 상태. **파생 데이터**라 지워도 정본에서 다시 시작한다 (보류 4). 페이지가 지워지면 CASCADE. `authors`는 멘션을 만든 사람의 장부다 — 멘션 자리마다 만든 사람, 어느 연결이 어느 글자를 들여왔나 (`P8_설계서_Mention` C.2절) |
| `page_templates` | `id`, `name` uq, `content_json`, `created_by`, `updated_at` | P6 | 페이지 시작 틀. 관리자만 만든다 |

### 3.2 규약

- 모든 시각은 UTC `timestamptz`. 표시만 KST로 변환한다. 서버가 여러 대가 되거나 서머타임 지역이 섞여도 비교가 깨지지 않는다.
- 식별자는 `uuid` (`gen_random_uuid()`). 순번 노출을 피하고 병합·이관이 쉽다.
- 삭제는 `deleted_at` soft delete. 물리 삭제는 보존 기간 뒤 배치로, 감사로그에 남긴다.
- **append-only 강제는 지금 트리거 한 겹이다.** 계정 분리(앱 계정에 `UPDATE`/`DELETE`를 주지 않는 것)는 아직 하지 않았다 — Phase 1이 Phase 5로 넘겼는데 Phase 5도 받지 않고 반입 후로 다시 미뤘다 (보류 12, `P5_검증기록_Release` 10절).
- **`page_versions`는 UPDATE만 막는다.** DELETE는 허용한다 — 페이지가 물리 삭제되면 버전도 함께 사라져야 한다. `audit_events`(UPDATE·DELETE 모두 차단, 보존 정리만 예외)와 뜻이 다르다 (`0006_constraints`).
- 파생 데이터(`search_text`)는 언제든 재생성 가능해야 한다. 재생성은 `pnpm search:reindex`다. **무엇을 골라 무엇을 쓰는지는 `apps/api/src/pages/reindex.ts` 한 곳에 있고**, 앱(`PagesService.reindexAll`)과 스크립트(`scripts/reindex.ts`)가 그것을 쓴다 — 실행 방법만 둘이다.

### 3.3 마이그레이션

**손으로 쓴 SQL 파일을 커밋**한다 (보류 17 판정 2026-09-22 — 생성기는 스냅샷 사슬이 0004에서 끊겨 이미 있는 표를 다시 만드는 파일을 낸다). forward-only이며 되돌리는 스크립트를 두지 않는다. 되돌림은 백업 복원으로 처리한다 — 폐쇄망에서 롤백 스크립트를 신뢰하기 어렵고, 잘못된 롤백이 데이터를 잃게 만든다.

| 환경 | 적용 방법 |
|---|---|
| 개발 | `WF_DB_AUTO_MIGRATE=true`면 기동 시 자동 |
| 운영 | **자동 적용 금지.** 배포 절차의 명시적 단계 (`pnpm db:migrate` 또는 컨테이너에서 `node dist/db/migrate.js`) |

환경 스키마가 운영에서 `WF_DB_AUTO_MIGRATE=true`를 **거부**한다. 설정 실수로 운영 DB가 조용히 바뀌는 것을 막는다.

## 4. 권한 판정

```
요청 → AuthGuard (세션 확인 · 사용자 적재 · 비밀번호 변경 강제 확인)
         │
         ├─ 시스템 행위 판정:  shared.can(user, action)          → 403
         └─ 스페이스 판정:     shared.spaceAccess(user, space, membership, memberCount)
                                 → { canRead, canWrite, canManageMembers, canChangeStatus, canDelete }
```

- **가드는 판정하지 않는다.** 데이터를 모아 공유 함수에 넘기고 결과만 쓴다. 판정 규칙이 한 곳에 있어야 화면과 서버가 어긋나지 않는다.
- 응답의 스페이스 객체에 `access`를 실어 보낸다. 화면이 같은 규칙을 다시 구현하지 않고 버튼 노출을 결정한다.
- 기본 거부. **로그인은 언제나 요구한다** — 예외는 `@Public`을 명시한 핸들러(로그인·가입·계정 찾기)뿐이다.
- 그 위에 `@RequireAction`으로 행위를 선언하면 `can()`으로 한 번 더 건다. **행위를 선언하지 않은 핸들러는 "로그인한 사람이면 누구나"의 뜻이다** — 데이터 범위를 스스로 좁히는 핸들러(`/api/auth/me` 등)가 여기 해당한다. 남의 데이터를 다루는 핸들러에 선언을 빼면 그것은 결함이다.

## 5. 문서(본문) 계약

- 저장 형식은 **ProseMirror JSON**. 서버는 HTML을 받지 않는다.
- `shared/document.ts`의 허용 목록(노드·마크·속성) 밖이면 400. 링크는 `http(s)`·내부 경로·앵커만 허용한다.
- **편집기 확장 목록과 서버 허용 목록은 같아야 한다.** 어긋나면 사용자가 만든 문서를 서버가 거부한다. 편집기 확장을 추가할 때 허용 목록도 같은 커밋에서 넓히고, 문서 스키마 버전을 올린다.
- 검색용 평문은 서버가 JSON에서 추출한다. 클라이언트가 보낸 텍스트를 믿지 않는다.

## 6. 교체 가능성 (DIP 경계)

| 축 | 지금 | 경계 | 교체 시나리오 |
|---|---|---|---|
| 인증 제공자 | 로컬 + OIDC | `AuthProvider` 주입 토큰 | SAML·다른 IdP·인증서 |
| 파일 스토리지 | 로컬 디스크(볼륨) | `StorageProvider` | MinIO·S3 호환·NAS |
| 검색 | PostgreSQL ILIKE + pg_trgm | `SearchProvider` | pg_bigm·외부 엔진 |
| 실시간 상태 | Yjs (`page_realtime`). **JSON이 정본이고 이것은 파생** | 게이트웨이가 상태를 읽고 쓰는 지점 | 다른 CRDT, 또는 실시간 편집을 끄는 것(`WF_COLLAB_ENABLED=false`) |
| 알림 발송 | 앱 안 알림함 + 사내 메일 API | `MAIL_SENDER` 토큰 (`mock`/`http`) | 사내 메신저, 다른 메일 게이트웨이 |

테스트에서는 이 인터페이스의 대역(fake)을 쓴다. 단 **PostgreSQL은 대역을 쓰지 않는다** — SQL·제약·트랜잭션이 곧 로직이라 대역으로 검증하면 실패를 놓친다.

## 7. 환경과 명령

| 환경 | 런타임 | DB | 비고 |
|---|---|---|---|
| 개발·빌드 (Linux) | Node 24 직접 실행 + Docker | 임베디드 PostgreSQL (`.local/pgdata`) | 2026-09-21 통합. 데이터는 저장소 안 `.local/`, 이미지 빌드 → `docker save` |
| 운영 (폐쇄망) | Docker compose | postgres 컨테이너 | 인터넷 없음 |

명령은 **`pnpm <script>` 형태로만** 문서에 적는다. 구현은 `tsx` 스크립트라 OS가 바뀌어도 같게 동작한다 (`CLAUDE.md` 4.1절). 개발과 빌드가 한 호스트가 됐어도 **컨테이너에서 되는지는 따로 확인한다** — 운영은 컨테이너다 (`CLAUDE.md` 0.3절).

| 스크립트 | 하는 일 |
|---|---|
| `check:env` | Node·pnpm·`.env`·DB·마이그레이션·데이터 경로·디스크 여유 → `READY` |
| `dev:db` | 임베디드 PostgreSQL 기동 |
| `db:migrate` / `db:seed` | 마이그레이션 적용 / 시드. **생성은 쓰지 않는다** (보류 17) |
| `dev` / `build` / `start` | 개발 서버 / 빌드 / 실행 |
| `search:reindex` | 검색 인덱스 재생성 (본문 JSON → `pages.search_text`) |
| `trash:purge` | 보존 기간을 넘긴 휴지통 항목 물리 삭제 (첨부 파일 실체까지) |
| `audit:purge` | 보존 기간을 넘긴 감사기록 삭제. `0005`의 예외를 열어 그 구간만 지운다 |
| `backup:create` / `backup:restore` | 백업(DB 덤프 + 첨부) 만들기 / 되살리기. 복원은 **빈 볼륨에만** |
| `release:bundle` / `release:verify` | 반입 묶음 만들기 / 필수 파일·체크섬·매니페스트 검사 |
| `load:test` | 동시 N세션 읽기 시나리오. p50·p95·max와 오류 수 |
| `lint` / `typecheck` / `test` / `test:cov` / `test:e2e` / `verify:docs` | 검사 |
| `check` | lint + typecheck + test + verify:docs (CI와 동일) |

## 8. 테스트 전략

| 등급 | 대상 | 방법 | 관문 |
|---|---|---|---|
| A | `packages/shared/**`, `apps/api/src/**/domain/**` | 테스트 먼저 (Red→Green→Refactor) | 라인·브랜치 ≥90% |
| B | api 나머지, web 컴포넌트 | 구현 후. api는 **실제 PostgreSQL**(테스트 DB), 외부는 대역 | api ≥70%, web은 측정만 |
| C | `e2e/**` | Playwright, Phase당 핵심 흐름 1~3개 | 통과/실패 |

- **web에 커버리지 관문을 두지 않는다**: 렌더링 코드의 라인 커버리지는 품질과 상관이 약하고, 숫자를 맞추려는 테스트를 낳는다. 무시되는 관문은 없는 것보다 나쁘다.
- **skip은 통과가 아니다.** 검증기록에 skip 건수를 적는다.
- E2E는 **자기가 필요한 상태를 직접 만든다.** 사람이 화면에서 바꿀 수 있는 시드 데이터를 전제로 두지 않는다 (프로토타입에서 실제로 깨졌다).

## 9. 배포 경로

```
개발 PC ──git push──▶ GitHub ──git pull──▶ Linux 서버
                                              │ docker build (멀티스테이지)
                                              │ docker save → tar + sha256
                                              ▼
                                      [반입 절차] ──▶ 폐쇄망
                                                        │ docker load
                                                        │ .env 작성
                                                        │ db:migrate (명시적 단계)
                                                        │ docker compose up -d
                                                        ▼
                                                   사후 검증 체크리스트
```

- 이미지 3종: `app`(Nest + SPA), `nginx`, `postgres`.
- 빌드 스테이지에서 의존성 설치·빌드, 런타임 스테이지에는 산출물과 production 의존성만. 베이스는 `node:24-bookworm-slim` (alpine은 네이티브 모듈 호환 위험).
- 컨테이너는 non-root, 헬스체크, `restart: unless-stopped`.
- 반입 묶음 구성의 단일 출처는 **코드**다 (`packages/shared/src/release.ts`의 `RELEASE_REQUIRED_FILES`). 반입 당일의 절차는 [`docs/운영가이드_반입.md`](운영가이드_반입.md)다.

## 10. Phase별 추가 지점

| Phase | 이 설계에 더해지는 것 |
|---|---|
| 1 | `auth`·`users`·`audit` 모듈, `users`·`sessions`·`audit_events` 테이블, OIDC 제공자 구현, 세션·CSRF 미들웨어 |
| 2 | `spaces`·`pages` 모듈과 테이블, 편집기, 버전·충돌 |
| 3 | `search`·`attachments`, 댓글·라벨, trigram 인덱스, 스토리지 제공자 |
| 4 | 관리 화면, 권한 세분화, 휴지통, 알림, `settings` 관리 UI |
| 5 | 배포·운영 문서, 백업·복원, 부하·보안 점검 |
| 6 | 실시간 편집(JSON 정본 + Yjs 파생, 보류 4), 버전 비교, HTML 내보내기, 템플릿, 멘션 메일. PDF·가져오기는 하지 않는다 |
| 7 | 반입 전 강화 — 살아 있는 연결의 권한 재판정·하트비트, 이미지 군살 제거 |
| 8 | 멘션 귀속 — `pages/domain/makers.ts`(멘션을 만든 사람의 장부: 새로 생긴 멘션 자리 · 어느 연결이 어느 글자를 들여왔나 · 저장 전까지 사라진 이름), `page_realtime.authors`, `notifications.actor_id` null 허용 (`0008`) |

## 11. 확장점 — 기능 하나를 더하려면 어디를 만지나

기능 추가 절차는 `CLAUDE.md` 1.4절, 요청 기록은 [`docs/기능백로그.md`](기능백로그.md)다. 이 절은 **비용을 미리 아는 것**이 목적이다. 만지는 층의 수가 곧 크기다.

### 11.1 층과 순서

```
① 계약      packages/shared/src/{constants,schemas,permissions,document}.ts
② 데이터     apps/api/src/db/schema.ts + apps/api/drizzle/ 마이그레이션 SQL
③ 서버      apps/api/src/<모듈>/ (컨트롤러 → 서비스 → 리포지토리)
④ 화면      apps/web/src/{pages,components}
⑤ 검증      각 층의 *.spec.ts + e2e/
⑥ 문서      P{N}_설계서 설정·API 표 → 학습가이드 → 운영가이드
```

**항상 ①부터 간다.** 계약을 먼저 고치면 서버와 화면이 같은 정의를 보므로 "버튼은 보이는데 누르면 거부"가 생기지 않는다. 화면부터 만들면 그 화면에 맞춰 서버를 끼워 넣게 되고, 규칙이 두 곳으로 갈라진다.

### 11.2 요청 유형별 비용

| 원하는 것 | 만지는 층 | 크기 | 주의 |
|---|---|---|---|
| 화면 문구·버튼 위치·정렬 순서 | ④ | S | 문구가 판정에 쓰이면 ①의 상수로 |
| 목록에 열 하나 추가 (이미 있는 값) | ①③④ | S | 응답 뷰 타입이 ①에 있으므로 거기도 넓힌다 |
| 새 화면 (기존 데이터를 다르게 보여줌) | ③④⑤ | M | 권한 판정을 새로 만들지 말고 기존 함수를 쓴다 |
| 입력 항목 하나 추가 | ①②③④⑤ | L | 기존 행의 빈 값을 시드가 채우는지 확인 |
| 새 개체 (예: 문서 템플릿) | 전부 | L | 감사 이벤트 종류와 권한 행위를 ①에 먼저 등재 |
| 정책값 조절 (세션 시간·업로드 상한) | 설정만 | S | `CLAUDE.md` 5절 세 갈래 중 어디인지 먼저 판정 |
| 권한 규칙 변경 | ① + 그 테스트 | M | `permissions.ts` 한 곳만 고친다. 화면·서버가 따라온다 |
| 편집기 기능 추가 (표·각주 등) | ① + ④ | M | **허용 목록과 편집기 확장을 같은 커밋에서 넓히고 문서 스키마 버전을 올린다** |
| 인증 방식 추가 (SAML 등) | 6절 축 | M | 주입 토큰 뒤에 구현을 더한다. 상위 로직은 안 바뀐다 |
| 첨부 저장 위치 변경 (NAS·S3) | 6절 축 | M | 같음 |
| 검색 엔진 교체 | 6절 축 | M | 같음. 색인은 파생 데이터라 재생성 가능하다 |
| 외부 시스템 알림 (메일·메신저) | ③ + 설정 | M | 폐쇄망에서 닿는 곳인지 먼저 확인 |

### 11.3 값을 추가할 때 함께 고쳐야 하는 짝

하나만 고치면 조용히 어긋나는 짝들이다. **같은 커밋에서** 함께 고친다.

| 고친 것 | 함께 고칠 것 | 안 하면 |
|---|---|---|
| 환경변수 추가·개명 | `.env.example` · 그 Phase 설계서의 설정 항목 표 · `deploy/compose.yml` | 기동 실패 또는 운영에서만 값이 빈다 |
| 감사 이벤트 종류 추가 | `constants.ts`의 목록 · 기록하는 지점 | 기록이 안 남거나 과거 로그와 이름이 어긋난다 |
| 권한 행위 추가 | `permissions.ts`의 허용 표 · 엔드포인트 가드 | 기본 거부라 아무도 못 쓴다 |
| 편집기 확장 추가 | 문서 허용 목록 · 문서 스키마 버전 | 사용자가 만든 문서를 서버가 400으로 거부한다 |
| 테이블 컬럼 추가 | 마이그레이션 SQL · 시드의 빈 값 채우기 | 기존 행이 비어 있는 채로 남는다 |
| API 응답 모양 변경 | `schemas.ts`의 뷰 타입 · 화면 | 타입 검사는 통과하고 화면만 깨진다 |

### 11.4 확장을 싸게 유지하는 규칙

- **판정은 한 곳에서.** 권한·정책 판정을 화면에서 다시 구현하지 않는다. 서버가 응답에 판정 결과를 실어 보내고 화면은 그대로 쓴다.
- **교체 가능한 축은 인터페이스 뒤에.** 6절의 다섯 축은 구현을 갈아도 상위 로직이 안 바뀐다. 새 기능이 그 축에 걸리면 축을 늘리지 말고 구현을 더한다.
- **파생 데이터는 재생성 가능하게.** 검색 색인처럼 원본에서 다시 만들 수 있는 것은 정본으로 취급하지 않는다.
- **새 문서 종류를 만들기 전에 기존 문서에 절을 더할 수 없는지 본다** (`CLAUDE.md` 10절).
- **순환 참조를 만들지 않는다.** 두 모듈이 함께 쓰는 변환 함수는 제3의 파일로 뺀다. CommonJS에서 순환이 생기면 타입 검사는 통과하고 기동만 실패한다 (2.1절).

### 11.5 확장을 비싸게 만드는 것 — 피할 것

| 피할 것 | 왜 |
|---|---|
| 화면에만 규칙을 넣는 것 | 서버가 막지 않으면 보안이 아니고, 서버가 따로 막으면 규칙이 둘이 된다 |
| 설정 키를 만들고 배선하지 않는 것 | 값을 바꿔도 아무 일이 없다. 로그는 "읽었다"만 보여준다 |
| 호출자 없이 계약을 미리 늘리는 것 | 검증되지 않은 계약이 쌓인다. Phase 0에서 이미 한 번 겪었다 (`CLAUDE.md` 보류 10) |
| 되돌리기 스크립트에 의존하는 것 | 잘못된 되돌리기가 데이터를 더 잃게 만든다. 되돌림은 백업 복원이다 |
| 예외 목록으로 관문을 통과시키는 것 | 증상만 지우고 원인이 남아 다음 실패를 예약한다 |

## 12. 관련 문서

| 문서 | 관계 |
|---|---|
| [`docs/scope-definition.md`](scope-definition.md) | 상위 — 무엇을·왜 |
| [`CLAUDE.md`](../CLAUDE.md) | 규칙 |
| [`docs/P0_설계서_Foundation.md`](P0_설계서_Foundation.md) | Phase 0 요구사항과 상세 설계 |
| [`docs/학습가이드_시스템이해.md`](학습가이드_시스템이해.md) | 개발 용어 없이 읽는 설명 |
| [`docs/운영가이드_장애대응.md`](운영가이드_장애대응.md) | 증상에서 조치로 |
| [`docs/기능백로그.md`](기능백로그.md) | 기능 요청 접수 상태 |
