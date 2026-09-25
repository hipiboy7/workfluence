-- P11 (P11_설계서_Ops E절). 위임과 감사로그의 요청 식별자. 손으로 쓴다 (보류 17).

-- ── 위임 (FR-1200~1206) ───────────────────────────────────────────────────
--
-- root가 관리자에게 준 행위의 목록. **관리자만 가진다** — 관리자가 아니게 되면(역할 변경·사내 계정 동기화) 같은 문장에서 비운다(A.1-4).
-- 비우지 않고 역할만 바꾸는 문장은 둘째 CHECK가 거부한다 — 조용히 남지 않는다.
-- 위임할 수 있는 행위는 packages/shared의 DELEGABLE_ACTIONS와 같게 둔다(그 목록을 늘리면 첫째 CHECK도 고친다).
ALTER TABLE users ADD COLUMN grants text[] NOT NULL DEFAULT '{}';
ALTER TABLE users ADD CONSTRAINT users_grants_known_chk CHECK (grants <@ ARRAY['llm.manage']::text[]);
ALTER TABLE users ADD CONSTRAINT users_grants_admin_chk CHECK (cardinality(grants) = 0 OR role = 'admin');

-- ── 감사로그의 요청 식별자 (FR-1212) ───────────────────────────────────────
--
-- 그 요청의 앱 로그·nginx 로그와 잇는다. 요청 밖에서 남긴 행(한 시간마다의 정리·실시간 편집의 자동 저장)과 옛 행은 비어 있다.
-- append-only 트리거는 UPDATE·DELETE를 막을 뿐이라 열을 더하는 것과 무관하다.
ALTER TABLE audit_events ADD COLUMN request_id text;
