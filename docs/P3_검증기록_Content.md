# P3_검증기록_Content — 검색·첨부·댓글 검증

설계는 [`docs/P3_설계서_Content.md`](P3_설계서_Content.md)에 있다. 이 문서는 **실측과 실호출**만 적는다.
시행착오의 경위는 여기 쓰지 않고 [`docs/internal/검토서_트러블슈팅.md`](internal/검토서_트러블슈팅.md)의 T-018·T-019·T-020을 가리킨다 (`CLAUDE.md` 4절).

| 항목 | 값 |
|---|---|
| 일자 | 2026-09-22 |
| 브랜치 | `impl-phase3` |
| 개발·검증 환경 | Linux (공유 빌드 서버), Node v24.21.0, pnpm 12.4.1 |
| 컨테이너 | Docker 29.6.1 · Compose v5.3.1 · 디스크 여유 14GB |
| 테스트 DB | 임베디드 PostgreSQL 17 (`WF_DATABASE_URL_TEST`) |

---

## 1. 테스트 건수와 커버리지

명령: `pnpm check` → 종료 코드 **0** (`CLAUDE.md` 12.2절 — 출력이 아니라 종료 코드로 판정한다).

| 대상 | 파일 | 건수 | skip |
|---|---|---|---|
| `packages/shared` | 5 | 58 | 0 |
| `apps/api` | 17 | 176 | 0 |
| E2E (`pnpm test:e2e`) | 4 | 13 | 0 |

**skip은 0건이다.** skip으로 통과한 것은 통과가 아니다 (`CLAUDE.md` 1.3절).

이번 Phase가 만든 모듈의 실측 커버리지 (`pnpm test:cov`, v8):

| 파일 | 등급 | 라인 | 브랜치 | 함수 | 구문 |
|---|---|---|---|---|---|
| `apps/api/src/attachments/domain/upload.ts` | **A** | 100.00 | 100.00 | 100.00 | 100.00 |
| `apps/api/src/attachments/attachments.service.ts` | B | 100.00 | 87.50 | 100.00 | 95.91 |
| `apps/api/src/attachments/storage/local.storage.ts` | B | 92.85 | 50.00 | 83.33 | 86.66 |
| `apps/api/src/attachments/storage/storage.provider.ts` | B | 100.00 | 100.00 | 100.00 | 100.00 |
| `apps/api/src/comments/comments.service.ts` | B | 94.59 | 87.50 | 100.00 | 90.90 |
| `apps/api/src/search/search.service.ts` | B | 100.00 | 75.00 | 100.00 | 100.00 |

전체: `apps/api` 라인 **92.28%** · 브랜치 80.54% · 구문 87.87%, `packages/shared` 라인 **95.79%** · 브랜치 94.24%.
A등급 90% 관문(`src/attachments/domain/**`)과 B등급 70% 관문을 **기계가 판정한다** (`apps/api/vitest.config.ts`의 `thresholds`).

> **이번에 측정 대상 자체가 틀려 있었다.** 검색·첨부·댓글이 커버리지 `include`에 없어 표에 한 줄도 나오지 않는데 관문은 통과했다.
> 원인과 조치는 T-020. 서비스 로직을 `*.service.ts`로 옮기고 `include`를 늘렸다.
> **관문 통과가 "측정했다"를 뜻하지 않는다**는 것이 이번에 값을 치르고 배운 것이다.

`local.storage.ts`의 브랜치 50%는 `get()`의 실패 경로(파일이 없을 때 `readFile`이 던지는 것)를 시험하지 않은 것이다.
DB에 메타데이터가 있는데 파일이 없는 상태는 우리가 만들지 않으므로 합성하지 않았다. **확인하지 못한 것**에 적는다.

---

## 2. 보류 2 판정 — pg_trgm으로 충분한가 (FR-407, NFR-32·33)

`CLAUDE.md` 1.2절 보류 2의 판정 방법 그대로, **재 보고** 정했다.

