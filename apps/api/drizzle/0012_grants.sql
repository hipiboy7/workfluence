-- P15 (P15_설계서_Grants D.2). 손으로 쓴다 (보류 17).

-- ── 관리자가 member에게 맡기는 권한 (FR-1600) ────────────────────────────────
--
-- 위임 목록을 넷으로 넓힌다 — packages/shared의 DELEGABLE_ACTIONS와 같게 둔다(`constraints.integration.spec.ts`가 본다).
ALTER TABLE users DROP CONSTRAINT users_grants_known_chk;
ALTER TABLE users ADD CONSTRAINT users_grants_known_chk CHECK (grants <@ ARRAY['llm.manage', 'category.manage', 'space.unsuspend', 'space.oversee']::text[]);

-- "위임은 관리자만"(users_grants_admin_chk)을 행위마다의 받는 역할(규칙표 DELEGATION의 holder)로 바꾼다 — LLM 연결 관리는 관리자, 셋은 member.
-- 기존 행의 위임은 관리자의 llm.manage뿐이라 그대로 지난다.
ALTER TABLE users DROP CONSTRAINT users_grants_admin_chk;
ALTER TABLE users ADD CONSTRAINT users_grants_holder_chk CHECK (
  (NOT (grants && ARRAY['llm.manage']::text[]) OR role = 'admin')
  AND (NOT (grants && ARRAY['category.manage', 'space.unsuspend', 'space.oversee']::text[]) OR role = 'member')
);

-- ── 관리자가 건 중지 (FR-1610, 보류 32) ────────────────────────────────────
--
-- 중지할 때 건 사람이 그 공간의 주인이었는지 적는다. 푸는 때 다시 계산하면 그 사이 Crew가 바뀐 것에 판정이 흔들린다(A.1-5).
-- 이미 중지된 공간은 지금의 사실로 채운다 — 건 사람이 만든 사람이거나 owner면 주인이다. 모르면(건 사람이 비었으면) false —
-- 관리자가 건 것으로 친다(주인도 권한이 있어야 푼다).
ALTER TABLE spaces ADD COLUMN suspended_by_owner boolean NOT NULL DEFAULT false;
UPDATE spaces s SET suspended_by_owner = (
  s.suspended_by IS NOT NULL AND (
    s.suspended_by = s.created_by
    OR EXISTS (SELECT 1 FROM space_members m WHERE m.space_id = s.id AND m.user_id = s.suspended_by AND m.role = 'owner')
  )
) WHERE s.status = 'suspended';
