# P1_설계서_Auth — 인증·사용자·권한 골격

- 상위 문서: [`docs/설계서_Architecture.md`](설계서_Architecture.md), [`docs/scope-definition.md`](scope-definition.md)
- 규칙: [`CLAUDE.md`](../CLAUDE.md) 4절 1단계 산출물. 요구사항 + 설계를 한 문서에 둔다
- 작성일: 2026-09-21 / 개정: 2026-09-21 (보안 점검 반영 — 2.4절) / 작성 LLM: Claude Opus 5
- 인수 기준(`scope-definition.md` 5절): **가입 요청한 계정을 관리자가 승인하면 로그인된다. IdP 계정으로 로그인하면 그룹이 역할로 매핑된다. 두 경로 모두 감사로그에 남는다**

---

# A. 요구사항

## A.0 착수 시 확정한 쟁점 (2026-09-21)

| # | 쟁점 | 확정 | 근거 |
|---|---|---|---|
| 1 | 사내 IdP에 지금 접근할 수 있는가 (확인 필요 A) | **모른다. 접근 불가로 가정하고 진행한다** | 사용자 지시 "미결은 설정으로". 실연동 확인은 접근이 열리는 날로 미룬다 |
| 2 | IdP가 PKCE를 지원하는가 (보류 1) | **설정으로 둔다.** `WF_OIDC_PKCE`로 on/off | 보류 1이 이미 "코드는 PKCE on/off를 설정으로 둔다"로 판정 방법을 정해 뒀다 |
| 3 | 그러면 Phase 1을 어떻게 닫나 | **OIDC 제공자를 DIP 경계 뒤에 두고, 개발·테스트는 모의 OIDC 서버로 검증한다.** 실 IdP 연동은 이 Phase의 검증기록(docs/P1_검증기록_Auth.md — 이 Phase에서 만든다)에 **미확인**으로 남긴다 | `CLAUDE.md` 9.1절 "모의 서버 통과는 완료가 아니다". 완료로 적지 않는 것이 규칙을 지키는 방법이다 |
| 4 | 프로토타입 코드를 어디까지 가져오나 | 로컬 인증·사용자 관리·감사로그는 **근거를 다시 세워** 승격한다. OIDC와 테스트는 **신규** | 1.5절. 프로토타입에 OIDC와 api 테스트가 없다 |

> **쟁점 1·2가 열린 채로 Phase를 닫는 것이 맞는가.** 맞다. 둘 다 **우리가 정할 수 없는 것**이고,
> 기다리면 Phase 2 이후가 전부 막힌다. 대신 **열린 채로 둔 것을 열린 채로 적는다** — 완료 기준(A.6)에서
> 실 IdP 연동을 제외하고, 보류 표에 판정 방법과 이정표를 남긴다.

## A.1 목적

로그인할 수 있게 만든다. 이후 모든 Phase가 "누가 요청했는가"에 의존하므로, **사용자·세션·권한 판정·감사로그**가 먼저 있어야 한다.

## A.2 배경과 제약

| 제약 | 출처 | 설계에 준 영향 |
|---|---|---|
| 인증 경로가 둘 (로컬 ID/PW + 사내 IdP OIDC) | `CLAUDE.md` 0.2절 | 두 경로가 **같은 `users` 행**으로 수렴한다. 세션은 경로와 무관하게 하나 |
| 세션은 서버측 PG 테이블 | `CLAUDE.md` 0.2절·7절 | `connect-pg-simple`. 관리자 강제 종료가 가능해야 하므로 JWT를 쓰지 않는다 |
| 권한 판정은 `packages/shared` 한 곳 | `CLAUDE.md` 7절 | 가드는 데이터를 모아 `can()`에 넘기고 결과만 쓴다. 판정 로직을 가드에 두지 않는다 |
| 감사로그 append-only | `CLAUDE.md` 6절 | 앱 계정에 INSERT만 + 트리거로 UPDATE/DELETE 차단 |
| 계정 열거 방지 | `CLAUDE.md` 7절 | ID 찾기는 email+이름 일치 시 **마스킹된 ID만**. 로그인 실패 사유를 구분해 알리지 않는다 |
| 저장소 public | `CLAUDE.md` 12.3절 | 문서의 IdP 주소는 `https://idp.example.internal` placeholder. 실값은 `.env` |
| 개발 서버가 IdP에 못 나갈 수 있다 | 확인 필요 A | OIDC 제공자를 교체 가능한 경계로. 개발은 모의 제공자 |

## A.3 범위

**이번에 만드는 것**