| 페이지 수 | p50 | p95 | max | 재현율 |
|---|---|---|---|---|
| 2,000 | 4ms | 5ms | 7ms | 10/10 |
| 50,000 | 59ms | 66ms | 84ms | 10/10 |

측정 방법: 합성 페이지를 넣고 한글 2글자 질의 20회를 돌려 분위수를 낸다. 재현율은 그 두 글자를 포함하도록 심어 둔 10건이 모두 나오는지로 센다.
`EXPLAIN`은 예상대로 **`Seq Scan`**이다 — 한글 2글자는 trigram 조각이 나오지 않아 GIN 인덱스를 타지 못한다.

**판정: 보류 2를 닫는다.** 건수 대 지연이 거의 선형이라 목표 1초에 닿으려면 약 75만 건이 필요하고, 사용자 300명 규모에서 도달하지 않는 수다.
pg_bigm 커스텀 DB 이미지를 **반입 대상에 올리지 않는다.** GIN 인덱스 자체는 남겨 뒀다 — 3글자 이상 질의는 타고, 두는 비용이 없다.

보류 3(ClamAV)은 **열린 채로 둔다.** 확인 필요 B(사내 보안 정책)가 답을 주지 않았으므로 기본 가정대로 **훅 지점만** 뒀다 (`AttachmentScanner`).

---

## 3. 인수 기준 검증

인수 기준(`docs/scope-definition.md` 5절): **"한글 질의로 페이지가 검색되고 파일이 첨부된다"**

### 3.1 브라우저 (E2E, `pnpm test:e2e`)

```
Running 13 tests using 1 worker
  ✓   6 [chromium] › e2e/content.spec.ts:33:5 › 검색 → 첨부 → 댓글 (1.7s)
  ✓   7 [chromium] › e2e/content.spec.ts:95:5 › 볼 수 없는 스페이스의 페이지는 검색 결과에 없다 (인수 기준) (560ms)
  13 passed (11.4s)
```

E2E는 **한글 파일명(`보고서.txt`)으로** 올린다. 영문 이름으로만 시험했다면 T-018을 끝까지 몰랐다.

### 3.2 실호출 (컨테이너 + nginx TLS)

개발 서버가 아니라 **반입 형상 그대로** 확인했다: `docker compose up` → nginx(TLS 종단) → api → postgres.
아래는 실제 출력이다.

```
== upload (한글 파일명) ==  HTTP 201
{"id":"4229bbb7-...","pageId":"aae68bef-...","filename":"보고서.txt","mime":"text/plain","size":19,
 "uploadedByName":"시스템 관리자","createdAt":"2026-09-21T16:52:47.042Z"}

== download ==  HTTP 200
content-type: text/plain
x-content-type-options: nosniff
cache-control: no-store
content-disposition: attachment; filename="___.txt"; filename*=UTF-8''%EB%B3%B4%EA%B3%A0%EC%84%9C.txt
strict-transport-security: max-age=31536000; includeSubDomains
body: 합성 데이터다

== search (한글 2글자) ==  HTTP 200
1 건 · 첨부 확인 보고서 · 반입 확인 1790009566

== comment ==  HTTP 201
createdByName: 시스템 관리자 · canDelete: True

== 허용하지 않는 확장자 ==  HTTP 400
{"message":"허용하지 않는 확장자다: exe","error":"Bad Request","statusCode":400}

== 상한 초과 (25MB) ==  HTTP 413
<html><head><title>413 Request Entity Too Large</title></head>
<body><center><h1>413 Request Entity Too Large</h1></center><hr><center>nginx</center></body></html>
```

읽을 것:

