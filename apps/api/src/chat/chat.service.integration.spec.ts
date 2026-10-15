import type { ChatMessageView } from '@workfluence/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { users } from '../db/schema';
import { closeTestDb, openTestDb, resetTables, type TestDb } from '../test/db';
import { person } from '../test/people';
import { ChatHub } from './chat.hub';
import { ChatService } from './chat.service';

/** B등급 (P21_설계서_Chat E·FR-2400~2407). 실제 PostgreSQL */

let db: TestDb;
let hub: ChatHub;
let svc: ChatService;
const msgs: { to: string[]; m: ChatMessageView }[] = [];
const rooms: { userId: string; roomId: string; change: string }[] = [];

beforeAll(async () => {
  ({ db } = await openTestDb());
  hub = new ChatHub();
  hub.onMessage((to, m) => msgs.push({ to, m }));
  hub.onRoom((userId, roomId, change) => rooms.push({ userId, roomId, change }));
  svc = new ChatService(db, hub, { WF_CHAT_MAX_MESSAGE_CHARS: 10 });
});
afterAll(closeTestDb);
beforeEach(async () => {
  await resetTables(db);
  msgs.length = 0;
  rooms.length = 0;
});

describe('1:1 방 (FR-2401)', () => {
  it('두 사람 사이에 하나만 — 순서와 상관없이 같은 방', async () => {
    const a = await person(db, 'a');
    const b = await person(db, 'b');
    const r1 = await svc.createRoom(a, { kind: 'direct', userId: b.id });
    const r2 = await svc.createRoom(b, { kind: 'direct', userId: a.id });
    expect(r1.created).toBe(true);
    expect(r2).toMatchObject({ created: false, room: { id: r1.room.id } });
    expect(r1.room.members.map((m) => m.userId).sort()).toEqual([a.id, b.id].sort());
    expect(rooms.map((r) => r.userId).sort()).toEqual([a.id, b.id].sort()); // 만든 한 번만 알린다
  });
  it('동시에 열어도 방은 하나다', async () => {
    const a = await person(db, 'a');
    const b = await person(db, 'b');
    const res = await Promise.all([svc.createRoom(a, { kind: 'direct', userId: b.id }), svc.createRoom(b, { kind: 'direct', userId: a.id })]);
    expect(new Set(res.map((r) => r.room.id)).size).toBe(1);
    expect(res.filter((r) => r.created)).toHaveLength(1);
  });
  it('자기 자신·정지된 사람·없는 사람은 안 된다', async () => {
    const a = await person(db, 'a');
    const s = await person(db, 's', 'member', { status: 'suspended' });
    await expect(svc.createRoom(a, { kind: 'direct', userId: a.id })).rejects.toMatchObject({ response: { code: 'SELF_ROOM' } });
    await expect(svc.createRoom(a, { kind: 'direct', userId: s.id })).rejects.toMatchObject({ response: { code: 'USER_NOT_FOUND' } });
    await expect(svc.createRoom(a, { kind: 'direct', userId: '11111111-1111-4111-8111-111111111111' })).rejects.toMatchObject({ response: { code: 'USER_NOT_FOUND' } });
  });
  it('1:1 방에서는 나가지도 초대하지도 못한다', async () => {
    const a = await person(db, 'a');
    const b = await person(db, 'b');
    const c = await person(db, 'c');
    const { room } = await svc.createRoom(a, { kind: 'direct', userId: b.id });
    await expect(svc.leave(a, room.id)).rejects.toMatchObject({ response: { code: 'DIRECT_ROOM' } });
    await expect(svc.invite(a, room.id, [c.id])).rejects.toMatchObject({ status: 403, response: { code: 'DIRECT_ROOM' } }); // 만든 사람이어도 1:1 방이라는 까닭을 말한다
  });
});