- `users`·`sessions`·`audit_events` 테이블과 마이그레이션. `settings.updated_by` FK 추가 (P0 인계)
- 로컬 인증: 가입 요청 → 관리자 승인 → 로그인. 비밀번호 정책·잠금·변경 강제
- 계정 복구: ID 찾기(마스킹), 비밀번호 초기화 **요청**(관리자가 처리 — 2.4절)
- OIDC 인증: Discovery, Authorization Code, `state`·`nonce`, PKCE 설정, `groups` → 역할 매핑, JIT 동기화
- 세션: 서버측 PG, 유휴·절대 타임아웃, 로그아웃·비밀번호 변경 시 파기
- 사용자 관리(관리자): 목록·생성·승인·역할 변경·잠금 해제·비밀번호 초기화
- 감사로그: 기록과 조회(관리자)
- 요청 보호: CSRF 헤더 요구, 공개 엔드포인트 IP 요청 제한
- 화면: 로그인, 가입 요청, ID/비밀번호 찾기, 비밀번호 변경, 관리자 사용자 목록, 감사로그

**이번에 만들지 않는 것**

| 제외 | 왜 | 언제 |
|---|---|---|
| 스페이스·페이지 권한 | 대상 테이블이 없다 | Phase 2 |
| 권한 세분화·위임 | 역할 3종으로 충분하다 | Phase 4 |
| 알림 | 알림함 테이블이 Phase 4다 | Phase 4 |
| **실 IdP 연동 확인** | 접근 불가 (쟁점 1) | 접근이 열리는 날. 보류 표에 등재 |
| 비밀번호 만료·이력 | 사내 정책 미확인 (확인 필요 B) | 정책 확인 후 |

## A.4 기능 요구사항

### 로컬 인증 (FR-200 ~ FR-209)

| # | 요구사항 | 근거 |
|---|---|---|
| FR-200 | 가입 요청은 `username`·`displayName`·`email`·`password`를 받아 `status='pending'`으로 만든다 | 인수 기준 |
| FR-201 | 관리자가 승인하면 `status='active'`, `approved_at/by`가 기록되고 그때부터 로그인된다 | 인수 기준 |
| FR-202 | 로그인은 `status='active'`이고 잠금 중이 아닌 계정만 통과한다 | `CLAUDE.md` 7절 |
| FR-203 | 비밀번호는 argon2id로 저장한다. 평문·가역 암호를 쓰지 않는다 | `CLAUDE.md` 7절 |
| FR-204 | 정책 위반 비밀번호는 거부한다 (8자 이상, 4종 중 2종 이상) | `PASSWORD_POLICY` |
| FR-205 | 연속 5회 실패 시 15분 잠금. 성공하면 실패 횟수를 0으로 되돌린다 | `PASSWORD_POLICY` |
| FR-206 | **로그인 실패 응답은 사유를 구분하지 않는다.** 없는 계정·틀린 비밀번호·승인 대기가 같은 응답 | 계정 열거 방지 |
| FR-207 | `must_change_password`인 사용자는 비밀번호를 바꾸기 전까지 다른 API를 쓸 수 없다 | `CLAUDE.md` 7절 |
| FR-208 | ID 찾기는 `email`+`displayName`이 모두 일치할 때만 **마스킹된 username**을 준다. 불일치도 같은 응답 형태 | 계정 열거 방지 |
| FR-209 | **관리자** 초기화는 임시 비밀번호를 응답에 1회만 싣고 `must_change_password`를 켠다. 저장하지 않는다 | `CLAUDE.md` 7절 |
| FR-209a | **미인증 비밀번호 찾기는 비밀번호를 발급하지 않는다.** 요청을 감사로그에 남기고 관리자에게 보낸다. 응답은 일치 여부와 무관하게 동일 | 2.4절 |
| FR-209b | IdP 계정(`oidc_sub` 있음)에는 비밀번호를 부여하지 않는다. 관리자 초기화도 거부한다 | FR-217을 초기화가 뚫지 않게 |

### OIDC 인증 (FR-210 ~ FR-219)

| # | 요구사항 | 근거 |
|---|---|---|
| FR-210 | 엔드포인트는 Discovery(`/.well-known/openid-configuration`)로 얻고 캐시한다. URL을 하드코딩하지 않는다 | `CLAUDE.md` 9.1절 |
| FR-211 | Authorization Code Flow. `state`·`nonce`를 생성해 세션에 보관하고 콜백에서 대조한다 | `CLAUDE.md` 9.1절 |
| FR-212 | PKCE는 `WF_OIDC_PKCE`로 켜고 끈다. 켜면 `S256` | 보류 1 |
| FR-213 | `id_token` 검증: 서명(RS256, JWKS `kid` 캐시, 미지 `kid`면 **1회만** 재조회)·`iss`·`aud`·`exp`·`nonce` | `CLAUDE.md` 9.1절 |
| FR-214 | `redirect_uri`는 설정값을 **그대로** 보낸다. 요청 헤더로 조립하지 않는다 | `CLAUDE.md` 9.1절 |
| FR-215 | 클레임 `sub`를 사용자 키로 쓴다. `users.oidc_sub`가 있으면 그 계정, 없으면 JIT 생성 | `CLAUDE.md` 9.1절 |
| FR-216 | `groups` 클레임을 역할로 매핑한다. 매핑표는 설정(`WF_OIDC_ROLE_MAP`) | 인수 기준 |
| FR-217 | JIT 생성 계정은 `status='active'`, `password_hash=null`이다. **비밀번호 로그인을 할 수 없다** | 두 경로 혼동 방지 |
| FR-218 | 매핑 결과가 어느 역할도 아니면 로그인을 거부한다. 기본 거부 | `CLAUDE.md` 7절 |
| FR-219 | OIDC가 꺼져 있으면(`WF_OIDC_ENABLED=false`) 관련 엔드포인트가 404다. 화면도 버튼을 감춘다 | 확인 필요 A |

