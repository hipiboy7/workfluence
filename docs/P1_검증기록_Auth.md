# P1_검증기록_Auth — 인증·사용자·권한 골격 검증

- 상위 문서: [`docs/P1_설계서_Auth.md`](P1_설계서_Auth.md)
- 규칙: [`CLAUDE.md`](../CLAUDE.md) 4절 3단계 산출물. **수치와 실제 출력만 쓴다.** 시행착오의 경위는 [`docs/internal/검토서_트러블슈팅.md`](internal/검토서_트러블슈팅.md)에 있다
- 실행일: 2026-09-21 / 실행 환경: 사내 Linux 작업 서버 (`CLAUDE.md` 0.3절) / 작성 LLM: Claude Opus 5
- 결과: **인수 기준 셋 모두 충족.** 단 **실 IdP 연동은 미확인**이다 (보류 11)

---

## 1. 실행 환경과 명령

| 항목 | 값 |
|---|---|
| 작업 서버 | RHEL 9.6, 2코어, 7.5GB RAM, 디스크 39GB (여유 15GB) |
| Node.js | v24.21.0 (빌드 이미지와 같은 버전) |
| pnpm | 12.4.1 |
| PostgreSQL | 17.10 (임베디드, `.local/pgdata`) / 컨테이너 postgres:17 |
| 브라우저 | Chromium (Playwright, `.local/ms-playwright`) |
| Docker | 29.6.1 / Compose v5.3.1 |
| 환경변수 | 25개 키 (Phase 0 12 + Phase 1 13) |

```bash
pnpm check:env
pnpm db:migrate
pnpm db:seed
pnpm check
pnpm test:cov
pnpm test:e2e
```

## 2. 테스트 건수와 커버리지

| 대상 | 건수 | 커버리지 |
|---|---|---|
| `packages/shared` | 58 (Phase 0 52 + 환경 규칙 6) | — |
| `apps/api` | 83 (Phase 0 18 + 신규 65) | **문장 86.4% · 브랜치 79.5% · 함수 81.5% · 라인 89.8%** |
| `apps/api/src/auth/domain` (A등급) | 29 | 임계 90% 통과 |
| E2E (`e2e/`) | 7 | 측정 제외 |
| skip | **0** | |

신규 65건의 내역: A등급 순수 함수 29(claims 10·lockout 19 — **테스트를 먼저 썼다**), 가드 14,
감사 마스킹 4, 모의 제공자 5, **실제 PostgreSQL 통합 22**.

### 2.1 커버리지에서 뺀 것과 이유

| 뺀 것 | 이유 |
|---|---|
| `apps/api/src/auth/oidc/http.provider.ts` | **실 IdP 없이는 의미 있는 테스트를 쓸 수 없다** (확인 필요 A). 모의로 감싸 통과시키면 "테스트가 있다"는 착각만 남는다. 보류 11에서 실연동과 함께 본다 |
| `apps/api/src/**/*.module.ts` | 컨트롤러가 하는 일은 트랜잭션 안에서 서비스와 감사를 부르는 배선이고 그 둘은 각각 측정된다. **배선이 맞는지는 E2E가 본다** — 그래서 E2E가 없으면 이 제외가 곧 구멍이다 |

## 3. 인수 기준 검증

### 3.1 가입 요청 → 승인 → 로그인 (브라우저)

`pnpm test:e2e` 7건 전부 통과. 주 시나리오가 확인한 것:

```
가입 요청 접수 → 승인 전 로그인 401("아이디 또는 비밀번호가 올바르지 않다")
→ 관리자가 pending을 승인 → active → 그 계정으로 로그인 성공
→ 일반 사용자에게 관리 메뉴가 보이지 않음 → 비밀번호 변경 성공
```

### 3.2 IdP 로그인과 역할 매핑

**모의 OIDC 제공자로 확인했다.** 실 IdP는 접근할 수 없다 (확인 필요 A).

```
GET /api/auth/oidc/start  → 302, state·nonce를 세션에 보관
GET /api/auth/oidc/callback → 302 /
GET /api/auth/me → {"username":"idp.dev","role":"member","mustChangePassword":false}
```

`groups: ["wf-users"]` → `WF_OIDC_ROLE_MAP`에 따라 `member`. 계정은 JIT 생성됐고
`password_hash`는 null이다.

거부 경로도 확인했다.

| 조건 | 결과 |
|---|---|
| `state` 변조 | `401 {"message":"state가 일치하지 않는다"}` |
| 매핑되는 그룹 없음 | `401 {"message":"이 계정에 부여할 역할이 없다"}` |
| IdP 계정으로 비밀번호 로그인 | `401` (로컬 로그인과 같은 문구) |
| 같은 `sub`로 재로그인 | 계정이 늘지 않고 역할이 IdP 값으로 갱신됨 |
| `username`이 이미 쓰임 | `idp.dev1`로 생성. **로컬 계정과 합치지 않는다** |

### 3.3 두 경로 모두 감사로그에 남는다

```
auth.login.success     {"method": "local"}
auth.login.success     {"method": "oidc"}
auth.login.failure     {"reason": "no_role_mapped"}
auth.login.failure     {"reason": "pending"}
user.signup            {"email": "al***@example.internal", "username": "alice"}
user.approve           {"username": "alice"}
auth.password.change   null
```

`email`이 마스킹돼 있다 (FR-238). 실패 사유는 **기록에만** 있고 응답에는 나가지 않는다.

## 4. 보안 규칙 실호출 확인