- **한글 파일명이 왕복에서 살아남는다.** `filename*`이 RFC 5987이고, ASCII 대체본(`___.txt`)은 헤더를 깨뜨리지 않게 다듬은 것이다 (FR-417).
- **25MB는 앱에 닿기 전에 nginx가 끊는다.** `client_max_body_size 20m`이 상한과 맞물려 있다는 뜻이다 (`CLAUDE.md` 8.3절). 앱까지 온 초과분은 앱이 413을 낸다 (통합 테스트 `크기 상한을 넘으면 413`).
- 확장자 거부는 **400**이고 크기 초과는 **413**이다. 둘을 같은 코드로 주면 "고쳐서 다시 보내라"와 "이 파일로는 안 된다"가 구분되지 않는다.

### 3.3 감사로그 (FR-419·424)

```
comment.create        · {"pageId": "aae68bef-...", "parentId": null}
attachment.download   · {"pageId": "aae68bef-...", "filename": "보고서.txt"}
attachment.upload     · {"size": 19, "pageId": "aae68bef-...", "filename": "보고서.txt"}
page.create           · {"title": "첨부 확인 보고서", "spaceId": "9278ee20-..."}
space.create          · {"kind": "team", "name": "반입 확인 1790009566"}
auth.login.success    · {"method": "local"}
```

**다운로드가 남는다.** 첨부는 읽기지만 "무엇을 가져갔는지"는 남아야 한다.
**검색은 남기지 않는다** (FR-409) — 기록이 검색량만큼 불어난다. 위 목록에 검색이 없는 것이 그 증거다.

---

## 4. 규칙 실호출 확인

| 규칙 | 어떻게 확인했나 | 결과 |
|---|---|---|
| 권한을 질의에서 건다 (FR-403) | 남의 팀에 20건, 내 팀에 1건을 두고 `limit=5`로 검색 | 내 것 1건만. **`limit`이 볼 수 없는 것으로 차지 않는다** |
| 볼 수 없는 스페이스는 결과에 없다 (FR-402) | Crew가 아닌 계정으로 `/search?q=결산` | 0건 (E2E) |
| 경로에 사용자 입력을 쓰지 않는다 (FR-412) | `../../../../etc/passwd.pdf`로 업로드 후 다운로드 | 정상 왕복. 이름은 메타데이터로만 남는다 |
| 저장소 키 형식 검사 | `LocalDiskStorage`에 비-16진수 키를 넘김 | `put`·`has`·`delete` 모두 거부 |
| 같은 내용은 한 벌 (FR-413) | 같은 바이트를 두 이름으로 올리고 하나를 삭제 | 남은 쪽이 그대로 내려받힌다 |
| 대댓글은 한 단계 (FR-421) | 대댓글에 다시 답하기 | 400 `대댓글에는 다시 답할 수 없다` |
| 지워진 페이지의 첨부·댓글 (FR-427) | 페이지 soft delete 후 조회 | 404 `페이지를 찾을 수 없다` |
| 서버가 `schemaVersion`을 찍는다 | 댓글 본문을 버전 없이 보내고 DB 원본 확인 | `attrs.schemaVersion = 1` |
| 스캔 훅 (FR-418) | 거부하는 대역 스캐너로 업로드 | 400, **저장소에 파일이 남지 않는다** |
| non-root가 볼륨에 쓴다 | 컨테이너에서 `id` + `/data/attachments`에 쓰기 | `uid=1000(node)`, `drwxr-xr-x node node`, WRITABLE |

---

## 5. 컨테이너 빌드·기동

```
$ df -h /            39G  25G  14G  65%   (빌드 전)
$ docker compose -f deploy/compose.yml --env-file deploy/.env build api
   BUILD_EXIT=0
$ docker images workfluence-app --format '{{.Repository}}:{{.Tag}}  {{.Size}}'
   workfluence-app:latest  389MB
$ docker compose -f deploy/compose.yml --env-file deploy/.env run --rm api node dist/db/migrate.js
   [migrate] 4개 마이그레이션 적용 상태
$ docker compose -f deploy/compose.yml ps
   workfluence-api        Up (healthy)
   workfluence-nginx      Up            0.0.0.0:8443->443/tcp
   workfluence-postgres   Up (healthy)
$ df -h /            39G  26G  14G  67%   (빌드 후)
```