### 세션 (FR-220 ~ FR-225)

| # | 요구사항 | 근거 |
|---|---|---|
| FR-220 | 세션은 PG 테이블에 둔다. 저장소는 `connect-pg-simple`이 `PG_POOL`을 재사용한다 | P0 인계 |
| FR-221 | 쿠키는 `HttpOnly; SameSite=Lax`. `WF_ENV=production`이면 `Secure` | `CLAUDE.md` 7절 |
| FR-222 | 유휴 타임아웃 기본 30분 (`rolling`). 설정은 `WF_SESSION_IDLE_MINUTES` | `CLAUDE.md` 7절 |
| FR-223 | 절대 타임아웃 기본 12시간. 세션 생성 시각으로 가드가 판정한다 | `CLAUDE.md` 7절 |
| FR-224 | 로그아웃 시 그 세션을, 비밀번호 변경·초기화 시 **그 사용자의 모든 세션**을 파기한다 | `CLAUDE.md` 7절 |
| FR-225 | 로그인 성공 시 세션 ID를 재발급한다 (세션 고정 공격 방지) | 일반 보안 관행 |

### 사용자 관리·감사 (FR-230 ~ FR-239)

| # | 요구사항 | 근거 |
|---|---|---|
| FR-230 | 관리자는 사용자 목록을 본다. `잠김`은 저장값이 아니라 `locked_until`에서 파생해 표시한다 | 데이터 모델 |
| FR-231 | 관리자는 계정을 직접 생성한다. 임시 비밀번호 1회 표시 + `must_change_password` | FR-209와 같은 규칙 |
| FR-232 | 역할 변경은 `user.role.change` 권한이 있고 **대상보다 우위**일 때만. `root`는 `root`만 부여 | `CLAUDE.md` 7절 |
| FR-233 | 자기 자신의 역할을 낮추거나 마지막 `root`를 강등할 수 없다 | 잠금 방지 |
| FR-234 | 잠금 해제는 `failed_attempts=0`, `locked_until=null` | |
| FR-235 | 아래 행위를 감사로그에 남긴다: 로그인 성공·실패, 로그아웃, 비밀번호 변경·복구, ID 찾기, 가입, 계정 생성·승인·잠금해제·초기화·역할변경 | `CLAUDE.md` 6절 |
| FR-236 | 감사 기록은 **본 작업과 같은 트랜잭션**에서 쓴다. 작업이 롤백되면 기록도 롤백된다 | 기록과 사실의 불일치 방지 |
| FR-237 | 감사로그 조회는 `audit.read` 권한자만 | `CLAUDE.md` 7절 |
| FR-238 | 감사로그에 비밀번호·토큰·세션 ID를 남기지 않는다. email은 마스킹한다 | `CLAUDE.md` 7절 |
| FR-239 | `audit_events`는 트리거로 UPDATE/DELETE를 차단한다 | `CLAUDE.md` 6절 |

### 요청 보호·화면 (FR-240 ~ FR-249)

| # | 요구사항 | 근거 |
|---|---|---|
| FR-240 | 상태 변경 요청(POST/PUT/PATCH/DELETE)에 `CSRF_HEADER`를 요구한다. 없으면 403 | `CLAUDE.md` 7절 |
| FR-241 | 공개 엔드포인트에 IP 기준 요청 제한을 건다 (`RATE_LIMITS`) | `CLAUDE.md` 7절 |
| FR-242 | 화면: 로그인 / 가입 요청 / ID 찾기 / 비밀번호 찾기 / 비밀번호 변경 | 인수 기준 |
| FR-243 | 화면: 관리자 사용자 목록(승인·역할변경·잠금해제·초기화), 감사로그 | 인수 기준 |
| FR-244 | 로그인하지 않은 상태로 보호된 화면에 가면 로그인으로 보낸다 | |
| FR-245 | `must_change_password`면 비밀번호 변경 화면에서 나갈 수 없다 | FR-207의 화면 쪽 |

## A.5 비기능 요구사항

