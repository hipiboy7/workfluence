import { BadRequestException, ForbiddenException, HttpException, HttpStatus, Inject, Injectable, NotFoundException } from '@nestjs/common';
import {
  canInviteToRoom,
  chatNoticeText,
  directPairKey,
  messagePageQuery,
  unreadCount,
  validateChatBody,
  type ChatMessageKind,
  type ChatMessageView,
  type ChatRoomKind,
  type ChatMessagesQueryDto,
  type ChatRoomView,
  type ChatUserView,
  type CreateChatRoomDto,
} from '@workfluence/shared';
import { and, asc, desc, eq, gt, inArray, lt, ne, or, sql } from 'drizzle-orm';
import { APP_ENV, type AppEnvToken } from '../config/config.module';
import { DB, type Db } from '../db/db.module';
import { byName } from '../db/order';
import { chatDirectPairs, chatMembers, chatMessages, chatRooms, users } from '../db/schema';
import { ChatHub } from './chat.hub';
import { SendLimiter } from './domain/send-limiter';

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

const notFoundRoom = () => new NotFoundException({ code: 'ROOM_NOT_FOUND', message: '방을 찾을 수 없다' });
const codeOf = (x: unknown) => (typeof x === 'object' && x !== null && 'code' in x ? (x as { code?: unknown }).code : undefined);
const isUnique = (e: unknown): boolean => codeOf(e) === '23505' || codeOf((e as { cause?: unknown } | null)?.cause) === '23505';

const toMessage = (m: typeof chatMessages.$inferSelect): ChatMessageView => ({
  id: m.id,
  roomId: m.roomId,
  seq: m.seq,
  senderId: m.senderId,
  body: m.body,
  kind: m.kind as ChatMessageKind,
  createdAt: m.createdAt.toISOString(),
});

/**
 * 채팅 유스케이스 (P21_설계서_Chat D·E절). **화면용과 headless용이 같은 것을 부른다** — 규칙을 두 곳에 두지 않는다(FR-2410).
 *
 * 판정은 하나다 — **그 방의 참여자인가.** 아니면 방이 있는지도 알려 주지 않는 같은 404다(A.1-4). 연결(WebSocket)은 이 서비스를 거치지 않고 메시지를 쓰지 않는다:
 * 쓰기는 `send` 한 곳이고, 커밋 뒤에 `ChatHub`로 알린다.
 */
