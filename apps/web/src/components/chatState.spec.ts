import type { ChatMessageView, ChatRoomView } from '@workfluence/shared';
import { describe, expect, it } from 'vitest';
import { applyMessageToRooms, lastSeqOf, mergeMessages, roomTitle, totalUnread } from './chatState';

const msg = (seq: number, over: Partial<ChatMessageView> = {}): ChatMessageView => ({ id: `m${seq}`, roomId: 'r1', seq, senderId: 'u2', body: `b${seq}`, createdAt: `2026-10-12T00:00:0${seq}.000Z`, ...over });
const room = (over: Partial<ChatRoomView> = {}): ChatRoomView => ({
  id: 'r1',
  kind: 'direct',
  name: null,
  createdBy: 'u1',
  members: [
    { userId: 'u1', displayName: '나' },
    { userId: 'u2', displayName: '상대' },
  ],
  lastSeq: 0,
  lastMessageAt: null,
  lastMessage: null,
  unread: 0,
  ...over,
});

describe('mergeMessages (G절)', () => {
  it('번호가 같으면 한 번만, 번호 오름차순', () => {
    expect(mergeMessages([msg(1), msg(3)], [msg(2), msg(3, { body: '새' })]).map((m) => [m.seq, m.body])).toEqual([[1, 'b1'], [2, 'b2'], [3, '새']]);
  });
  it('순서가 뒤바뀌어 와도 정렬한다', () => {
    expect(mergeMessages([], [msg(3), msg(1), msg(2)]).map((m) => m.seq)).toEqual([1, 2, 3]);
  });
  it('lastSeqOf — 없으면 0', () => {
    expect(lastSeqOf([])).toBe(0);
    expect(lastSeqOf([msg(1), msg(4)])).toBe(4);
  });
});

describe('roomTitle', () => {
  it('1:1은 상대의 이름, 여럿은 방 이름', () => {
    expect(roomTitle(room(), 'u1')).toBe('상대');
    expect(roomTitle(room(), 'u2')).toBe('나');
    expect(roomTitle(room({ kind: 'group', name: '팀' }), 'u1')).toBe('팀');
  });
});

describe('applyMessageToRooms', () => {
  it('남이 보낸 새 메시지는 안 읽은 수를 올리고 방을 맨 앞으로 올린다', () => {
    const rooms = [room({ id: 'rA' }), room({ id: 'r1' })];
    const next = applyMessageToRooms(rooms, msg(1), 'u1', null);
    expect(next.map((r) => r.id)).toEqual(['r1', 'rA']);
    expect(next[0]).toMatchObject({ unread: 1, lastSeq: 1, lastMessage: { seq: 1 } });
  });
  it('내가 보낸 것·지금 보고 있는 방은 안 읽은 수를 올리지 않는다', () => {
    expect(applyMessageToRooms([room()], msg(1, { senderId: 'u1' }), 'u1', null)[0]!.unread).toBe(0);
    expect(applyMessageToRooms([room()], msg(1), 'u1', 'r1')[0]!.unread).toBe(0);
  });
  it('이미 반영한 번호·모르는 방은 그대로 둔다', () => {
    const rooms = [room({ lastSeq: 5, unread: 2 })];
    expect(applyMessageToRooms(rooms, msg(5), 'u1', null)).toBe(rooms);
    expect(applyMessageToRooms(rooms, msg(1, { roomId: 'other' }), 'u1', null)).toBe(rooms);
  });
  it('totalUnread', () => {
    expect(totalUnread([room({ unread: 2 }), room({ unread: 3 })])).toBe(5);
  });
});