| # | 항목 | 목표 |
|---|---|---|
| NFR-11 | A등급 커버리지 | `packages/shared` 변경분과 `apps/api/**/domain/**` 라인·브랜치 **≥ 90%** |
| NFR-12 | B등급 커버리지 | `apps/api` **≥ 70%**. 통합 테스트는 **실제 PostgreSQL** |
| NFR-13 | 비밀번호 해싱 비용 | argon2id 기본 파라미터로 로그인 1회 **< 500ms** (2코어 기준 실측) |
| NFR-14 | 로그인 응답 시간 | p95 < 1초 (개발 서버 실측) |
| NFR-15 | 이식성 | Windows·Linux 양쪽에서 같은 `pnpm` 명령 (P0 NFR-06 유지) |
| NFR-16 | 보안 점검 | `/security-review` 통과. `CLAUDE.md` 1.1절 5단계에서 Phase 1은 **필수** |

## A.6 완료 기준

| # | 기준 | 확인 방법 |
|---|---|---|
| 1 | 가입 요청 → 관리자 승인 → 로그인이 브라우저에서 된다 | E2E |
| 2 | **모의 OIDC**로 로그인하면 `groups`가 역할로 매핑된다 | 통합 테스트 + E2E |
| 3 | 두 경로 모두 감사로그에 남는다 | 통합 테스트 |
| 4 | `pnpm check` 통과, A등급 ≥90% / api ≥70% | CI |
| 5 | Linux 서버에서 이미지 빌드 → 기동 → 로그인 | `docs/운영가이드_리눅스빌드.md` |
| 6 | `/security-review` 지적 처리 완료 | 자체 점검 검토서 docs/internal/P1_검토서_SelfReview.md (이 Phase에서 만든다) |

**완료 기준이 아닌 것: 실 IdP 연동.** 접근할 수 없다 (쟁점 1). 보류 표에 남기고 접근이 열리면 확인한다. **모의 서버 통과를 연동 완료로 적지 않는다** (`CLAUDE.md` 9.1절).

## A.7 리스크

| # | 리스크 | 완화 |
|---|---|---|
| 1 | 실 IdP의 클레임 이름·형태가 가정과 다르다 | 클레임 이름을 설정으로. `groups`가 배열이 아닌 경우(문자열·CSV)도 파싱 |
| 2 | 모의 서버로만 검증해 실연동에서 깨진다 | **리스크를 없애지 못한다.** 완료로 적지 않는 것으로 다룬다 |
| 3 | argon2 네이티브 모듈이 2코어 서버에서 느리다 | NFR-13으로 실측. 초과하면 파라미터를 설정으로 빼낸다 |
| 4 | 세션 저장소와 앱이 같은 PG를 쓰므로 DB 장애가 곧 로그아웃 | 단일 DB 전제(0.1절)에서 수용. 헬스체크가 먼저 알린다 |

---

# B. 제품 기준 대조 (Confluence)

| 항목 | Confluence | 우리 | 이유 |
|---|---|---|---|
| 가입 | 관리자 초대 또는 자가 가입(설정) | **가입 요청 → 관리자 승인** | 금융 폐쇄망. 자가 가입이 그대로 활성화되면 통제가 없다 |
| 외부 인증 | SAML·OIDC·LDAP | **OIDC만** | 사내 IdP가 OIDC다. SAML은 DIP 경계 뒤라 나중에 더할 수 있다 |
| 역할 | 전역 권한 + 그룹 | **역할 3종(root/admin/member) + 스페이스 Crew** | 300명 규모에 그룹 체계는 과하다. Crew는 Phase 2 |
| 세션 | 토큰 기반 + 서버 세션 | **서버 세션만** | 관리자 강제 종료가 요구된다. JWT는 즉시 무효화가 어렵다 |
| 감사 | 유료 기능 | **기본 포함, append-only** | 금융권 요구 |
| 비밀번호 정책 | 관리자 설정 | **상수 + Phase 4에서 DB 설정** | 사내 정책 미확인(확인 필요 B). 구조만 열어 둔다 |

---

# 0. 모듈 구성과 등급

| 모듈 | 경로 | 등급 | 하는 일 |
|---|---|---|---|
| 역할·정책 판정 | `packages/shared/src/permissions.ts` | **A** | `can`, `canAssignRole`, `canManageUser`, `checkPasswordPolicy` — **P0에 이미 있다** |
| 계정 복구 순수 함수 | `packages/shared/src/security.ts` | **A** | `maskUsername`, `maskEmail`, `generateTemporaryPassword` — **P0에 이미 있다** |
| OIDC 클레임 매핑 | apps/api/src/auth/domain/claims.ts | **A (신규)** | `groups` → `Role`. 순수 함수. 배열·문자열·CSV를 모두 받는다 |
| 잠금 판정 | apps/api/src/auth/domain/lockout.ts | **A (신규)** | 실패 횟수·시각 → 잠금 여부·해제 시각. 시계를 주입받는다 |
| 인증 서비스 | apps/api/src/auth/auth.service.ts | B | 로그인·로그아웃·가입·복구. 해싱은 여기 |
| OIDC 제공자 | apps/api/src/auth/oidc/ | B | Discovery·토큰 교환·검증. **DIP 경계** |
| 가드 | apps/api/src/auth/auth.guard.ts | B | 세션 확인 → 사용자 적재 → `can()` 호출 |
| 사용자 | apps/api/src/users/ | B | 목록·생성·승인·역할·잠금해제·초기화 |
| 감사 | apps/api/src/audit/ | B | 기록·조회 |
| 화면 | apps/web/src/ | B | 측정·기록만 (3절) |