describe('안내 줄 (F-019)', () => {
  const all = async (userId: string, roomId: string) => svc.listMessages({ id: userId }, roomId, { limit: 50 } as never);

  it('나가면 남은 사람들의 방에 "나갔습니다" 한 줄이 들어가고 실시간으로 알린다', async () => {
    const a = await person(db, 'a');
    const b = await person(db, 'b');
    const c = await person(db, 'c');
    const { room } = await svc.createRoom(a, { kind: 'group', name: '팀', userIds: [b.id, c.id] });
    msgs.length = 0;
    await svc.leave(b, room.id);
    const list = await all(a.id, room.id);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ kind: 'leave', senderId: b.id, seq: 1 });
    expect(list[0]!.body).toMatch(/님이 채팅방을 나갔습니다$/);
    expect(msgs).toHaveLength(1);
    expect(msgs[0]!.to.sort()).toEqual([a.id, c.id].sort()); // 나간 사람에게는 가지 않는다
  });

  it('초대하면 들어온 사람마다 "들어왔습니다" 한 줄이 들어가고 보낸 사람은 초대한 사람이다', async () => {
    const a = await person(db, 'a');
    const b = await person(db, 'b');
    const c = await person(db, 'c');
    const d = await person(db, 'd');
    const { room } = await svc.createRoom(a, { kind: 'group', name: '팀', userIds: [b.id] });
    msgs.length = 0;
    await svc.invite(a, room.id, [c.id, d.id, b.id]); // b는 이미 들어 있다
    const list = await all(a.id, room.id);
    expect(list.map((m) => [m.seq, m.kind, m.senderId])).toEqual([[1, 'join', a.id], [2, 'join', a.id]]);
    expect(msgs).toHaveLength(2);
    expect(await svc.invite(a, room.id, [c.id])).toBeTruthy(); // 이미 든 사람만이면 줄이 늘지 않는다
    expect(await all(a.id, room.id)).toHaveLength(2);
  });

  it('안내 줄은 안 읽은 수를 올리지 않는다 — 다 읽은 사람은 그대로, 밀린 사람만 안내 줄이 끼어 하나 늘 수 있다', async () => {
    const a = await person(db, 'a');
    const b = await person(db, 'b');
    const c = await person(db, 'c');
    const { room } = await svc.createRoom(a, { kind: 'group', name: '팀', userIds: [b.id, c.id] });
    await svc.send(a, room.id, { body: '안녕' }); // seq 1 — b·c는 안 읽었다
    await svc.markRead(b, room.id, 1); // b는 다 읽었다
    await svc.leave(c, room.id); // seq 2 안내 줄
    const rooms = await svc.listRooms(b.id);
    expect(rooms[0]!.unread).toBe(0);
    expect(rooms[0]!.lastMessage?.kind).toBe('leave');
    expect((await svc.listRooms(a.id))[0]!.unread).toBe(0); // 보낸 사람
  });

  it('새로 들어온 사람은 들어오기 전의 메시지로 안 읽은 수가 생기지 않는다', async () => {
    const a = await person(db, 'a');
    const b = await person(db, 'b');
    const c = await person(db, 'c');
    const { room } = await svc.createRoom(a, { kind: 'group', name: '팀', userIds: [b.id] });
    await svc.send(a, room.id, { body: '먼저' });
    await svc.invite(a, room.id, [c.id]);
    expect((await svc.listRooms(c.id))[0]!.unread).toBe(0);
  });

  it('마지막 사람이 나가면 보여 줄 사람이 없어 줄을 넣지 않는다', async () => {
    const a = await person(db, 'a');
    const b = await person(db, 'b');
    const { room } = await svc.createRoom(a, { kind: 'group', name: '팀', userIds: [b.id] });
    await svc.leave(b, room.id);
    msgs.length = 0;
    await svc.leave(a, room.id);
    expect(msgs).toHaveLength(0);
  });

  it('사람이 보낸 메시지의 종류는 user다', async () => {
    const a = await person(db, 'a');
    const b = await person(db, 'b');
    const { room } = await svc.createRoom(a, { kind: 'direct', userId: b.id });
    const { message } = await svc.send(a, room.id, { body: '안녕' });
    expect(message.kind).toBe('user');
  });
});

