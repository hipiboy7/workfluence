import type { ChatMessageView, ChatRoomView } from '@workfluence/shared';

/**
 * 채팅 화면의 상태 계산 — React 밖의 순수 함수 (P21_설계서_Chat G절, 3절 "상태 기계는 React 밖에서 Node로 시험한다").
 * 연결이 같은 메시지를 두 번 주거나(다시 붙은 뒤 메우기와 새 메시지가 겹친다) 순서가 뒤바뀌어 와도 화면은 `(방, 번호)`로 한 번씩만 번호 순으로 그린다.
 */

/** 번호가 같은 것은 하나만(나중에 온 것이 이긴다), 번호 오름차순 */
export function mergeMessages(current: ChatMessageView[], incoming: ChatMessageView[]): ChatMessageView[] {
  const by = new Map<number, ChatMessageView>();
  for (const m of current) by.set(m.seq, m);
  for (const m of incoming) by.set(m.seq, m);
  return [...by.values()].sort((a, b) => a.seq - b.seq);
}

/** 방에서 마지막으로 가진 번호 — 다시 붙은 뒤 `afterSeq`로 쓴다. 없으면 0 */
export function lastSeqOf(messages: ChatMessageView[]): number {
  return messages.length === 0 ? 0 : messages[messages.length - 1]!.seq;
}

/** 방 이름 — 1:1은 상대의 이름, 여럿은 방 이름(없으면 참여자 이름들) */
export function roomTitle(room: ChatRoomView, meId: string): string {
  if (room.kind === 'group') return room.name ?? room.members.map((m) => m.displayName).join(', ');
  return room.members.find((m) => m.userId !== meId)?.displayName ?? room.members[0]?.displayName ?? '(알 수 없음)';
}

/** 새 메시지를 방 목록에 반영한다 — 마지막 메시지·시각, 내가 보지 않는 방이면 안 읽은 수를 올리고 방을 맨 앞으로 */
export function applyMessageToRooms(rooms: ChatRoomView[], m: ChatMessageView, meId: string, viewingRoomId: string | null): ChatRoomView[] {
  const i = rooms.findIndex((r) => r.id === m.roomId);
  if (i < 0) return rooms; // 아직 모르는 방 — 목록을 다시 받는다(`room` 프레임)
  const r = rooms[i]!;
  if (m.seq <= r.lastSeq) return rooms; // 이미 반영한 것
  const mine = m.senderId === meId;
  const seen = mine || viewingRoomId === r.id;
  const next: ChatRoomView = {
    ...r,
    lastSeq: m.seq,
    lastMessageAt: m.createdAt,
    lastMessage: m,
    unread: seen ? r.unread : r.unread + 1,
  };
  return [next, ...rooms.filter((_, k) => k !== i)];
}

/** 방 목록의 안 읽은 수 합 — 위 막대에 보인다 */
export function totalUnread(rooms: ChatRoomView[]): number {
  return rooms.reduce((n, r) => n + r.unread, 0);
}
