-- 공개 API 토큰 (docs/spinoff/public-api 계획서 4.1절). 손으로 쓴다 (보류 17).
--
-- id가 JWT의 jti다. **토큰 값은 두지 않는다** — 서명(WF_API_JWT_SECRET)으로 검증하고 jti로 이 행을 찾는다. DB가 새어도 토큰이 되지 않는다.
-- 요청마다 이 행(폐기·만료)과 사용자 행(정지·역할)을 다시 본다 — 순수 JWT만으로는 정지·폐기를 그 자리에서 먹일 수 없다.
-- 폐기는 행을 지우지 않고 revoked_at을 채운다 — 목록이 "언제 누가 끊었나"를 보여 주고 감사와 잇는다. 사용자가 지워지면 함께 지운다.
-- 앱 계정의 권한은 마이그레이션 단계가 모든 표에 다시 준다(apps/api/src/db/app-role.ts).
CREATE TABLE api_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name text NOT NULL,
  scopes text[] NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  last_used_at timestamptz,
  revoked_at timestamptz,
  revoked_reason text,
  CONSTRAINT api_tokens_name_chk CHECK (char_length(name) BETWEEN 1 AND 100),
  CONSTRAINT api_tokens_scopes_chk CHECK (cardinality(scopes) >= 1 AND scopes <@ ARRAY['read', 'write', 'admin']::text[]),
  CONSTRAINT api_tokens_expiry_chk CHECK (expires_at > created_at),
  CONSTRAINT api_tokens_revoked_chk CHECK ((revoked_at IS NULL) = (revoked_reason IS NULL))
);
CREATE INDEX api_tokens_user_idx ON api_tokens (user_id, created_at);
