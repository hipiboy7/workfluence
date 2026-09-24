-- P8 (FR-901·903). 실시간 편집 저장의 멘션을 **실제로 친 사람**에게 귀속한다.
-- 설계: docs/P8_설계서_Mention.md D절. 손으로 쓴다 (보류 17).

-- ── 부른 사람을 모를 수 있다 ──────────────────────────────────────────────
--
-- 실시간 편집의 자동 저장에는 요청한 사람이 없다. `@아이디`를 친 사람을 확실히 알 수
-- 없으면 **틀린 이름을 적는 대신 비운다** (FR-901). 화면은 "문서에서 불렸다"로 보인다.
-- FK는 그대로 둔다 — 값이 있으면 여전히 실제 사용자여야 한다.
ALTER TABLE notifications ALTER COLUMN actor_id DROP NOT NULL;

-- ── 클라이언트 ID → 사용자 대응표 ─────────────────────────────────────────
--
-- `{"<Yjs clientId>": "<users.id>" | null}`. `null`은 "누구인지 모른다"로 **굳은** 값이다.
-- `state`와 **같은 행**에 둔다 — 둘은 수명이 같고, 방이 끝나 행이 지워질 때 함께 사라져야
-- 한다. 따로 두면 그것을 코드가 기억해야 한다.
--
-- **파생 데이터다.** 지우면 그 방의 기존 글자가 "모름"이 될 뿐이다. 기존 행은 `{}`로 시작한다.
ALTER TABLE page_realtime
  ADD COLUMN authors jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD CONSTRAINT page_realtime_authors_object CHECK (jsonb_typeof(authors) = 'object');
