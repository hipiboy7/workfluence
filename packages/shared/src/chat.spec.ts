import { describe, expect, it } from 'vitest';
import {
  canInviteToRoom,
  directPairKey,
  encodeChatFrame,
  messagePageQuery,
  parseChatClientFrame,
  unreadCount,
  validateChatBody,
  CHAT_LIMITS,
} from './chat';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const ROOM = '33333333-3333-4333-8333-333333333333';

describe('validateChatBody (FR-2403 · A.1-3)', () => {
  it('받는다 — 앞뒤 공백은 그대로 두고 비었는지만 본다', () => {
    expect(validateChatBody(' 안녕 ', 10)).toEqual({ ok: true, body: ' 안녕 ' });
  });
  it('공백뿐이거나 빈 글은 받지 않는다', () => {
    expect(validateChatBody('', 10)).toEqual({ ok: false, code: 'EMPTY' });
    expect(validateChatBody(' \n\t ', 10)).toEqual({ ok: false, code: 'EMPTY' });
  });
  it('상한은 글자(코드 포인트) 수다 — 이모지 하나가 둘로 세이지 않는다', () => {
    expect(validateChatBody('😀😀😀', 3).ok).toBe(true);
    expect(validateChatBody('😀😀😀😀', 3)).toEqual({ ok: false, code: 'TOO_LONG' });
  });
  it('NUL과 제어 문자(줄바꿈·탭 빼고)는 받지 않는다', () => {
    expect(validateChatBody('a\u0000b', 10)).toEqual({ ok: false, code: 'BAD_CHAR' });
    expect(validateChatBody('a\u001bb', 10)).toEqual({ ok: false, code: 'BAD_CHAR' });
    expect(validateChatBody('a\nb\tc', 10).ok).toBe(true);
  });
  it('글이 아닌 값은 받지 않는다', () => {
    expect(validateChatBody(42 as unknown as string, 10)).toEqual({ ok: false, code: 'NOT_TEXT' });
  });
});

describe('parseChatClientFrame (C.2)', () => {
  const ok = (o: object) => parseChatClientFrame(JSON.stringify(o), 4000);
  it('send를 받는다', () => {
    expect(ok({ type: 'send', roomId: ROOM, body: '안녕', clientMsgId: 'c-1' })).toEqual({
      ok: true,
      frame: { type: 'send', roomId: ROOM, body: '안녕', clientMsgId: 'c-1' },
    });
  });
  it('방 id는 소문자로 맞춘다', () => {
    const r = ok({ type: 'send', roomId: ROOM.toUpperCase(), body: 'x' });
    expect(r.ok && r.frame.roomId).toBe(ROOM);
  });
  it('clientMsgId는 없어도 되고, 있으면 길이 상한이 있다', () => {
    expect(ok({ type: 'send', roomId: ROOM, body: 'x' }).ok).toBe(true);
    expect(ok({ type: 'send', roomId: ROOM, body: 'x', clientMsgId: 'c'.repeat(CHAT_LIMITS.maxClientMsgIdChars + 1) }).ok).toBe(false);
  });
  it('JSON이 아니면 BAD_FRAME', () => {
    expect(parseChatClientFrame('{', 4000)).toEqual({ ok: false, code: 'BAD_FRAME' });
    expect(parseChatClientFrame('[]', 4000)).toEqual({ ok: false, code: 'BAD_FRAME' });
    expect(parseChatClientFrame('null', 4000)).toEqual({ ok: false, code: 'BAD_FRAME' });
  });
  it('모르는 type·모르는 칸은 UNKNOWN_TYPE·BAD_FRAME — 조작한 연결을 닫는 근거다', () => {
    expect(ok({ type: 'drop', roomId: ROOM })).toEqual({ ok: false, code: 'UNKNOWN_TYPE' });
    expect(ok({ type: 'send', roomId: ROOM, body: 'x', extra: 1 })).toEqual({ ok: false, code: 'BAD_FRAME' });
  });
  it('방 id가 uuid가 아니면 BAD_FRAME', () => {
    expect(ok({ type: 'send', roomId: '1', body: 'x' })).toEqual({ ok: false, code: 'BAD_FRAME' });
  });
  it('본문 문제는 그 까닭을 돌려준다 — 연결은 두고 그 메시지만 거절한다', () => {
    expect(ok({ type: 'send', roomId: ROOM, body: '' })).toEqual({ ok: false, code: 'EMPTY', recoverable: true, roomId: ROOM, clientMsgId: undefined });
    expect(parseChatClientFrame(JSON.stringify({ type: 'send', roomId: ROOM, body: 'abcd', clientMsgId: 'c' }), 3)).toEqual({
      ok: false,
      code: 'TOO_LONG',
      recoverable: true,
      roomId: ROOM,
      clientMsgId: 'c',
    });
  });
});

