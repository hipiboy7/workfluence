import { z } from 'zod';
import { idSchema } from './schemas';

/**
 * 채팅의 **순수 규칙** (A등급, P21_설계서_Chat B·C·D절). 서버(`apps/api/src/chat/`)와 화면이 같은 것을 쓴다 — 프레임 모양·본문 판정·쪽 나누기를 따로 적으면 한쪽만 바뀐다(1.3절).
 * 설정으로 바뀌는 값(글자 상한)은 인자로 받는다 — 이 파일은 환경을 읽지 않는다.
 */

/** 설계 고정값 — 바꾸면 계약이 바뀐다 (5절 둘째 줄) */
export const CHAT_LIMITS = {
  /** `clientMsgId`의 최대 글자 수 */
  maxClientMsgIdChars: 64,
  pageDefault: 50,
  pageMax: 200,
  /** 여럿 방의 이름 */
  maxRoomNameChars: 100,
  /** 방을 만들 때 부를 수 있는 사람 수 */
  maxRoomMembers: 100,
} as const;

export type ChatRoomKind = 'direct' | 'group';

export type ChatBodyProblem = 'NOT_TEXT' | 'EMPTY' | 'TOO_LONG' | 'BAD_CHAR';

// 줄바꿈(\n)·탭(\t)을 뺀 제어 문자와 NUL — 화면·로그·DB를 어지럽힌다
// eslint-disable-next-line no-control-regex
const BAD_CHARS = /[\u0000-\u0008\u000b-\u001f\u007f]/;

/** 메시지 본문 판정 (A.1-3). 평문이다 — 앞뒤 공백은 고치지 않고 **비었는지만** 본다. 글자 수는 코드 포인트로 센다 */
export function validateChatBody(body: unknown, maxChars: number): { ok: true; body: string } | { ok: false; code: ChatBodyProblem } {
  if (typeof body !== 'string') return { ok: false, code: 'NOT_TEXT' };
  if (body.trim().length === 0) return { ok: false, code: 'EMPTY' };
  if (BAD_CHARS.test(body)) return { ok: false, code: 'BAD_CHAR' };
  if ([...body].length > maxChars) return { ok: false, code: 'TOO_LONG' };
  return { ok: true, body };
}

/** 클라이언트 → 서버 프레임 (C.2). 지금은 `send` 하나다 */
export type ChatClientFrame = { type: 'send'; roomId: string; body: string; clientMsgId?: string };

/** 서버 → 클라이언트 프레임 (C.2) */
export type ChatServerFrame =
  | { type: 'hello'; userId: string; roomIds: string[] }
  | { type: 'ack'; clientMsgId: string | null; roomId: string; seq: number; createdAt: string }
  | { type: 'message'; roomId: string; seq: number; senderId: string; body: string; createdAt: string }
  | { type: 'room'; roomId: string; change: 'joined' | 'left' }
  | { type: 'error'; code: string; roomId?: string; clientMsgId?: string };

export function encodeChatFrame(frame: ChatServerFrame): string {
  return JSON.stringify(frame);
}

export type ChatFrameResult =
  | { ok: true; frame: ChatClientFrame }
  /** 조작·고장 — 연결을 닫는다 */
  | { ok: false; code: 'BAD_FRAME' | 'UNKNOWN_TYPE' }
  /** 그 메시지만 거절하고 연결은 둔다 — 어느 방의 어느 메시지인지 되돌려 줄 수 있다 */
  | { ok: false; code: ChatBodyProblem; recoverable: true; roomId: string; clientMsgId: string | undefined };

const SEND_KEYS = new Set(['type', 'roomId', 'body', 'clientMsgId']);

/** 클라이언트가 보낸 글자 한 덩어리를 프레임으로 읽는다. 모르는 칸·모르는 type은 받지 않는다 — 조작한 연결이 서버에 일을 시키지 못하게 (C.2) */
export function parseChatClientFrame(text: string, maxChars: number): ChatFrameResult {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, code: 'BAD_FRAME' };
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { ok: false, code: 'BAD_FRAME' };
  const o = raw as Record<string, unknown>;
  if (o.type !== 'send') return { ok: false, code: 'UNKNOWN_TYPE' };
  if (Object.keys(o).some((k) => !SEND_KEYS.has(k))) return { ok: false, code: 'BAD_FRAME' };
  const room = idSchema.safeParse(o.roomId);
  if (!room.success) return { ok: false, code: 'BAD_FRAME' };
  let clientMsgId: string | undefined;
  if (o.clientMsgId !== undefined) {
    if (typeof o.clientMsgId !== 'string' || o.clientMsgId.length === 0 || o.clientMsgId.length > CHAT_LIMITS.maxClientMsgIdChars) {
      return { ok: false, code: 'BAD_FRAME' };
    }
    clientMsgId = o.clientMsgId;
  }
  const body = validateChatBody(o.body, maxChars);
  if (!body.ok) return { ok: false, code: body.code, recoverable: true, roomId: room.data, clientMsgId };
  return { ok: true, frame: { type: 'send', roomId: room.data, body: body.body, ...(clientMsgId !== undefined ? { clientMsgId } : {}) } };
}