| 항목 | 확인 | 결과 |
|---|---|---|
| 계정 열거 방지 (FR-206) | 없는 계정 / 틀린 비밀번호 / 승인 대기 | 셋 다 `401 {"message":"아이디 또는 비밀번호가 올바르지 않다"}` — 본문이 동일 |
| 응답 시간 (2.2절) | argon2 verify | 일치 85ms / 불일치 85ms. 없는 계정도 더미 해시로 한 번 돌린다 |
| CSRF (FR-240) | 헤더 없이 POST | `403` |
| 비밀번호 변경 강제 (FR-207) | 강제 상태로 `/api/users` | `403 {"code":"PASSWORD_CHANGE_REQUIRED"}`. `/api/auth/me`는 200 |
| 권한 (FR-237) | member로 `/api/audit`·`/api/users` | 둘 다 `403` |
| 잠금 (FR-205) | 5회 실패 후 올바른 비밀번호 | `401`. 관리자 화면에 `locked`로 파생 표시 |
| ID 찾기 (FR-208) | 일치 / 불일치 | `{"username":"al**e"}` / `{"username":null}` — 모양이 같다 |
| append-only (FR-239) | `UPDATE`/`DELETE audit_events` | `audit_events는 append-only다 (시도: UPDATE)` / `(시도: DELETE)` |

## 5. 비기능 실측

| # | 항목 | 목표 | 실측 | 판정 |
|---|---|---|---|---|
| NFR-11 | A등급 커버리지 | ≥90% | 임계 통과 (`auth/domain`) | 충족 |
| NFR-12 | api 커버리지 | ≥70% | 86.4% 문장 / 89.8% 라인 | 충족 |
| NFR-13 | argon2 해싱 | <500ms | 해시 87ms · 검증 85ms (2코어) | 충족 |
| NFR-14 | 로그인 p95 | <1초 | 컨테이너에서 110ms (argon2 포함) | 충족 |
| NFR-15 | 이식성 | 두 OS 동일 명령 | Linux에서 전 명령 동작 (Windows는 P0 기록) | 충족 |
| NFR-16 | 보안 점검 | `/security-review` 통과 | 6절 | — |

## 6. 컨테이너 빌드·기동

`CLAUDE.md` 1.1절 4단계 — 의존성을 건드린 Phase라 Linux 빌드까지 확인한다.

| 항목 | 값 |
|---|---|
| 빌드 | 30초, 종료 코드 0 |
| 이미지 크기 | **388MB** (Phase 0 384MB → argon2·jose·react-router 추가분 4MB). 예산 400MB 이내 |
| 기동 시간 | **12초** (목표 30초 이내) |
| 마이그레이션 | `[migrate] 2개 마이그레이션 적용 상태` |
| 시드 | `[seed] root 계정 생성: root (첫 로그인에서 비밀번호 변경 강제)` |
| 헬스체크 | `HTTP 200 {"status":"ok","db":"ok",...}` |
| 컨테이너 로그인 | `201` · 소요 110ms — **argon2 네이티브 모듈이 런타임 이미지에서 동작한다** |
| CSRF | 헤더 없이 `403` |

## 7. 확인하지 못한 것

**이 절이 이 문서에서 가장 중요하다.** 통과한 것보다 통과하지 못한 것이 다음 일을 정한다.

| # | 확인 못 한 것 | 왜 | 언제 |
|---|---|---|---|
| 1 | **실 사내 IdP 연동** | 작업 서버가 IdP에 나갈 수 없다 (확인 필요 A). 모의 제공자로 흐름만 봤다 | 보류 11. 접근이 열리는 날 |
| 2 | IdP의 `groups` 실제 형태 | 위와 같다. 배열·문자열·CSV 셋 다 받도록 해 뒀지만 **실제로 무엇이 오는지는 모른다** | 보류 11 |
| 3 | PKCE 실제 동작 | IdP가 지원하는지 모른다 (보류 1). 설정으로 켜고 끄게만 해 뒀다 | 보류 11 |
| 4 | `HttpOidcProvider` 코드 경로 | 실 IdP 없이 의미 있는 테스트를 쓸 수 없어 커버리지에서 뺐다 | 보류 11 |
| 5 | 세션 절대 타임아웃 12시간 실경과 | 12시간을 기다려 확인하지 않았다. 가드 단위 테스트가 경계를 본다 | Phase 5 운영화 |
| 6 | 동시 사용자 부하 | Phase 5 부하 테스트 | Phase 5 |
| 7 | 비밀번호 정책의 사내 기준 부합 | 확인 필요 B가 열려 있다. 기본값(8자·2종)을 쓰고 있다 | 정책 확인 후 |

**모의 서버 통과를 연동 완료로 적지 않는다** (`CLAUDE.md` 9.1절). 1~4번이 닫히기 전에는
Phase 1의 OIDC는 "우리 쪽 준비가 끝났다"까지다.

## 8. Phase 2 인계 사항

| 항목 | 내용 |
|---|---|
| 스페이스 권한 | `spaceAccess()`가 `shared`에 이미 있다. 가드가 멤버십을 모아 넘기는 부분이 Phase 2 |
| `space_categories.created_by` | `users(id)` FK로 연결한다 |
| 감사 액션 | `space.*`·`page.*`가 `AUDIT_ACTIONS`에 이미 있다. 호출부만 붙인다 |
| E2E 픽스처 | `e2e/fixtures.ts`의 "자기 계정을 직접 만든다"를 재사용한다 |
| 커버리지 제외 | `*.module.ts`를 뺀 만큼 E2E가 메워야 한다. 새 컨트롤러도 같은 규칙이다 |
| 미확인 1~4 | Phase 2가 끝나도 그대로면 보류 표에서 다시 본다 |