describe('여럿 방 (FR-2402)', () => {
  it('만든 사람이 초대하고 참여자는 나간다', async () => {
    const a = await person(db, 'a');
    const b = await person(db, 'b');
    const c = await person(db, 'c');
    const { room } = await svc.createRoom(a, { kind: 'group', name: '팀', userIds: [b.id, a.id, b.id] });
    expect(room).toMatchObject({ kind: 'group', name: '팀' });
    expect(room.members).toHaveLength(2); // 나 자신·중복은 한 번
    const after = await svc.invite(a, room.id, [c.id, b.id]);
    expect(after.members).toHaveLength(3);
    expect(rooms.filter((r) => r.userId === c.id && r.change === 'joined')).toHaveLength(1);
    await svc.leave(b, room.id);
    expect((await svc.getRoom(a.id, room.id)).members).toHaveLength(2);
    expect(rooms.filter((r) => r.userId === b.id && r.change === 'left')).toHaveLength(1);
    // 방에 남은 사람들의 참여자 목록도 바뀌었다고 알린다(자체 점검 5)
    expect(rooms.filter((r) => r.change === 'members' && r.userId === a.id)).toHaveLength(2); // 초대 때 한 번 + 나감 때 한 번
  });
  it('만든 사람이 아니면 초대하지 못한다 — 참여자가 아니면 방이 없는 것과 같다', async () => {
    const a = await person(db, 'a');
    const b = await person(db, 'b');
    const c = await person(db, 'c');
    const { room } = await svc.createRoom(a, { kind: 'group', name: '팀', userIds: [b.id] });
    await expect(svc.invite(b, room.id, [c.id])).rejects.toMatchObject({ status: 403, response: { code: 'FORBIDDEN' } });
    await expect(svc.invite(c, room.id, [c.id])).rejects.toMatchObject({ status: 404 });
  });
  it('불러 올 수 없는 사람이 하나라도 있으면 만들지 않는다', async () => {
    const a = await person(db, 'a');
    const s = await person(db, 's', 'member', { status: 'suspended' });
    await expect(svc.createRoom(a, { kind: 'group', name: '팀', userIds: [s.id] })).rejects.toMatchObject({ response: { code: 'USER_NOT_FOUND' } });
    await expect(svc.createRoom(a, { kind: 'group', name: '팀', userIds: [a.id] })).rejects.toMatchObject({ response: { code: 'NO_MEMBERS' } });
    expect(await svc.listRooms(a.id)).toEqual([]);
  });
});