/** 1:1 방의 쌍 — 두 사람의 순서와 대소문자에 상관없이 같은 값(`user_a < user_b`). 같은 사람끼리는 없다 (D `chat_direct_pairs`) */
export function directPairKey(x: string, y: string): [string, string] | null {
  const a = x.toLowerCase();
  const b = y.toLowerCase();
  if (a === b) return null;
  return a < b ? [a, b] : [b, a];
}

/** 초대는 여럿 방을 **만든 사람**만 한다 (A.1-2). 1:1 방은 사람을 더하지 못한다 */
export function canInviteToRoom(room: { kind: ChatRoomKind; createdBy: string }, userId: string): boolean {
  return room.kind === 'group' && room.createdBy.toLowerCase() === userId.toLowerCase();
}

/** 메시지 쪽 나누기 (FR-2403·2406) — `before`는 그 번호보다 이전(없으면 가장 새 것부터), `after`는 그 번호보다 이후 */
export function messagePageQuery(q: {
  beforeSeq?: number;
  afterSeq?: number;
  limit?: number;
}): { ok: true; dir: 'before' | 'after'; seq: number | null; limit: number } | { ok: false } {
  const isSeq = (n: number | undefined): boolean => n === undefined || (Number.isInteger(n) && n >= 0);
  if (!isSeq(q.beforeSeq) || !isSeq(q.afterSeq)) return { ok: false };
  if (q.beforeSeq !== undefined && q.afterSeq !== undefined) return { ok: false };
  let limit: number = CHAT_LIMITS.pageDefault;
  if (q.limit !== undefined) {
    if (!Number.isInteger(q.limit) || q.limit < 1) return { ok: false };
    limit = Math.min(q.limit, CHAT_LIMITS.pageMax);
  }
  if (q.afterSeq !== undefined) return { ok: true, dir: 'after', seq: q.afterSeq, limit };
  return { ok: true, dir: 'before', seq: q.beforeSeq ?? null, limit };
}

/** 안 읽은 수 = 방의 마지막 번호 − 내가 읽은 번호 (FR-2407) */
export function unreadCount(lastSeq: number, lastReadSeq: number): number {
  return Math.max(0, lastSeq - lastReadSeq);
}

// ---- 요청 본문·질의 (E절) ----

/** 방 만들기 — 1:1은 상대 한 사람, 여럿은 이름과 부를 사람들(만든 사람은 자동으로 든다) */
export const createChatRoomDto = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('direct'), userId: idSchema }).strict(),
  z
    .object({
      kind: z.literal('group'),
      name: z.string().trim().min(1).max(CHAT_LIMITS.maxRoomNameChars),
      userIds: z.array(idSchema).min(1).max(CHAT_LIMITS.maxRoomMembers),
    })
    .strict(),
]);
export type CreateChatRoomDto = z.infer<typeof createChatRoomDto>;

export const inviteChatMembersDto = z.object({ userIds: z.array(idSchema).min(1).max(CHAT_LIMITS.maxRoomMembers) }).strict();
export type InviteChatMembersDto = z.infer<typeof inviteChatMembersDto>;

/** 본문 글자 수 상한은 설정(`WF_CHAT_MAX_MESSAGE_CHARS`)이라 서버가 `validateChatBody`로 한 번 더 본다 */
export const sendChatMessageDto = z
  .object({ body: z.string(), clientMsgId: z.string().min(1).max(CHAT_LIMITS.maxClientMsgIdChars).optional() })
  .strict();
export type SendChatMessageDto = z.infer<typeof sendChatMessageDto>;

export const markChatReadDto = z.object({ seq: z.number().int().min(0) }).strict();
export type MarkChatReadDto = z.infer<typeof markChatReadDto>;

export const chatMessagesQueryDto = z.object({
  beforeSeq: z.coerce.number().int().min(0).optional(),
  afterSeq: z.coerce.number().int().min(0).optional(),
  limit: z.coerce.number().int().min(1).optional(),
});
export type ChatMessagesQueryDto = z.infer<typeof chatMessagesQueryDto>;

export const chatUserSearchDto = z.object({ q: z.string().trim().max(100).default(''), limit: z.coerce.number().int().min(1).max(50).default(20) });

// ---- 응답 ----

export type ChatMessageView = { id: string; roomId: string; seq: number; senderId: string; body: string; createdAt: string };

export type ChatRoomView = {
  id: string;
  kind: ChatRoomKind;
  /** 여럿 방의 이름. 1:1은 null — 화면이 상대의 이름을 그린다 */
  name: string | null;
  createdBy: string;
  members: { userId: string; displayName: string }[];
  lastSeq: number;
  lastMessageAt: string | null;
  lastMessage: ChatMessageView | null;
  unread: number;
};

export type ChatUserView = { id: string; displayName: string };

/** 서버가 연결을 닫을 때의 코드(4000대는 응용이 정한다). 클라이언트가 까닭을 알아 다시 붙을지 정한다 */
export const CHAT_CLOSE = {
  /** 모르는 프레임·모르는 type·글이 아닌 프레임 — 조작·고장. 같은 것을 다시 보내도 닫힌다 */
  badFrame: 4400,
  /** 세션·토큰이 죽었다 — 다시 붙지 말고 새로 인증한다 */
  revoked: 4401,
  /** 같은 사용자의 연결이 상한을 넘어 가장 오래된 연결이 닫혔다 */
  evicted: 4409,
} as const;