## 0.1 의존 방향

```
web ─→ shared ←─ api
              ↑
        api/auth/domain (순수)
              ↑
        api/auth/oidc (IdP 어댑터, 교체 가능)
```

`auth.service`는 `OidcProvider` **인터페이스**에만 의존한다. 구현은 `HttpOidcProvider`(실제)와 `MockOidcProvider`(개발·테스트) 둘이다. 이것이 확인 필요 A를 막힌 채로 진행할 수 있게 하는 유일한 장치다 (`CLAUDE.md` 2절 DIP).

---

# 1. 데이터 모델 (FR-200, FR-215, FR-239)

`docs/설계서_Architecture.md` 3.1절이 단일 출처다. 이번 Phase가 만드는 것만 적는다.

| 테이블 | 이번에 하는 일 |
|---|---|
| `users` | 신설. 3.1절 컬럼 + **`oidc_sub` text unique nullable** (FR-215) |
| `sessions` | 신설. `connect-pg-simple` 표준 스키마(`sid`·`sess`·`expire`) |
| `audit_events` | 신설. + UPDATE/DELETE 차단 트리거 (FR-239) |
| `settings.updated_by` | `users(id)` FK 추가 (P0 인계) |

> **`oidc_sub`를 3.1절 표에 더한다.** 표에 없는 컬럼을 코드에 두지 않는다. 같은 커밋에서 아키텍처 문서를 고친다.

`password_hash`와 `oidc_sub`는 **둘 다 null 가능**하다. 로컬 계정은 앞의 것만, IdP 계정은 뒤의 것만 갖는다. 둘 다 null인 행은 만들지 않는다 — CHECK 제약으로 막는다.

---

# 2. 로컬 인증 (FR-200 ~ FR-209)

## 2.1 흐름

```
가입요청 → users(status=pending)          → 감사 user.signup
관리자 승인 → status=active, approved_*     → 감사 user.approve
로그인 → 잠금 확인 → argon2 verify → 세션 재발급 → 감사 auth.login.success
       실패 → failed_attempts++ → 임계 도달 시 locked_until → 감사 auth.login.failure
```

## 2.2 실패 응답을 하나로 (FR-206)

없는 계정·틀린 비밀번호·승인 대기·잠금을 **모두 같은 401 본문**으로 답한다.

```
{ "message": "아이디 또는 비밀번호가 올바르지 않다" }
```

잠금 중일 때만 남은 시간을 알려 주고 싶은 유혹이 있는데, 그러면 **그 아이디가 존재한다는 사실이 새어 나간다.** 사용자 편의보다 열거 방지를 택한다. 잠긴 사실은 관리자 화면에서만 보인다.

> **응답 시간으로도 새어 나간다.** 없는 계정은 해시 검증을 건너뛰어 빨리 답한다. 그래서 **계정이 없을 때도 더미 해시로 verify를 한 번 돌린다.** 테스트로 두 경로의 시간차를 확인한다.

## 2.3 비밀번호 저장 (FR-203)

argon2id. 라이브러리는 `argon2`(네이티브, prebuilt 있음 — `allowBuilds`에 추가). 파라미터는 라이브러리 기본값을 쓰고 NFR-13으로 실측한다. 해시 문자열에 파라미터가 포함되므로 나중에 올려도 기존 해시를 읽을 수 있다.

## 2.4 미인증 비밀번호 찾기를 없앤 이유 (FR-209a, 2026-09-21 개정)

**처음 설계에서는 아이디와 email이 맞으면 임시 비밀번호를 응답으로 돌려줬다.** 보안 점검에서
이것이 계정 탈취 경로로 지적됐고, 확인해 보니 맞았다.

문제는 **확인 지식이 비밀이 아니라는 것**이다. 사내 위키에서 동료의 아이디와 사내 메일 주소는
사실상 공개 정보다. "둘을 아는 사람 = 본인"이 성립하지 않는다. 그런데 그 둘만 넣으면

1. 피해자의 비밀번호가 **즉시 덮어써지고** (원래 사용자는 로그인 불가)
2. 그 평문이 **응답으로 공격자에게** 가고
3. 잠금(`failed_attempts`·`locked_until`)까지 함께 풀렸다