describe('directPairKey (A.1-1 · D)', () => {
  it('두 사람의 순서와 대소문자에 상관없이 같은 쌍을 낸다', () => {
    expect(directPairKey(B, A)).toEqual([A, B]);
    expect(directPairKey(A.toUpperCase(), B)).toEqual([A, B]);
  });
  it('같은 사람끼리는 쌍이 없다', () => {
    expect(directPairKey(A, A)).toBeNull();
  });
});

describe('canInviteToRoom (A.1-2)', () => {
  it('여럿 방은 만든 사람만 초대한다', () => {
    expect(canInviteToRoom({ kind: 'group', createdBy: A }, A)).toBe(true);
    expect(canInviteToRoom({ kind: 'group', createdBy: A }, B)).toBe(false);
  });
  it('1:1 방은 아무도 초대하지 못한다', () => {
    expect(canInviteToRoom({ kind: 'direct', createdBy: A }, A)).toBe(false);
  });
});

describe('messagePageQuery (FR-2403·2406)', () => {
  it('기본은 가장 새 것부터 기본 개수', () => {
    expect(messagePageQuery({})).toEqual({ ok: true, dir: 'before', seq: null, limit: CHAT_LIMITS.pageDefault });
  });
  it('beforeSeq · afterSeq 하나만, 둘이면 거절', () => {
    expect(messagePageQuery({ beforeSeq: 10 })).toEqual({ ok: true, dir: 'before', seq: 10, limit: CHAT_LIMITS.pageDefault });
    expect(messagePageQuery({ afterSeq: 3 })).toEqual({ ok: true, dir: 'after', seq: 3, limit: CHAT_LIMITS.pageDefault });
    expect(messagePageQuery({ beforeSeq: 10, afterSeq: 3 }).ok).toBe(false);
  });
  it('limit은 1~상한으로 줄인다, 정수가 아니면 거절', () => {
    expect(messagePageQuery({ limit: 9999 })).toMatchObject({ ok: true, limit: CHAT_LIMITS.pageMax });
    expect(messagePageQuery({ limit: 0 }).ok).toBe(false);
    expect(messagePageQuery({ limit: 1.5 }).ok).toBe(false);
    expect(messagePageQuery({ beforeSeq: -1 }).ok).toBe(false);
  });
});

describe('unreadCount (FR-2407)', () => {
  it('마지막 번호 − 읽은 번호, 음수가 되지 않는다', () => {
    expect(unreadCount(10, 4)).toBe(6);
    expect(unreadCount(3, 5)).toBe(0);
  });
});

describe('encodeChatFrame', () => {
  it('JSON 한 덩어리 글로 만든다', () => {
    expect(JSON.parse(encodeChatFrame({ type: 'ack', clientMsgId: 'c', roomId: ROOM, seq: 1, createdAt: 't' }))).toMatchObject({ type: 'ack', seq: 1 });
  });
});

describe('요청 본문 (E절)', () => {
  it('방 만들기 — 1:1과 여럿, 모르는 칸은 거절', async () => {
    const { createChatRoomDto } = await import('./chat');
    expect(createChatRoomDto.safeParse({ kind: 'direct', userId: A }).success).toBe(true);
    expect(createChatRoomDto.safeParse({ kind: 'direct', userId: A, name: 'x' }).success).toBe(false);
    expect(createChatRoomDto.safeParse({ kind: 'group', name: ' 팀 ', userIds: [A, B] })).toMatchObject({ success: true, data: { name: '팀' } });
    expect(createChatRoomDto.safeParse({ kind: 'group', name: '', userIds: [A] }).success).toBe(false);
    expect(createChatRoomDto.safeParse({ kind: 'group', name: 'x', userIds: [] }).success).toBe(false);
  });
  it('질의 — 숫자 글자를 정수로', async () => {
    const { chatMessagesQueryDto } = await import('./chat');
    expect(chatMessagesQueryDto.parse({ beforeSeq: '5', limit: '10' })).toEqual({ beforeSeq: 5, limit: 10 });
    expect(chatMessagesQueryDto.safeParse({ beforeSeq: '-1' }).success).toBe(false);
  });
});

describe('seq 상한 (보안 검토 7)', () => {
  it('JS가 다루는 정수를 넘는 번호는 거절한다 — DB 오류(500)가 되지 않게', async () => {
    const { chatMessagesQueryDto, markChatReadDto } = await import('./chat');
    expect(chatMessagesQueryDto.safeParse({ beforeSeq: '1e30' }).success).toBe(false);
    expect(chatMessagesQueryDto.safeParse({ afterSeq: String(Number.MAX_SAFE_INTEGER) }).success).toBe(true);
    expect(markChatReadDto.safeParse({ seq: 1e30 }).success).toBe(false);
  });
});