describe('메시지 (FR-2403·2404·2405)', () => {
  it('번호는 1부터 이어지고 참여자 모두에게 알린다(보낸 사람 포함)', async () => {
    const a = await person(db, 'a');
    const b = await person(db, 'b');
    const { room } = await svc.createRoom(a, { kind: 'direct', userId: b.id });
    const m1 = await svc.send(a, room.id, { body: '하나' });
    const m2 = await svc.send(b, room.id, { body: '둘' });
    expect([m1.message.seq, m2.message.seq]).toEqual([1, 2]);
    expect(msgs).toHaveLength(2);
    expect(msgs[0]!.to.sort()).toEqual([a.id, b.id].sort());
  });
  it('동시에 보내도 번호가 비지도 겹치지도 않는다', async () => {
    const a = await person(db, 'a');
    const b = await person(db, 'b');
    const { room } = await svc.createRoom(a, { kind: 'direct', userId: b.id });
    const res = await Promise.all(Array.from({ length: 12 }, (_, i) => svc.send(i % 2 ? a : b, room.id, { body: `m${i}` })));
    expect(res.map((r) => r.message.seq).sort((x, y) => x - y)).toEqual(Array.from({ length: 12 }, (_, i) => i + 1));
  });
  it('같은 clientMsgId의 되풀이는 한 번만 받고 다시 알리지 않는다', async () => {
    const a = await person(db, 'a');
    const b = await person(db, 'b');
    const { room } = await svc.createRoom(a, { kind: 'direct', userId: b.id });
    const first = await svc.send(a, room.id, { body: '안녕', clientMsgId: 'c1' });
    const again = await svc.send(a, room.id, { body: '안녕', clientMsgId: 'c1' });
    expect(again).toMatchObject({ duplicate: true, message: { id: first.message.id, seq: 1 } });
    expect(msgs).toHaveLength(1);
    // 다른 사람의 같은 값은 별개다
    expect((await svc.send(b, room.id, { body: '안녕', clientMsgId: 'c1' })).duplicate).toBe(false);
  });
  it('본문 규칙 — 빈 글·긴 글은 400', async () => {
    const a = await person(db, 'a');
    const b = await person(db, 'b');
    const { room } = await svc.createRoom(a, { kind: 'direct', userId: b.id });
    await expect(svc.send(a, room.id, { body: '  ' })).rejects.toMatchObject({ response: { code: 'EMPTY' } });
    await expect(svc.send(a, room.id, { body: 'x'.repeat(11) })).rejects.toMatchObject({ response: { code: 'TOO_LONG' } });
  });
  it('참여자가 아니면 보내지도 읽지도 못한다 — 없는 방과 같은 404', async () => {
    const a = await person(db, 'a');
    const b = await person(db, 'b');
    const c = await person(db, 'c');
    const { room } = await svc.createRoom(a, { kind: 'direct', userId: b.id });
    await expect(svc.send(c, room.id, { body: 'x' })).rejects.toMatchObject({ status: 404 });
    await expect(svc.listMessages(c, room.id, {})).rejects.toMatchObject({ status: 404 });
    await expect(svc.markRead(c, room.id, 1)).rejects.toMatchObject({ status: 404 });
    await expect(svc.getRoom(c.id, room.id)).rejects.toMatchObject({ status: 404 });
    expect(await svc.roomIdsOf(c.id)).toEqual([]);
  });
  it('나간 사람은 더 읽지 못한다', async () => {
    const a = await person(db, 'a');
    const b = await person(db, 'b');
    const { room } = await svc.createRoom(a, { kind: 'group', name: 'g', userIds: [b.id] });
    await svc.send(a, room.id, { body: 'x' });
    await svc.leave(b, room.id);
    await expect(svc.listMessages(b, room.id, {})).rejects.toMatchObject({ status: 404 });
  });
});

describe('쪽 나누기·읽음 (FR-2403·2406·2407)', () => {
  it('before·after 모두 번호 오름차순으로 돌려준다', async () => {
    const a = await person(db, 'a');
    const b = await person(db, 'b');
    const { room } = await svc.createRoom(a, { kind: 'direct', userId: b.id });
    for (let i = 1; i <= 5; i++) await svc.send(a, room.id, { body: `m${i}` });
    const seqs = async (q: object) => (await svc.listMessages(b, room.id, q)).map((m) => m.seq);
    expect(await seqs({ limit: 2 })).toEqual([4, 5]);
    expect(await seqs({ beforeSeq: 4, limit: 2 })).toEqual([2, 3]);
    expect(await seqs({ afterSeq: 2 })).toEqual([3, 4, 5]);
    expect(await seqs({ afterSeq: 2, limit: 1 })).toEqual([3]);
    await expect(svc.listMessages(b, room.id, { beforeSeq: 1, afterSeq: 1 })).rejects.toMatchObject({ status: 400 });
  });
  it('안 읽은 수는 읽음 표시로 줄고, 내려가지 않고, 마지막 번호를 넘지 않는다', async () => {
    const a = await person(db, 'a');
    const b = await person(db, 'b');
    const { room } = await svc.createRoom(a, { kind: 'direct', userId: b.id });
    for (let i = 0; i < 4; i++) await svc.send(a, room.id, { body: 'x' });
    const unread = async (u: { id: string }) => (await svc.listRooms(u.id))[0]!.unread;
    expect(await unread(a)).toBe(0); // 내가 보낸 것은 읽은 것이다
    expect(await unread(b)).toBe(4);
    await svc.markRead(b, room.id, 3);
    expect(await unread(b)).toBe(1);
    await svc.markRead(b, room.id, 1);
    expect(await unread(b)).toBe(1);
    expect(await svc.markRead(b, room.id, 99)).toEqual({ lastReadSeq: 4 });
    expect(await unread(b)).toBe(0);
  });
  it('방 목록은 마지막 메시지가 새로운 방이 앞이고 마지막 메시지를 싣는다', async () => {
    const a = await person(db, 'a');
    const b = await person(db, 'b');
    const c = await person(db, 'c');
    const r1 = (await svc.createRoom(a, { kind: 'direct', userId: b.id })).room;
    const r2 = (await svc.createRoom(a, { kind: 'direct', userId: c.id })).room;
    await svc.send(a, r1.id, { body: '먼저' });
    await svc.send(a, r2.id, { body: '나중' });
    const list = await svc.listRooms(a.id);
    expect(list.map((r) => r.id)).toEqual([r2.id, r1.id]);
    expect(list[0]!.lastMessage).toMatchObject({ body: '나중', seq: 1 });
    await svc.send(a, r1.id, { body: '다시' });
    expect((await svc.listRooms(a.id)).map((r) => r.id)).toEqual([r1.id, r2.id]);
  });
});