@Injectable()
export class ChatService {
  /** 사용자마다 분당 보내기 한도 — 화면·headless, REST·WebSocket이 한 예산이다(보안 검토 2) */
  private readonly limiter: SendLimiter;

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly hub: ChatHub,
    @Inject(APP_ENV) private readonly env: Pick<AppEnvToken, 'WF_CHAT_MAX_MESSAGE_CHARS'> & Partial<Pick<AppEnvToken, 'WF_CHAT_SEND_PER_MIN'>>,
  ) {
    this.limiter = new SendLimiter(env.WF_CHAT_SEND_PER_MIN ?? 60);
  }

  /** 연결이 서는 순간 구독할 방들 */
  async roomIdsOf(userId: string): Promise<string[]> {
    const rows = await this.db.select({ id: chatMembers.roomId }).from(chatMembers).where(eq(chatMembers.userId, userId));
    return rows.map((r) => r.id);
  }

  async isMember(roomId: string, userId: string, tx: Db | Tx = this.db): Promise<boolean> {
    const [r] = await tx.select({ u: chatMembers.userId }).from(chatMembers).where(and(eq(chatMembers.roomId, roomId), eq(chatMembers.userId, userId)));
    return r !== undefined;
  }

  private async requireMember(roomId: string, userId: string, tx: Db | Tx = this.db): Promise<void> {
    if (!(await this.isMember(roomId, userId, tx))) throw notFoundRoom();
  }

  /** 방을 부를 수 있는 사람(활성)만 걸러 돌려준다 — 없는 id·정지·승인 대기는 빠진다 */
  private async activeIds(ids: string[], tx: Db | Tx = this.db): Promise<Set<string>> {
    if (ids.length === 0) return new Set();
    const rows = await tx.select({ id: users.id }).from(users).where(and(inArray(users.id, ids), eq(users.status, 'active')));
    return new Set(rows.map((r) => r.id));
  }

  /** 방 목록 — 마지막 메시지 시각 순(메시지가 없는 방은 만든 시각). 안 읽은 수와 마지막 메시지를 싣는다 */
  async listRooms(userId: string): Promise<ChatRoomView[]> {
    const mine = await this.db
      .select({ room: chatRooms, lastReadSeq: chatMembers.lastReadSeq })
      .from(chatMembers)
      .innerJoin(chatRooms, eq(chatRooms.id, chatMembers.roomId))
      .where(eq(chatMembers.userId, userId));
    return this.views(mine.map((m) => ({ room: m.room, lastReadSeq: m.lastReadSeq })));
  }

  private async views(items: { room: typeof chatRooms.$inferSelect; lastReadSeq: number }[]): Promise<ChatRoomView[]> {
    if (items.length === 0) return [];
    const ids = items.map((i) => i.room.id);
    const members = await this.db
      .select({ roomId: chatMembers.roomId, userId: chatMembers.userId, displayName: users.displayName })
      .from(chatMembers)
      .innerJoin(users, eq(users.id, chatMembers.userId))
      .where(inArray(chatMembers.roomId, ids))
      .orderBy(byName(users.displayName), asc(users.id));
    // 방마다 가장 높은 번호의 메시지 — `(room_id, seq)` 유일 키를 탄다
    const lasts = await this.db
      .select()
      .from(chatMessages)
      .where(or(...items.filter((i) => i.room.lastSeq > 0).map((i) => and(eq(chatMessages.roomId, i.room.id), eq(chatMessages.seq, i.room.lastSeq)))) ?? sql`false`);
    const lastBy = new Map(lasts.map((m) => [m.roomId, toMessage(m)]));
    // 나간 사람 — "나갔습니다" 안내 줄의 보낸 사람. 지금 참여자가 아닌 사람만(다시 들어왔으면 참여자다)
    const leavers = await this.db
      .select({ roomId: chatMessages.roomId, userId: chatMessages.senderId, displayName: users.displayName })
      .from(chatMessages)
      .innerJoin(users, eq(users.id, chatMessages.senderId))
      .where(and(inArray(chatMessages.roomId, ids), eq(chatMessages.kind, 'leave')))
      .orderBy(byName(users.displayName), asc(users.id));
    const views = items.map(({ room, lastReadSeq }): ChatRoomView => ({
      id: room.id,
      kind: room.kind as ChatRoomView['kind'],
      name: room.name,
      createdBy: room.createdBy,
      members: members.filter((m) => m.roomId === room.id).map((m) => ({ userId: m.userId, displayName: m.displayName })),
      // 같은 사람이 여러 번 나갔다 들어왔을 수 있어 사람마다 한 번만
      pastMembers: [...new Map(leavers.filter((l) => l.roomId === room.id && !members.some((m) => m.roomId === room.id && m.userId === l.userId)).map((l) => [l.userId, { userId: l.userId, displayName: l.displayName }])).values()],
      lastSeq: room.lastSeq,
      lastMessageAt: room.lastMessageAt?.toISOString() ?? null,
      lastMessage: lastBy.get(room.id) ?? null,
      unread: unreadCount(room.lastSeq, lastReadSeq),
    }));
    // 마지막 메시지 시각 순 — 메시지가 없는 방은 만든 시각으로
    const key = new Map(items.map((i) => [i.room.id, (i.room.lastMessageAt ?? i.room.createdAt).getTime()]));
    return views.sort((a, b) => key.get(b.id)! - key.get(a.id)! || (a.id < b.id ? -1 : 1));
  }

  async getRoom(userId: string, roomId: string): Promise<ChatRoomView> {
    const [row] = await this.db
      .select({ room: chatRooms, lastReadSeq: chatMembers.lastReadSeq })
      .from(chatMembers)
      .innerJoin(chatRooms, eq(chatRooms.id, chatMembers.roomId))
      .where(and(eq(chatMembers.userId, userId), eq(chatMembers.roomId, roomId)));
    if (!row) throw notFoundRoom();
    return (await this.views([row]))[0]!;
  }

  /** 방 만들기 — 1:1은 쌍마다 하나라 이미 있으면 그 방을 돌려준다(`created=false`) */
  async createRoom(me: { id: string }, dto: CreateChatRoomDto): Promise<{ room: ChatRoomView; created: boolean }> {
    return dto.kind === 'direct' ? this.openDirect(me.id, dto.userId) : this.createGroup(me.id, dto.name, dto.userIds);
  }

  private async openDirect(meId: string, otherId: string): Promise<{ room: ChatRoomView; created: boolean }> {
    const pair = directPairKey(meId, otherId);
    if (!pair) throw new BadRequestException({ code: 'SELF_ROOM', message: '자기 자신과는 1:1 방을 만들 수 없다' });
    if (!(await this.activeIds([otherId])).has(otherId)) throw new NotFoundException({ code: 'USER_NOT_FOUND', message: '사용자를 찾을 수 없다' });
    const existing = async (): Promise<string | undefined> =>
      (await this.db.select({ r: chatDirectPairs.roomId }).from(chatDirectPairs).where(and(eq(chatDirectPairs.userA, pair[0]), eq(chatDirectPairs.userB, pair[1]))))[0]?.r;

    let roomId = await existing();
    let created = false;
    if (!roomId) {
      try {
        roomId = await this.db.transaction(async (tx) => {
          const [room] = await tx.insert(chatRooms).values({ kind: 'direct', name: null, createdBy: meId }).returning();
          await tx.insert(chatDirectPairs).values({ userA: pair[0], userB: pair[1], roomId: room!.id });
          await tx.insert(chatMembers).values([{ roomId: room!.id, userId: pair[0] }, { roomId: room!.id, userId: pair[1] }]);
          return room!.id;
        });
        created = true;
      } catch (e) {
        // 동시에 둘이 같은 쌍을 열었다 — 진 쪽은 이긴 쪽의 방을 쓴다
        if (!isUnique(e)) throw e;
        roomId = await existing();
        if (!roomId) throw e;
      }
    }
    if (created) {
      this.hub.publishRoom(meId, roomId, 'joined');
      this.hub.publishRoom(otherId, roomId, 'joined');
    }
    return { room: await this.getRoom(meId, roomId), created };
  }

  private async createGroup(meId: string, name: string, userIds: string[]): Promise<{ room: ChatRoomView; created: boolean }> {
    const others = [...new Set(userIds)].filter((id) => id !== meId);
    if (others.length === 0) throw new BadRequestException({ code: 'NO_MEMBERS', message: '자기 말고 한 사람 이상을 불러야 한다' });
    const ok = await this.activeIds(others);
    if (others.some((id) => !ok.has(id))) throw new NotFoundException({ code: 'USER_NOT_FOUND', message: '사용자를 찾을 수 없다' });
    const roomId = await this.db.transaction(async (tx) => {
      const [room] = await tx.insert(chatRooms).values({ kind: 'group', name, createdBy: meId }).returning();
      await tx.insert(chatMembers).values([meId, ...others].map((userId) => ({ roomId: room!.id, userId })));
      return room!.id;
    });
    for (const id of [meId, ...others]) this.hub.publishRoom(id, roomId, 'joined');
    return { room: await this.getRoom(meId, roomId), created: true };
  }

  /**
   * 안내 줄을 넣는다 (F-019) — 보낸 사람은 그 일을 한 사람이고, 번호는 방의 다음 번호다. 호출하는 쪽이 **방 행을 잠근 같은 트랜잭션**에서 부르고,
   * 마지막에 `closeNotices`로 방의 마지막 번호를 올린다
   */
  private async insertNotice(tx: Tx, roomId: string, seq: number, kind: 'join' | 'leave', actorId: string, displayName: string): Promise<ChatMessageView> {
    const [row] = await tx.insert(chatMessages).values({ roomId, seq, senderId: actorId, body: chatNoticeText(kind, displayName), kind }).returning();
    return toMessage(row!);
  }

  /**
   * 안내 줄을 다 넣은 뒤 방의 마지막 번호를 올린다. **안 읽은 수는 올리지 않는다** — 다 읽어 둔 사람(읽은 번호가 안내 전의 마지막 번호)은 안내 줄까지 읽은 것으로 옮기고,
   * 이미 밀려 있는 사람은 그대로 둔다(그 사람의 안 읽은 수에는 안내 줄이 끼어 하나 늘 수 있다)
   */
  private async closeNotices(tx: Tx, room: typeof chatRooms.$inferSelect, last: ChatMessageView): Promise<void> {
    await tx.update(chatRooms).set({ lastSeq: last.seq, lastMessageAt: new Date(last.createdAt) }).where(eq(chatRooms.id, room.id));
    await tx
      .update(chatMembers)
      .set({ lastReadSeq: last.seq })
      .where(and(eq(chatMembers.roomId, room.id), eq(chatMembers.lastReadSeq, room.lastSeq)));
  }

  /** 여럿 방에 사람을 부른다 — 참여자 누구나(2026-10-15 개정). 들어온 사람마다 안내 줄이 한 줄 들어간다(F-019) */
  async invite(me: { id: string }, roomId: string, userIds: string[]): Promise<ChatRoomView> {
    const [peek] = await this.db.select().from(chatRooms).where(eq(chatRooms.id, roomId));
    if (!peek || !(await this.isMember(roomId, me.id))) throw notFoundRoom();
    if (!canInviteToRoom({ kind: peek.kind as ChatRoomKind })) throw new ForbiddenException({ code: 'DIRECT_ROOM', message: '1:1 방에는 사람을 초대할 수 없다 — 여럿 방을 새로 만든다' });
    const wanted = [...new Set(userIds)];
    const ok = await this.activeIds(wanted);
    if (wanted.some((id) => !ok.has(id))) throw new NotFoundException({ code: 'USER_NOT_FOUND', message: '사용자를 찾을 수 없다' });

    const out = await this.db.transaction(async (tx) => {
      const [room] = await tx.select().from(chatRooms).where(eq(chatRooms.id, roomId)).for('update');
      if (!room || !(await this.isMember(roomId, me.id, tx))) throw notFoundRoom();
      const added = await tx
        .insert(chatMembers)
        .values(wanted.map((userId) => ({ roomId, userId, lastReadSeq: room.lastSeq })))
        .onConflictDoNothing()
        .returning({ userId: chatMembers.userId });
      if (added.length === 0) return { added: [] as string[], notices: [] as ChatMessageView[], memberIds: [] as string[] };
      const names = await tx.select({ id: users.id, displayName: users.displayName }).from(users).where(inArray(users.id, added.map((a) => a.userId)));
      const nameBy = new Map(names.map((n) => [n.id, n.displayName]));
      const notices: ChatMessageView[] = [];
      for (const a of added) notices.push(await this.insertNotice(tx, roomId, room.lastSeq + notices.length + 1, 'join', me.id, nameBy.get(a.userId) ?? ''));
      await this.closeNotices(tx, room, notices[notices.length - 1]!);
      const members = await tx.select({ u: chatMembers.userId }).from(chatMembers).where(eq(chatMembers.roomId, roomId));
      return { added: added.map((a) => a.userId), notices, memberIds: members.map((m) => m.u) };
    });
    for (const id of out.added) this.hub.publishRoom(id, roomId, 'joined');
    // 이미 있던 참여자들의 참여자 목록도 바뀌었다 — 새 사람의 메시지가 "(나간 사람)"으로 그려지지 않게(자체 점검 5)
    const addedSet = new Set(out.added);
    for (const id of out.memberIds) if (!addedSet.has(id)) this.hub.publishRoom(id, roomId, 'members');
    for (const n of out.notices) this.hub.publishMessage(out.memberIds, n);
    return this.getRoom(me.id, roomId);
  }

  /** 방에서 나간다. 1:1 방은 나가지 못한다(쌍마다 방 하나라 나가면 다시 열 길이 없다). 남은 사람이 있으면 그 방에 "나갔습니다" 한 줄이 들어간다(F-019) */
  async leave(me: { id: string }, roomId: string): Promise<void> {
    const [peek] = await this.db.select().from(chatRooms).where(eq(chatRooms.id, roomId));
    if (!peek || !(await this.isMember(roomId, me.id))) throw notFoundRoom();
    if (peek.kind === 'direct') throw new BadRequestException({ code: 'DIRECT_ROOM', message: '1:1 방에서는 나갈 수 없다' });
    const out = await this.db.transaction(async (tx) => {
      const [room] = await tx.select().from(chatRooms).where(eq(chatRooms.id, roomId)).for('update');
      if (!room) throw notFoundRoom();
      const gone = await tx.delete(chatMembers).where(and(eq(chatMembers.roomId, roomId), eq(chatMembers.userId, me.id))).returning({ u: chatMembers.userId });
      if (gone.length === 0) return null; // 확인과 쓰기 사이에 이미 나갔다
      const [who] = await tx.select({ displayName: users.displayName }).from(users).where(eq(users.id, me.id));
      const remaining = (await tx.select({ u: chatMembers.userId }).from(chatMembers).where(eq(chatMembers.roomId, roomId))).map((m) => m.u);
      if (remaining.length === 0) return { remaining, notice: null };
      const notice = await this.insertNotice(tx, roomId, room.lastSeq + 1, 'leave', me.id, who?.displayName ?? '');
      await this.closeNotices(tx, room, notice);
      return { remaining, notice };
    });
    if (!out) return;
    this.hub.publishRoom(me.id, roomId, 'left');
    for (const u of out.remaining) this.hub.publishRoom(u, roomId, 'members');
    if (out.notice) this.hub.publishMessage(out.remaining, out.notice);
  }

  /**
   * 메시지 읽기 (FR-2403·2406). `before`는 그 번호보다 이전 `limit`개, `after`는 이후 `limit`개 — **결과는 늘 번호 오름차순**이다.
   * 번호를 안 주면 가장 새 것부터 `limit`개
   */
  async listMessages(me: { id: string }, roomId: string, q: ChatMessagesQueryDto): Promise<ChatMessageView[]> {
    await this.requireMember(roomId, me.id);
    const page = messagePageQuery(q);
    if (!page.ok) throw new BadRequestException({ code: 'BAD_QUERY', message: 'beforeSeq와 afterSeq는 하나만, limit은 1 이상의 정수여야 한다' });
    const cond =
      page.dir === 'after'
        ? and(eq(chatMessages.roomId, roomId), gt(chatMessages.seq, page.seq ?? 0))
        : page.seq === null
          ? eq(chatMessages.roomId, roomId)
          : and(eq(chatMessages.roomId, roomId), lt(chatMessages.seq, page.seq));
    const rows = await this.db
      .select()
      .from(chatMessages)
      .where(cond)
      .orderBy(page.dir === 'after' ? asc(chatMessages.seq) : desc(chatMessages.seq))
      .limit(page.limit);
    return (page.dir === 'after' ? rows : rows.reverse()).map(toMessage);
  }

  /**
   * 보내기 (FR-2403·2404). 방 행을 잠가 번호를 매긴다 — 번호가 비지도 겹치지도 않는다. **같은 `clientMsgId`의 되풀이는 한 번만 받는다**(A.1-6) —
   * 이미 받은 것을 `duplicate=true`로 돌려주고 다시 알리지 않는다. 보낸 사람의 읽은 번호는 그 번호로 올라간다
   */
  async send(me: { id: string }, roomId: string, input: { body: unknown; clientMsgId?: string }): Promise<{ message: ChatMessageView; duplicate: boolean }> {
    const body = validateChatBody(input.body, this.env.WF_CHAT_MAX_MESSAGE_CHARS);
    if (!body.ok) throw new BadRequestException({ code: body.code, message: '메시지를 보낼 수 없다 (' + body.code + ')' });
    if (!this.limiter.take(me.id, Date.now())) {
      const wait = this.limiter.retryAfterSec();
      throw new HttpException({ code: 'RATE_LIMITED', message: `너무 자주 보냈다 — ${wait}초 안에 다시 시도한다`, details: { retryAfterSec: wait } }, HttpStatus.TOO_MANY_REQUESTS);
    }

    const out = await this.db.transaction(async (tx) => {
      const [room] = await tx.select().from(chatRooms).where(eq(chatRooms.id, roomId)).for('update');
      if (!room || !(await this.isMember(roomId, me.id, tx))) throw notFoundRoom();
      if (input.clientMsgId !== undefined) {
        const [dup] = await tx
          .select()
          .from(chatMessages)
          .where(and(eq(chatMessages.roomId, roomId), eq(chatMessages.senderId, me.id), eq(chatMessages.clientMsgId, input.clientMsgId)));
        if (dup) return { message: toMessage(dup), duplicate: true, memberIds: [] as string[] };
      }
      const seq = room.lastSeq + 1;
      const [row] = await tx
        .insert(chatMessages)
        .values({ roomId, seq, senderId: me.id, body: body.body, clientMsgId: input.clientMsgId ?? null })
        .returning();
      await tx.update(chatRooms).set({ lastSeq: seq, lastMessageAt: row!.createdAt }).where(eq(chatRooms.id, roomId));
      await tx.update(chatMembers).set({ lastReadSeq: seq }).where(and(eq(chatMembers.roomId, roomId), eq(chatMembers.userId, me.id)));
      const members = await tx.select({ u: chatMembers.userId }).from(chatMembers).where(eq(chatMembers.roomId, roomId));
      return { message: toMessage(row!), duplicate: false, memberIds: members.map((m) => m.u) };
    });
    if (!out.duplicate) this.hub.publishMessage(out.memberIds, out.message);
    return { message: out.message, duplicate: out.duplicate };
  }

  /** 읽음 표시 — 내려가지 않고, 방의 마지막 번호를 넘지 않는다 */
  async markRead(me: { id: string }, roomId: string, seq: number): Promise<{ lastReadSeq: number }> {
    const [room] = await this.db.select().from(chatRooms).where(eq(chatRooms.id, roomId));
    if (!room || !(await this.isMember(roomId, me.id))) throw notFoundRoom();
    const target = Math.min(seq, room.lastSeq);
    const [row] = await this.db
      .update(chatMembers)
      .set({ lastReadSeq: sql`GREATEST(${chatMembers.lastReadSeq}, ${target})` })
      .where(and(eq(chatMembers.roomId, roomId), eq(chatMembers.userId, me.id)))
      .returning({ lastReadSeq: chatMembers.lastReadSeq });
    // 확인과 쓰기 사이에 방에서 나갔다 — 500이 아니라 없는 방이다
    if (!row) throw notFoundRoom();
    return { lastReadSeq: row.lastReadSeq };
  }

  /** 방에 부를 사람 찾기 — 활성 사용자의 표시 이름만(아이디·메일은 싣지 않는다). 나는 빠진다 */
  async searchUsers(me: { id: string }, q: string, limit: number): Promise<ChatUserView[]> {
    const like = `%${q.replace(/[\\%_]/g, '\\$&')}%`;
    const rows = await this.db
      .select({ id: users.id, displayName: users.displayName })
      .from(users)
      .where(and(eq(users.status, 'active'), ne(users.id, me.id), q === '' ? undefined : sql`${users.displayName} ILIKE ${like}`))
      .orderBy(byName(users.displayName), asc(users.id))
      .limit(limit);
    return rows;
  }
}