대상이 `admin`이면 곧바로 권한 상승이다.

**대역 외 확인 수단이 없으면 자가 재설정은 안전하게 만들 수 없다.** 보통은 메일로 일회용 링크를
보내지만 이 시스템에는 (그때) 메일이 없었다. 링크를 만들어도 전달할 곳이 없었다.

> **정정 2026-09-23.** Phase 6에서 사내 메일 발송이 생겨 이 근거는 더 이상 성립하지 않는다.
> 그래도 결정은 유지한다 — 메일 도달만으로 본인을 확인하는 흐름은 따로 판단할 일이고,
> 사내 메일 API는 아직 실연동 확인 전이다(보류 18). 다시 볼 거리로 `docs/기능백로그.md`에 올렸다.

그래서 **기능을 두지 않기로 했다.** 요청은 받아서 감사로그에 남기고, 실제 초기화는 인증과 권한
검사가 있는 관리자 경로(`POST /api/users/:id/reset-password`)로만 한다. 화면도 "관리자가 확인하고
초기화한다"로 바꿨다.

> **기능을 줄이는 것이 답인 경우가 있다.** 안전하게 만들 수 없는 편의 기능은 약하게 만드는 것이
> 아니라 없애야 한다. 남겨 두면 "언젠가 고치겠다"가 되고 그동안 계속 열려 있다.

**함께 고친 것 (같은 점검에서 나옴)**

| # | 문제 | 조치 |
|---|---|---|
| 2 | 비밀번호를 바꿔도 **다른 기기의 세션이 살아 있었다.** `regenerate()`는 현재 세션 하나만 바꾼다 | 변경·초기화 시 `sess->>'userId'`로 그 사용자의 세션을 전부 지운다 (FR-224) |
| 3 | 가입 중복 오류가 아이디/email 중 **어느 쪽인지 알려 줬다** — 미인증 존재 확인 오라클 | 하나의 문구로 합쳤다 |
| 4 | 계정 복구가 IdP 전용 계정에 비밀번호를 부여해 **FR-217을 우회**시켰다 | 관리자 초기화도 `oidc_sub`가 있으면 거부한다 (FR-209b) |

---

# 3. OIDC 인증 (FR-210 ~ FR-219)

## 3.1 경계

```ts
export interface OidcProvider {
  authorizationUrl(state: string, nonce: string, pkce?: PkcePair): Promise<string>;
  exchange(code: string, verifier?: string): Promise<OidcClaims>;
}
export type OidcClaims = { sub: string; preferredUsername?: string; email?: string; groups: string[] };
```

`auth.service`는 이 인터페이스만 안다. `HttpOidcProvider`는 Discovery·JWKS·토큰 교환을 하고, `MockOidcProvider`는 설정으로 정해 둔 클레임을 그대로 돌려준다.

## 3.2 왜 모의 제공자를 만드나

개발 서버가 사내 IdP에 못 나갈 수 있다(확인 필요 A). **그 사실이 확인될 때까지 Phase 1 전체를 멈추는 것이 대안인데, 그것은 선택지가 아니다.** 모의 제공자는 "IdP가 이런 클레임을 주면 우리가 이렇게 처리한다"를 검증한다. 검증하지 못하는 것은 **IdP가 실제로 무엇을 주는가**이고, 그것은 완료 기준에서 뺀다 (A.6).

## 3.3 클레임 → 역할 매핑 (FR-216, A등급)

```
WF_OIDC_ROLE_MAP='{"wf-admins":"admin","wf-users":"member"}'
```

`claims.ts`의 순수 함수가 처리한다.

| 입력 | 처리 |
|---|---|
| `groups`가 배열 | 그대로 |
| `groups`가 문자열 | 공백·쉼표로 분리 (IdP마다 다르다 — 리스크 1) |
| `groups` 없음 | 빈 배열 |
| 여러 그룹이 매핑됨 | **가장 높은 역할**을 준다 (`root` > `admin` > `member`) |
| 어느 것도 매핑 안 됨 | `null` → 로그인 거부 (FR-218) |

## 3.4 JIT 동기화 (FR-215, FR-217)

`sub`로 찾는다. 없으면 만든다. 있으면 `displayName`·`email`·`role`을 갱신한다 — **IdP가 정본**이다.

`username`은 `preferred_username`을 쓰되 이미 쓰이고 있으면 뒤에 숫자를 붙인다. **로컬 계정과 username이 충돌해도 계정을 합치지 않는다.** 같은 이름의 다른 사람일 수 있고, 합치면 되돌릴 수 없다.

---

# 4. 세션 (FR-220 ~ FR-225)

