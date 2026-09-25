-- P10 (P10_설계서_Llm E절). 사내 LLM 질문 — 등록한 LLM, 사람마다의 지시문, 대화와 메시지.
-- 손으로 쓴다 (보류 17).

-- ── 등록한 LLM (FR-1100~1108) ────────────────────────────────────────────
--
-- **id는 앱이 만든다.** API 키 암호문의 부가 데이터(AAD)에 행 id를 묶기 때문이다 (D.4) — 암호문을 다른 행으로
-- 옮겨 붙이면 풀리지 않는다. 그래서 기본값을 두지 않는다: 잊고 넣으면 여기서 실패한다.
-- 키는 **암호문만** 들어온다(`v1.`로 시작). 평문이 실수로 들어오는 길을 DB도 막는다.
CREATE TABLE llm_providers (
  id          uuid        PRIMARY KEY,
  name        text        NOT NULL UNIQUE,
  base_url    text        NOT NULL,
  model       text        NOT NULL,
  api_key_enc text,
  created_by  uuid        NOT NULL REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT llm_providers_base_url_chk CHECK (base_url ~ '^https?://'),
  CONSTRAINT llm_providers_key_sealed_chk CHECK (api_key_enc IS NULL OR api_key_enc LIKE 'v1.%')
);

-- ── 지시문 — 시스템 프롬프트 (FR-1125~1129) ─────────────────────────────
--
-- 보존 기간이 없다 — 고치거나 지울 때까지 남는다 (쟁점 4의 답). 이름은 사람 안에서 유일하다.
CREATE TABLE llm_prompts (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid        NOT NULL REFERENCES users(id),
  name       text        NOT NULL,
  content    text        NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT llm_prompts_user_name_uq UNIQUE (user_id, name)
);

-- ── 대화 (FR-1130~1139) ───────────────────────────────────────────────────
--
-- 보관 규칙은 세 시각이 전부다 (D.5):
--   updated_at  마지막 질문 — 목록 순서
--   retain_from 보존 기간을 세는 기준 — 질문하면 지금, 고정을 풀면 지금
--   pinned_at   고정한 시각 — 있으면 보존 기간을 세지 않는다
-- LLM을 지우면 대화는 남는다 — `SET NULL` (FR-1101). 시작할 때 고른 지시문은 **복사본**을 둔다 (FR-1127).
CREATE TABLE llm_conversations (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid        NOT NULL REFERENCES users(id),
  title         text        NOT NULL,
  provider_id   uuid        REFERENCES llm_providers(id) ON DELETE SET NULL,
  prompt_name   text,
  system_prompt text,
  pinned_at     timestamptz,
  retain_from   timestamptz NOT NULL DEFAULT now(),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- 목록은 "내 것, 최근 순"이다
CREATE INDEX llm_conversations_user_idx ON llm_conversations (user_id, updated_at DESC);
-- 정리(FR-1136)와 상한 정리(FR-1132)가 "고정하지 않은 것 중 오래된 것"을 찾는다
CREATE INDEX llm_conversations_retain_idx ON llm_conversations (user_id, retain_from) WHERE pinned_at IS NULL;

-- ── 메시지 ────────────────────────────────────────────────────────────────
--
-- 대화와 수명이 같다 — 대화를 지우면(사용자·만료·상한) 함께 지워진다 (`page_realtime`과 같은 판단).
-- **차례는 `seq`가 정한다.** 질문과 답을 한 문장으로 넣으므로 시각이 같을 수 있다 — 넣은 차례가 곧 대화의 차례다.
-- 답에는 생각 과정을 넣지 않는다 (FR-1119). `status`는 끝남·중지·끊김이다 (FR-1113·1120).
CREATE TABLE llm_messages (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  seq             bigint      GENERATED ALWAYS AS IDENTITY,
  conversation_id uuid        NOT NULL REFERENCES llm_conversations(id) ON DELETE CASCADE,
  role            text        NOT NULL CHECK (role IN ('user', 'assistant')),
  content         text        NOT NULL,
  model           text,
  status          text        NOT NULL DEFAULT 'done' CHECK (status IN ('done', 'stopped', 'failed')),
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX llm_messages_conversation_idx ON llm_messages (conversation_id, seq);