describe('사람 찾기 (E절)', () => {
  it('활성 사용자의 표시 이름만, 나는 빠지고, 와일드카드는 글자로 본다', async () => {
    const me = await person(db, 'me');
    await person(db, 'kim');
    await person(db, 'ki%m');
    await person(db, 'sus', 'member', { status: 'suspended' });
    const found = await svc.searchUsers(me, 'ki', 10);
    expect(found.map((u) => u.displayName)).toEqual(['ki%m', 'kim']);
    expect(Object.keys(found[0]!).sort()).toEqual(['displayName', 'id']);
    expect((await svc.searchUsers(me, '%', 10)).map((u) => u.displayName)).toEqual(['ki%m']);
    expect((await svc.searchUsers(me, '', 10)).map((u) => u.displayName)).toEqual(['ki%m', 'kim']);
    await db.update(users).set({ status: 'suspended' }).where(eq(users.username, 'kim'));
    expect((await svc.searchUsers(me, 'ki', 10)).map((u) => u.displayName)).toEqual(['ki%m']);
  });
});

describe('보내기 한도는 사용자마다 한 예산이다 (보안 검토 2)', () => {
  it('REST·WebSocket 어느 길로 보내든, 몇 개의 연결·토큰으로 보내든 같은 한도를 나눠 쓴다', async () => {
    const limited = new ChatService(db, hub, { WF_CHAT_MAX_MESSAGE_CHARS: 10, WF_CHAT_SEND_PER_MIN: 2 });
    const a = await person(db, 'a');
    const b = await person(db, 'b');
    const { room } = await limited.createRoom(a, { kind: 'direct', userId: b.id });
    await limited.send(a, room.id, { body: '1' });
    await limited.send(a, room.id, { body: '2' });
    await expect(limited.send(a, room.id, { body: '3' })).rejects.toMatchObject({ status: 429, response: { code: 'RATE_LIMITED', details: { retryAfterSec: 60 } } });
    await limited.send(b, room.id, { body: '상대는 따로' });
    expect((await limited.listMessages(a, room.id, {})).map((m) => m.body)).toEqual(['1', '2', '상대는 따로']);
  });
});

describe('읽음 표시와 나가기가 겹쳐도 (코드 리뷰 5)', () => {
  it('확인과 쓰기 사이에 방을 나갔으면 500이 아니라 404다', async () => {
    const a = await person(db, 'a');
    const b = await person(db, 'b');
    const { room } = await svc.createRoom(a, { kind: 'group', name: 'g', userIds: [b.id] });
    await svc.send(a, room.id, { body: 'x' });
    // isMember 확인을 통과시킨 뒤 UPDATE 전에 나간 상태를 흉내 낸다
    const spy = vi.spyOn(svc, 'isMember').mockImplementationOnce(async () => {
      await svc.leave(b, room.id);
      return true;
    });
    await expect(svc.markRead(b, room.id, 1)).rejects.toMatchObject({ status: 404 });
    spy.mockRestore();
  });
});
