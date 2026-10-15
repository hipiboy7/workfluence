-- 채팅 안내 줄 (F-019 · P21_설계서_Chat) — "OO님이 채팅방을 나갔습니다"처럼 시스템이 방에 넣는 한 줄.
-- 종류 칸 하나를 더한다: user(사람이 보낸 것, 기존 행 전부) · join(들어옴) · leave(나감).
-- 안내 줄도 메시지라 방의 번호(seq)를 먹는다. 보낸 사람(sender_id)은 그 일을 한 사람이다(나간 사람 · 초대한 사람).
ALTER TABLE chat_messages ADD COLUMN kind text NOT NULL DEFAULT 'user';
ALTER TABLE chat_messages ADD CONSTRAINT chat_messages_kind_chk CHECK (kind IN ('user', 'join', 'leave'));
