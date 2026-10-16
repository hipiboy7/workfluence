import { isChatNotice, type ChatMessageView, type ChatRoomView } from '@workfluence/shared';

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
  const seen = mine || viewingRoomId === r.id || isChatNotice(m.kind); // 안내 줄은 안 읽은 수를 올리지 않는다(F-019)
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

/** 말풍선 바탕색의 수 — `styles.css`의 `.chat-msg.tone-0`~`tone-9`와 같게 둔다 */
export const CHAT_TONES = 10;

/**
 * 방 참여자마다 바탕색 번호를 임의로 하나씩 준다(F-018). 참여자 목록의 차례대로 0, 1, 2… — 방 안에서는 `CHAT_TONES`명까지 겹치지 않는다.
 * 나간 사람은 현재 참여자들 뒤에 이어서 번호를 받는다(그 사람의 메시지가 색을 잃지 않게). 방 어디에도 없는 사람은 번호가 없다. 열 명이 넘으면 처음 색으로 돌아간다
 */
export function memberTones(room: ChatRoomView): Map<string, number> {
  return new Map([...room.members, ...room.pastMembers].map((m, i) => [m.userId, i % CHAT_TONES]));
}

/** 보낸 사람의 이름 — 지금 참여자는 이름, 나간 사람은 `(나간 사람) 이름`(나갔다는 것과 누구였는지를 함께 남긴다), 방 어디에도 없으면 이름을 모르는 `(나간 사람)` */
export function senderName(room: ChatRoomView, userId: string): string {
  const now = room.members.find((m) => m.userId === userId);
  if (now) return now.displayName;
  const past = room.pastMembers.find((m) => m.userId === userId);
  return past ? `(나간 사람) ${past.displayName}` : '(나간 사람)';
}

/** 받는 사람(F-024) — 메시지 맨 앞의 `@이름` */
export type ChatAddress = { userId: string; displayName: string; rest: string };

/**
 * 메시지 맨 앞의 `@이름`을 받는 사람으로 읽는다(F-024). 본문은 평문 그대로 오가므로(서버·에이전트도 같은 글을 받는다) 표시는 화면이 본문에서 읽는다.
 * 이름에 띄어쓰기가 들 수 있어(`ai agent`) **더 긴 이름부터** 맞추고, 이름 뒤는 공백·줄바꿈이거나 끝이어야 한다(`@앨리스씨`는 아니다).
 * 나간 사람도 본다 — 지난 대화의 받는 사람이 사라지지 않게(F-021과 같은 판단)
 */
export function addressOf(room: ChatRoomView, body: string): ChatAddress | null {
  if (!body.startsWith('@')) return null;
  const text = body.slice(1);
  const people = [...room.members, ...room.pastMembers].filter((m) => m.displayName.length > 0).sort((a, b) => b.displayName.length - a.displayName.length);
  for (const m of people) {
    if (!text.startsWith(m.displayName)) continue;
    const after = text.slice(m.displayName.length);
    if (after === '' || /^\s/.test(after)) return { userId: m.userId, displayName: m.displayName, rest: after.replace(/^\s/, '') };
  }
  return null;
}

/**
 * 입력칸이 `@`로 시작하면 보일 받는 사람 후보(F-024) — 나를 뺀 지금 참여자 가운데 `@` 뒤에 친 글자로 표시 이름이나 아이디의 앞이 맞는 사람(대소문자 무시).
 * 보이지 않을 때는 `null` — `@`로 시작하지 않을 때, 줄을 바꿨을 때, 맞는 사람이 없을 때(받는 사람을 골라 할 말을 쓰기 시작하면 `@이름 할 말`에 맞는 이름이 없어 사라진다)
 */
export function mentionCandidates(room: ChatRoomView, meId: string, draft: string): ChatRoomView['members'] | null {
  if (!draft.startsWith('@') || draft.includes('\n')) return null;
  const q = draft.slice(1).toLowerCase();
  const found = room.members.filter((m) => m.userId !== meId && (m.displayName.toLowerCase().startsWith(q) || m.username.toLowerCase().startsWith(q)));
  return found.length > 0 ? found : null;
}

/** 후보를 고르면 입력칸에 들어갈 글 — `@이름 ` 뒤에 할 말을 쓴다 */
export const addressTo = (m: { displayName: string }): string => `@${m.displayName} `;
