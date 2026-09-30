-- P19 (P19_설계서_Recovery C.3). 손으로 쓴다 (보류 17).

-- ── 메일 재설정 링크 (FR-2003~2005) ─────────────────────────────────────────
--
-- 값은 두지 않고 SHA-256만(token_hash) — DB가 새어도 링크가 되지 않는다(A.1-5).
-- password_mark는 발급 때의 비밀번호 해시에서 뽑은 SHA-256이다 — 쓸 때 지금 해시의 것과 견준다. 비밀번호가 어느 길로 바뀌었든 링크가 죽는다(A.1-4).
-- 한 사람에게 살아 있는 링크는 하나다 — 새로 만들 때 그 사람의 행을 모두 지우고 넣고, 쓰면 모두 지운다(앱이 한다). 사용자가 지워지면 함께 지운다.
-- 앱 계정의 권한은 마이그레이션 단계가 모든 표에 다시 준다(apps/api/src/db/app-role.ts).
CREATE TABLE password_reset_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash text NOT NULL,
  password_mark text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  CONSTRAINT password_reset_tokens_hash_chk CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT password_reset_tokens_mark_chk CHECK (password_mark ~ '^[0-9a-f]{64}$'),
  CONSTRAINT password_reset_tokens_expiry_chk CHECK (expires_at > created_at)
);
CREATE UNIQUE INDEX password_reset_tokens_hash_uq ON password_reset_tokens (token_hash);
CREATE INDEX password_reset_tokens_user_idx ON password_reset_tokens (user_id, created_at);
