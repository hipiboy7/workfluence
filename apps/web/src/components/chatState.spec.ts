import type { ChatMessageView, ChatRoomView } from '@workfluence/shared';
import { describe, expect, it } from 'vitest';
import { addressOf, addressTo, applyMessageToRooms, CHAT_TONES, lastSeqOf, memberTones, mentionCandidates, mergeMessages, roomTitle, senderName, totalUnread } from './chatState';

const msg = (seq: number, over: Partial<ChatMessageView> = {}): ChatMessageView => ({ id: `m${seq}`, roomId: 'r1', seq, senderId: 'u2', body: `b${seq}`, kind: 'user', createdAt: `2026-10-12T00:00:0${seq}.000Z`, ...over });
const room = (over: Partial<ChatRoomView> = {}): ChatRoomView => ({
  id: 'r1',
  kind: 'direct',
  name: null,
  createdBy: 'u1',
  members: [
    { userId: 'u1', username: 'u1', displayName: '나' },
    { userId: 'u2', username: 'u2', displayName: '상대' },
  ],
  pastMembers: [],
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

describe('안내 줄 (F-019)', () => {
  it('안내 줄은 안 읽은 수를 올리지 않고 마지막 메시지와 방 순서는 갱신한다', () => {
    const rooms = [room({ id: 'r1', lastSeq: 2, unread: 0 }), room({ id: 'r2', lastSeq: 1, unread: 0 })];
    const out = applyMessageToRooms(rooms, msg(3, { roomId: 'r2', kind: 'leave', body: '상대님이 채팅방을 나갔습니다' }), 'u1', null);
    expect(out[0]).toMatchObject({ id: 'r2', unread: 0, lastSeq: 3 });
    expect(out[0]!.lastMessage?.body).toContain('나갔습니다');
  });
  it('사람이 보낸 메시지는 그대로 올린다', () => {
    const out = applyMessageToRooms([room({ lastSeq: 2, unread: 0 })], msg(3), 'u1', null);
    expect(out[0]!.unread).toBe(1);
  });
});

describe('memberTones', () => {
  const many = (n: number) => room({ members: Array.from({ length: n }, (_, i) => ({ userId: `u${i}`, username: `u${i}`, displayName: `사람${i}` })) });

  it('참여자마다 차례대로 다른 번호를 준다', () => {
    const t = memberTones(many(3));
    expect([...t.values()]).toEqual([0, 1, 2]);
  });

  it('색 수까지는 한 방 안에서 겹치지 않는다', () => {
    const t = memberTones(many(CHAT_TONES));
    expect(new Set(t.values()).size).toBe(CHAT_TONES);
  });

  it('색 수를 넘으면 처음 색으로 돌아가고 번호는 늘 색 수 안이다', () => {
    const t = memberTones(many(CHAT_TONES + 2));
    expect(t.get(`u${CHAT_TONES}`)).toBe(0);
    expect([...t.values()].every((v) => v >= 0 && v < CHAT_TONES)).toBe(true);
  });

  it('방에 어디에도 없는 사람은 번호가 없다', () => {
    expect(memberTones(many(2)).has('모르는사람')).toBe(false);
  });

  it('나간 사람은 참여자들 뒤에 이어서 번호를 받는다 — 그 사람의 메시지가 색을 잃지 않는다', () => {
    const r = many(2);
    r.pastMembers = [{ userId: 'gone', displayName: '떠난사람' }];
    expect(memberTones(r).get('gone')).toBe(2);
  });
});

describe('senderName (F-021)', () => {
  it('참여자는 이름, 나간 사람은 "(나간 사람) 이름", 방 어디에도 없으면 이름 없는 "(나간 사람)"', () => {
    const r = room({ pastMembers: [{ userId: 'gone', displayName: '떠난사람' }] });
    expect(senderName(r, 'u2')).toBe('상대');
    expect(senderName(r, 'gone')).toBe('(나간 사람) 떠난사람');
    expect(senderName(r, 'x')).toBe('(나간 사람)');
  });
});

describe('받는 사람 (@ — F-024)', () => {
  const r = room({
    kind: 'group',
    members: [
      { userId: 'u1', username: 'me', displayName: '나' },
      { userId: 'a', username: 'aiagent', displayName: 'ai agent' },
      { userId: 'b', username: 'ai', displayName: 'ai' },
      { userId: 'c', username: 'alice', displayName: '앨리스' },
    ],
    pastMembers: [{ userId: 'gone', displayName: '떠난사람' }],
  });

  it('맨 앞의 "@이름 "을 받는 사람으로 읽는다 — 띄어쓰기가 든 이름도, 더 긴 이름이 먼저다', () => {
    expect(addressOf(r, '@ai agent 오늘 일정 알려줘')).toEqual({ userId: 'a', displayName: 'ai agent', rest: '오늘 일정 알려줘' });
    expect(addressOf(r, '@ai 안녕')).toEqual({ userId: 'b', displayName: 'ai', rest: '안녕' });
    expect(addressOf(r, '@앨리스')).toEqual({ userId: 'c', displayName: '앨리스', rest: '' });
    expect(addressOf(r, '@앨리스\n두 줄')).toEqual({ userId: 'c', displayName: '앨리스', rest: '두 줄' });
  });

  it('이름 뒤에 글자가 붙거나, 맨 앞이 아니거나, 모르는 이름이면 받는 사람이 없다', () => {
    expect(addressOf(r, '@앨리스씨 안녕')).toBeNull();
    expect(addressOf(r, '안녕 @앨리스 ')).toBeNull();
    expect(addressOf(r, '@밥 안녕')).toBeNull();
    expect(addressOf(r, '@')).toBeNull();
  });

  it('이름은 대소문자를 가리지 않는다 — 후보 좁히기와 같게(자체 점검 8)', () => {
    expect(addressOf(r, '@AI Agent 안녕')).toEqual({ userId: 'a', displayName: 'ai agent', rest: '안녕' });
    expect(addressOf(r, '@AI Agent Hello')?.rest).toBe('Hello'); // 할 말의 대소문자는 그대로
  });

  it('나간 사람에게 한 말도 지난 대화에서는 받는 사람이 남는다', () => {
    expect(addressOf(r, '@떠난사람 잘 가')?.userId).toBe('gone');
  });

  it('후보 — "@"로 시작하면 나를 뺀 참여자를, 친 글자로 이름이나 아이디의 앞을 맞춰(대소문자 무시) 보인다', () => {
    expect(mentionCandidates(r, 'u1', '@')?.map((m) => m.userId)).toEqual(['a', 'b', 'c']);
    expect(mentionCandidates(r, 'u1', '@AI')?.map((m) => m.userId)).toEqual(['a', 'b']);
    expect(mentionCandidates(r, 'u1', '@ai a')?.map((m) => m.userId)).toEqual(['a']);
    expect(mentionCandidates(r, 'u1', '@alice')?.map((m) => m.userId)).toEqual(['c']);
  });

  it('후보를 보이지 않는다 — "@"로 시작하지 않거나, 받는 사람을 이미 골랐거나, 줄을 바꿨거나, 맞는 사람이 없을 때. 나간 사람은 후보가 아니다', () => {
    expect(mentionCandidates(r, 'u1', '안녕')).toBeNull();
    expect(mentionCandidates(r, 'u1', '@앨리스 ')).toBeNull();
    expect(mentionCandidates(r, 'u1', '@a\nb')).toBeNull();
    expect(mentionCandidates(r, 'u1', '@zzz')).toBeNull();
    expect(mentionCandidates(r, 'u1', '@떠난')).toBeNull();
    expect(mentionCandidates(r, 'u1', '@나')).toBeNull();
  });

  it('고르면 입력칸이 "@이름 "이 된다 — 그 뒤에 할 말을 쓴다', () => {
    expect(addressTo({ displayName: 'ai agent' })).toBe('@ai agent ');
    expect(addressOf(r, addressTo({ displayName: 'ai agent' }) + '안녕')?.userId).toBe('a');
  });
});