이미지 **389MB**로 예산 400MB 이하다 (`CLAUDE.md` 8.2절). Phase 2의 388MB에서 1MB 늘었다 — 첨부·댓글 화면 코드다.

**이번 Phase가 반입 형상에 더한 것**

| 것 | 왜 |
|---|---|
| 볼륨 `attachments` → `/data/attachments` | 첨부는 컨테이너 밖에 남아야 한다. 백업 대상이다 (`CLAUDE.md` 8.3절) |
| Dockerfile의 `mkdir -p /data/attachments && chown node:node` | 이름 있는 볼륨은 마운트 지점이 이미지에 없으면 **root 소유로 생긴다.** 그러면 non-root 앱이 첫 업로드에서 막힌다 |
| `WF_STORAGE_PATH` · `WF_UPLOAD_MAX_MB` | 설정 항목 표(설계서 4절)와 `.env.example`·`deploy/compose.yml`을 같은 커밋에서 맞췄다 |

nginx는 이번에 **처음으로 실제로 띄워 확인했다.** Phase 0~2는 "인증서가 없어 띄우지 않는다"였는데, 첨부 상한(`client_max_body_size`)은 nginx를 통과시켜 보지 않으면 확인되지 않는다.
확인용 자체 서명 인증서는 `deploy/` 아래 certs 디렉토리에 만들었고 **커밋하지 않는다** — `.gitignore`에 넣었다.

---

## 6. 확인하지 못한 것

| 것 | 왜 | 언제 |
|---|---|---|
| 실제 사내 IdP 연동 | 확인 필요 A가 열려 있다. 이 Phase는 인증을 건드리지 않았다 | 확인 필요 A가 닫힐 때 |
| 바이러스 스캔 동작 | 보류 3. 훅 지점만 뒀고 구현이 없다 | 확인 필요 B가 닫힐 때 |
| 첨부 파일이 사라진 상태의 다운로드 | DB에 메타데이터가 있는데 디스크에 파일이 없는 상태를 우리가 만들지 않는다. 합성해서 시험하지 않았다 (`local.storage.ts` 브랜치 50%의 정체) | 물리 삭제 배치를 만드는 Phase 5 |
| 다중 사용자 동시 업로드 | 부하 시험은 Phase 5의 일이다 (보류 6) | Phase 5 |
| 라벨 화면 | FR-426대로 테이블만 만들었다. 화면은 Phase 4 | Phase 4 |
| 재색인 명령(`pnpm search:reindex`)의 대량 실행 | 50,000건에서 돌려 보지 않았다. 문법과 소량 동작만 확인했다 | Phase 5 |
| 재부팅 후 자동 기동 | 공유 서버라 재부팅하지 않는다 (사용자 지시) | 폐쇄망 반입 리허설 (Phase 5) |

---

## 7. Phase 4 인계 사항

1. **라벨은 테이블만 있다.** `labels`·`page_labels`에 화면과 API가 없다. Phase 4에서 붙인다 (FR-426).
2. **첨부 물리 삭제가 없다.** soft delete만 한다 — 같은 내용을 여러 메타데이터가 참조하므로(FR-413) 파일을 지우려면 참조 수를 세야 한다. 보존 기간 배치와 함께 Phase 5.
3. **댓글 대댓글은 원 댓글이 지워져도 남는다.** 화면이 그 자리를 비워 두는 것으로 처리한다. 더 나은 처리가 필요하면 Phase 4에서 정한다.
4. **운영 조절값이 아직 `.env`다.** 업로드 상한·확장자 목록은 Phase 4에서 DB `settings` + 관리 화면으로 옮긴다 (`CLAUDE.md` 5절).
5. **`client_max_body_size`와 `WF_UPLOAD_MAX_MB`는 손으로 맞춘다.** 한쪽만 바꾸면 조용히 어긋난다 — Phase 4에서 기계 검사를 둘지 검토한다.
