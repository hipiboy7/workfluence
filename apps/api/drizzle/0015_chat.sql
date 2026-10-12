-- 채팅 (P21_설계서_Chat D절 · F-016). 손으로 쓴다 (보류 17).
--
-- 방은 스페이스에 속하지 않는다. 메시지는 고쳐 쓰지도 지우지도 않는 모양이다 — 보존·삭제는 보류 39가 정한다(그래서 UPDATE·DELETE를 막는 트리거는 두지 않고
-- 앱 코드가 쓰지 않는다. 정책이 정해지면 그 위에 얹는다). 앱 계정의 권한은 마이그레이션 단계가 모든 표에 다시 준다(apps/api/src/db/app-role.ts).
--
-- 방 안의 번호(seq)는 `chat_rooms.last_seq`를 행 잠금으로 올려 매긴다 — 번호가 비지도 겹치지도 않는다.
CREATE TABLE chat_rooms (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind text NOT NULL,
  name text,
  created_by uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seq bigint NOT NULL DEFAULT 0,
  last_message_at timestamptz,
  CONSTRAINT chat_rooms_kind_chk CHECK (kind IN ('direct', 'group')),
  CONSTRAINT chat_rooms_name_chk CHECK (
    (kind = 'direct' AND name IS NULL) OR (kind = 'group' AND name IS NOT NULL AND char_length(name) BETWEEN 1 AND 100)
  ),
  CONSTRAINT chat_rooms_seq_chk CHECK (last_seq >= 0)
);

CREATE TABLE chat_members (
  room_id uuid NOT NULL REFERENCES chat_rooms(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  joined_at timestamptz NOT NULL DEFAULT now(),
  last_read_seq bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (room_id, user_id),
  CONSTRAINT chat_members_read_chk CHECK (last_read_seq >= 0)
);
CREATE INDEX chat_members_user_idx ON chat_members (user_id);

-- 1:1 방의 쌍. user_a < user_b로 줄여 두 사람의 순서와 무관하게 하나만 만든다
CREATE TABLE chat_direct_pairs (
  user_a uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  user_b uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  room_id uuid NOT NULL UNIQUE REFERENCES chat_rooms(id) ON DELETE CASCADE,
  PRIMARY KEY (user_a, user_b),
  CONSTRAINT chat_direct_pairs_order_chk CHECK (user_a < user_b)
);

CREATE TABLE chat_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id uuid NOT NULL REFERENCES chat_rooms(id) ON DELETE CASCADE,
  seq bigint NOT NULL,
  sender_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body text NOT NULL,
  client_msg_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chat_messages_seq_uq UNIQUE (room_id, seq),
  CONSTRAINT chat_messages_client_uq UNIQUE (room_id, sender_id, client_msg_id),
  CONSTRAINT chat_messages_seq_chk CHECK (seq >= 1),
  CONSTRAINT chat_messages_client_chk CHECK (client_msg_id IS NULL OR char_length(client_msg_id) BETWEEN 1 AND 64)
);
