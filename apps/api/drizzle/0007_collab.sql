-- P6 (FR-701·740). 실시간 편집 상태와 페이지 템플릿.

-- ── 실시간 편집 상태 ──────────────────────────────────────────────────────
--
-- **파생 데이터다.** 지워도 정본(`page_versions.content_json`)은 그대로이고,
-- 다음에 페이지를 열면 정본에서 다시 시작한다 (P6_설계서_Collab C.1절).
--
-- `ON DELETE CASCADE`를 준다. 페이지가 물리 삭제되면 이 상태는 아무 의미가 없고,
-- 남아 있으면 `pnpm trash:purge`가 페이지를 못 지운다. `page_versions`를 CASCADE로
-- 두지 않은 것과 판단이 다른 이유는 **이쪽은 남길 값어치가 없기 때문**이다.
CREATE TABLE page_realtime (
  page_id    uuid PRIMARY KEY REFERENCES pages(id) ON DELETE CASCADE,
  state      bytea       NOT NULL,
  version_no integer     NOT NULL,
  updated_by uuid        REFERENCES users(id),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- 프로세스가 죽으면 상태가 남는다. 그것 자체는 문제가 아니지만(다음에 열면 이어진다)
-- 영구히 쌓이는 것은 막아야 한다 — 정리 명령이 이 인덱스로 오래된 것을 찾는다
CREATE INDEX page_realtime_updated_idx ON page_realtime (updated_at);

-- ── 페이지 템플릿 ─────────────────────────────────────────────────────────
--
-- **전역이다** (FR-744). 스페이스별로 두지 않는 것은 그 요구가 확인되지 않았기
-- 때문이다. 요구가 오면 넓힌다 (1.4절) — 좁게 시작해 넓히는 것은 되지만
-- 넓게 시작해 좁히는 것은 안 된다.
CREATE TABLE page_templates (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name         text        NOT NULL UNIQUE,
  description  text,
  content_json jsonb       NOT NULL,
  created_by   uuid        NOT NULL REFERENCES users(id),
  updated_by   uuid        NOT NULL REFERENCES users(id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