| 항목 | 값 | 설정 키 |
|---|---|---|
| 저장소 | PG `sessions` 테이블 | — |
| 쿠키 이름 | `wf.sid` | — |
| `HttpOnly` / `SameSite` | 항상 / `Lax` | — |
| `Secure` | `WF_ENV=production`이면 true | — |
| 유휴 | 30분, `rolling: true` | `WF_SESSION_IDLE_MINUTES` |
| 절대 | 12시간, 가드에서 판정 | `WF_SESSION_ABSOLUTE_HOURS` |
| 서명 키 | 필수. 32자 이상 | `WF_SESSION_SECRET` |

**절대 타임아웃을 쿠키가 아니라 가드에서 보는 이유.** 쿠키 `maxAge`는 `rolling`이 갱신해 버린다. 절대 한도는 세션 생성 시각을 세션 데이터에 넣고 매 요청 가드가 비교해야 지켜진다.

---

# 5. 사용자 관리 (FR-230 ~ FR-234)

API는 `packages/shared`의 DTO를 그대로 쓴다 (`createUserDto`, `updateUserRoleDto`, `UserView`). **Phase 0에서 이미 정의돼 있다** (보류 10 — 호출부가 이번에 붙으므로 여기서 계약을 확정한다).

| 메서드 | 경로 | 권한 | 감사 |
|---|---|---|---|
| GET | `/api/users` | `user.manage` | — |
| POST | `/api/users` | `user.manage` | `user.create` |
| POST | `/api/users/:id/approve` | `user.manage` | `user.approve` |
| POST | `/api/users/:id/unlock` | `user.manage` | `user.unlock` |
| POST | `/api/users/:id/reset-password` | `user.manage` | `user.password.reset` |
| PATCH | `/api/users/:id/role` | `user.role.change` | `user.role.change` |

**우위 규칙 (FR-232, FR-233).** `canAssignRole`·`canManageUser`가 `shared`에 이미 있다. 여기에 **마지막 `root` 강등 금지**를 더한다 — 순수 함수로 두기 어렵다(DB 카운트가 필요) 하므로 서비스에서 판정하고 테스트로 고정한다.

---

# 6. 감사로그 (FR-235 ~ FR-239)

`AuditService.record(input, tx)`가 **트랜잭션을 받는다** (FR-236). 호출부는 본 작업과 같은 `tx`를 넘긴다.

```ts
await db.transaction(async (tx) => {
  await tx.update(users).set({ status: 'active' }).where(eq(users.id, id));
  await audit.record({ action: 'user.approve', actorId, targetType: 'user', targetId: id }, tx);
});
```

**append-only 강제 (FR-239).** 마이그레이션에 트리거를 넣는다.

```sql
CREATE FUNCTION audit_events_immutable() RETURNS trigger AS $$
BEGIN RAISE EXCEPTION 'audit_events는 append-only다'; END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER audit_events_no_update BEFORE UPDATE OR DELETE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION audit_events_immutable();
```

`CLAUDE.md` 6절은 운영에서 앱 DB 계정 권한으로도 막으라고 한다. **Phase 1에서는 하지 않았다** — 앱·마이그레이션·시드가 모두 소유자 계정 하나를 쓴다. 계정 분리는 ~~Phase 5에서~~ **아직 하지 않았다** — Phase 5가 받지 않고 반입 후로 다시 미뤘다 (`P5_검증기록_Release` 10절, 보류 12). 지금 막고 있는 것은 **트리거 한 겹뿐**이고, 그 사실을 여기 적어 둔다.

**남기지 않는 것 (FR-238).** 비밀번호·임시 비밀번호·토큰·세션 ID. `email`은 `maskEmail`로 줄여 넣는다.

---

# 7. 요청 보호 (FR-240, FR-241)

| 보호 | 적용 | 구현 |
|---|---|---|
| CSRF | 상태 변경 메서드 전체 | 전역 가드. `CSRF_HEADER`가 없으면 403. 값이 아니라 **헤더의 존재**가 방어다(교차 출처에서 커스텀 헤더를 붙이면 preflight가 걸린다) |
| 요청 제한 | `/api/auth/*` 공개 엔드포인트 | `RateLimitGuard` (P0에 있다). `RATE_LIMITS`의 키별 설정 |

요청 제한은 **프로세스 메모리**에 있다(`RateLimitStore`). 단일 인스턴스 전제이고, **이중화는 하지 않기로 했다**(보류 6 닫음 2026-09-22).

---

# 8. 화면 (FR-242 ~ FR-245)

| 경로 | 화면 | 접근 |
|---|---|---|
| `/login` | 로그인 (+ OIDC 버튼, `WF_OIDC_ENABLED`일 때만) | 공개 |
| `/signup` | 가입 요청 | 공개 |
| `/find-account` | 아이디 찾기 · 비밀번호 초기화 **요청** | 공개 |
| `/change-password` | 비밀번호 변경 | 로그인 |
| `/admin/users` | 사용자 관리 | `user.manage` |
| `/admin/audit` | 감사로그 | `audit.read` |

