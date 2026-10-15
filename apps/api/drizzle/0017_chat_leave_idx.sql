-- 방을 나간 사람의 이름을 대화에 남긴다 (F-021) — 방 목록이 방마다 "나갔습니다" 안내 줄(kind = 'leave')의 보낸 사람을 모아 나간 사람(pastMembers)으로 싣는다.
-- 안내 줄은 방의 메시지 가운데 아주 적으므로 그것만 담은 부분 인덱스로 방마다 훑지 않게 한다.
CREATE INDEX chat_messages_leave_idx ON chat_messages (room_id) WHERE kind = 'leave';