임시 비밀번호는 **관리자 화면에서만** 1회 보여 준다. 다시 볼 수 없다는 것을 화면에 적는다.
비밀번호 찾기 화면은 값을 보여 주지 않는다 (2.4절).

---

# 9. 설정 항목 표 (FR-212, FR-216, FR-219 ~ FR-223)

**이 표에 없는 `WF_*` 키는 코드에 있을 수 없다** (`CLAUDE.md` 5절). 같은 커밋에서 `.env.example`·`packages/shared/src/env.ts`·`deploy/compose.yml`을 함께 고친다.

| 키 | 타입 | 기본값 | 설명 |
|---|---|---|---|
| `WF_SESSION_SECRET` | string(≥32) | **없음(필수)** | 세션 쿠키 서명 |
| `WF_SESSION_IDLE_MINUTES` | int | `30` | 유휴 타임아웃 |
| `WF_SESSION_ABSOLUTE_HOURS` | int | `12` | 절대 타임아웃 |
| `WF_ROOT_USERNAME` | string | `root` | 시드가 만드는 최초 계정 |
| `WF_ROOT_PASSWORD` | string | **없음(필수)** | 최초 계정 비밀번호. 첫 로그인에 변경 강제 |
| `WF_OIDC_ENABLED` | bool | `false` | 꺼지면 관련 엔드포인트 404 |
| `WF_OIDC_ISSUER` | string | `''` | Discovery 기준 URL |
| `WF_OIDC_CLIENT_ID` | string | `''` | |
| `WF_OIDC_CLIENT_SECRET` | string | `''` | |
| `WF_OIDC_REDIRECT_URI` | string | `''` | **그대로 전송** (FR-214) |
| `WF_OIDC_PKCE` | bool | `true` | 보류 1. IdP가 미지원이면 false |
| `WF_OIDC_ROLE_MAP` | json | `{}` | 그룹명 → 역할 |
| `WF_OIDC_MOCK` | bool | `false` | 모의 제공자 사용. **`WF_ENV=production`이면 거부** |

> `WF_OIDC_MOCK=true`와 `WF_ENV=production`의 조합을 **스키마가 거부한다.** 모의 인증이 운영에 켜지는 것은 조용히 잘못되는 유형이다.

---

# 10. 테스트 계획 (NFR-11, NFR-12)

| 대상 | 등급 | 방식 |
|---|---|---|
| `claims.ts` (그룹 매핑) | A | **테스트 먼저.** 배열·문자열·CSV·빈 값·다중 매핑·미매핑 |
| `lockout.ts` | A | **테스트 먼저.** 시계 주입. 경계(4회·5회·만료 직전·직후) |
| `auth.service` | B | 실제 PG. 가입→승인→로그인, 실패 누적·잠금·해제, 열거 방지(응답 동일성·시간차) |
| OIDC 흐름 | B | `MockOidcProvider`. state·nonce 불일치 거부, 매핑, JIT 생성·갱신 |
| 가드 | B | 세션 없음·만료·비활성·권한 부족·비밀번호 변경 강제 |
| 감사 | B | 롤백 시 기록도 사라지는지, 민감값이 안 들어가는지 |
| 화면 흐름 | C | E2E: 가입→승인→로그인→비밀번호 변경. **자기 계정을 직접 만든다** (P0 인계) |

---

# 11. 구현 순서

1. 마이그레이션 (`users`·`sessions`·`audit_events`·트리거·`settings` FK) + `schema.ts`
2. 설정 키 (`env.ts`·`.env.example`·compose) — 9절 표 전량
3. A등급 순수 함수 (`claims.ts`·`lockout.ts`) — **테스트 먼저**
4. `AuditModule` (전역)
5. `UsersService` (조회·생성·승인·역할·잠금)
6. 세션 미들웨어 + `AuthGuard` + CSRF 가드
7. `AuthService` 로컬 경로 + 컨트롤러
8. OIDC 제공자 경계 + 모의 구현 + 실 구현 + 컨트롤러
9. 시드 (root 계정)
10. 화면
11. E2E
12. 검증기록 → 자체 점검 → 학습가이드·장애대응 갱신

---

# 12. Phase 2 인계 사항

| 항목 | 내용 |
|---|---|
| 스페이스 권한 | `spaceAccess()`가 `shared`에 이미 있다. 가드가 멤버십을 모아 넘기는 부분이 Phase 2 |
| `space_categories.created_by` | `users(id)` FK로 연결 |
| 감사 액션 | `space.*`·`page.*`가 `AUDIT_ACTIONS`에 이미 있다. 호출부만 붙인다 |
| E2E | Phase 1의 "계정을 직접 만든다" 헬퍼를 재사용한다 |
| OIDC 미확인 | 실 IdP 연동은 여전히 미확인이다. Phase 2가 끝나도 그대로면 보류 표에서 다시 본다 |
