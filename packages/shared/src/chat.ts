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
  /** 메시지 번호의 상한 — JS가 정확히 다루는 정수(DB의 bigint보다 작다). 넘는 값은 거절한다(질의가 DB 오류가 되지 않게) */
  maxSeq: Number.MAX_SAFE_INTEGER,
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

/** 메시지의 종류 — `user`는 사람이 보낸 것, `join`·`leave`는 방에 사람이 들어오고 나갈 때 시스템이 넣는 안내 줄이다(F-019) */
export const CHAT_MESSAGE_KINDS = ['user', 'join', 'leave'] as const;
export type ChatMessageKind = (typeof CHAT_MESSAGE_KINDS)[number];

/** 안내 줄의 문장 — 시스템이 넣은 줄은 이 문장으로만 만든다. 이름은 그때의 표시 이름이다 */
export function chatNoticeText(kind: Exclude<ChatMessageKind, 'user'>, displayName: string): string {
  return kind === 'join' ? `${displayName}님이 채팅방에 들어왔습니다` : `${displayName}님이 채팅방을 나갔습니다`;
}

/** 안내 줄인가 — 안 읽은 수를 올리지 않고, 화면은 말풍선이 아니라 가운데 한 줄로 그린다 */
export function isChatNotice(kind: ChatMessageKind): boolean {
  return kind !== 'user';
}

/** 클라이언트 → 서버 프레임 (C.2). 지금은 `send` 하나다 */
export type ChatClientFrame = { type: 'send'; roomId: string; body: string; clientMsgId?: string };

/** 서버 → 클라이언트 프레임 (C.2) */
export type ChatServerFrame =
  | { type: 'hello'; userId: string; roomIds: string[] }
  | { type: 'ack'; clientMsgId: string | null; roomId: string; seq: number; createdAt: string }
  | { type: 'message'; roomId: string; seq: number; senderId: string; body: string; kind: ChatMessageKind; createdAt: string }
  /** `joined`·`left`는 당사자에게, `members`는 방에 남은 다른 참여자에게(초대·나감으로 참여자 목록이 바뀌었다) */
  | { type: 'room'; roomId: string; change: 'joined' | 'left' | 'members' }
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
// 칸마다 `.describe`가 있다 — 공개 API 명세(`v1-spec.ts`)가 그대로 싣는다(설명이 빠지면 `v1-spec.spec.ts`가 실패한다)

/** 방 만들기 — 1:1은 상대 한 사람, 여럿은 이름과 부를 사람들(만든 사람은 자동으로 든다) */
export const createChatRoomDto = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('direct').describe('방의 종류 — `direct`는 1:1 방(두 사람 사이에 하나뿐이라 이미 있으면 그 방을 돌려준다)'),
      userId: idSchema.describe('상대 사용자의 id — `GET /chat/users`로 찾는다. 자기 자신·정지·승인 대기 사용자는 안 된다'),
    })
    .strict(),
  z
    .object({
      kind: z.literal('group').describe('방의 종류 — `group`은 이름이 있는 여럿 방(만든 사람이 초대한다)'),
      name: z.string().trim().min(1).max(CHAT_LIMITS.maxRoomNameChars).describe(`여럿 방의 이름 — 1~${CHAT_LIMITS.maxRoomNameChars}자`),
      userIds: z.array(idSchema).min(1).max(CHAT_LIMITS.maxRoomMembers).describe(`방에 부를 사용자들의 id — 1~${CHAT_LIMITS.maxRoomMembers}명(만든 사람은 빼도 든다). 하나라도 부를 수 없으면 404 \`USER_NOT_FOUND\``),
    })
    .strict(),
]);
export type CreateChatRoomDto = z.infer<typeof createChatRoomDto>;

export const inviteChatMembersDto = z
  .object({ userIds: z.array(idSchema).min(1).max(CHAT_LIMITS.maxRoomMembers).describe(`초대할 사용자들의 id — 1~${CHAT_LIMITS.maxRoomMembers}명. 이미 든 사람은 그대로 둔다`) })
  .strict();
export type InviteChatMembersDto = z.infer<typeof inviteChatMembersDto>;

/** 본문 글자 수 상한은 설정(`WF_CHAT_MAX_MESSAGE_CHARS`)이라 서버가 `validateChatBody`로 한 번 더 본다 */
export const sendChatMessageDto = z
  .object({
    body: z.string().describe('메시지 본문 — 평문(마크다운·HTML로 해석하지 않는다). 공백뿐이거나 제어 문자가 있거나 서버 상한(기본 4000자)을 넘으면 400 `EMPTY`·`BAD_CHAR`·`TOO_LONG`'),
    clientMsgId: z
      .string()
      .min(1)
      .max(CHAT_LIMITS.maxClientMsgIdChars)
      .optional()
      .describe(`보내는 쪽이 정하는 중복 방지 값 — 1~${CHAT_LIMITS.maxClientMsgIdChars}자. 같은 방에서 같은 사람이 같은 값을 되풀이하면 한 번만 받고 응답의 \`duplicate\`가 true다(끊겼다 다시 보낼 때 쓴다). 안 주면 중복을 막지 않는다`),
  })
  .strict();
export type SendChatMessageDto = z.infer<typeof sendChatMessageDto>;

export const markChatReadDto = z
  .object({ seq: z.number().int().min(0).max(CHAT_LIMITS.maxSeq).describe('여기까지 읽었다는 메시지 번호 — 내려가지 않고 방의 마지막 번호를 넘으면 마지막 번호로 줄인다') })
  .strict();
export type MarkChatReadDto = z.infer<typeof markChatReadDto>;

export const chatMessagesQueryDto = z.object({
  beforeSeq: z.coerce.number().int().min(0).max(CHAT_LIMITS.maxSeq).optional().describe('이 번호보다 **이전** 메시지를 읽는다(옛 메시지로 거슬러 간다). `afterSeq`와 함께 줄 수 없다'),
  afterSeq: z.coerce.number().int().min(0).max(CHAT_LIMITS.maxSeq).optional().describe('이 번호보다 **이후** 메시지를 읽는다(끊겼다 돌아와 놓친 것을 받는다 — 마지막으로 받은 `seq`를 준다). `beforeSeq`와 함께 줄 수 없다'),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .optional()
    .describe(`돌려줄 가장 많은 수 — 1 이상, 안 주면 ${CHAT_LIMITS.pageDefault}, ${CHAT_LIMITS.pageMax}를 넘으면 ${CHAT_LIMITS.pageMax}로 줄인다. 번호를 안 주면 가장 새 메시지부터 그만큼`),
});
export type ChatMessagesQueryDto = z.infer<typeof chatMessagesQueryDto>;

export const chatUserSearchDto = z.object({
  q: z.string().trim().max(100).default('').describe('찾을 말 — 표시 이름의 일부(대소문자 무시). 안 주면 이름 순으로 앞에서부터'),
  limit: z.coerce.number().int().min(1).max(50).default(20).describe('돌려줄 가장 많은 수 — 1~50, 기본 20'),
});

// ---- 응답 ----

const iso = z.string().describe('ISO 8601 시각(UTC)');

export const chatMessageSchema = z.object({
  id: z.string().describe('메시지의 id'),
  roomId: z.string().describe('방의 id'),
  seq: z.number().int().describe('방 안의 번호 — 1부터 이어지고 비지도 겹치지도 않는다. 같은 방에서 번호 순서가 곧 도착 순서다'),
  senderId: z.string().describe('보낸 사용자의 id'),
  body: z.string().describe('본문(평문)'),
  kind: z.enum(CHAT_MESSAGE_KINDS).describe('종류 — `user`는 사람이 보낸 메시지, `join`·`leave`는 사람이 들어오고 나갈 때 시스템이 넣은 안내 줄이다(`senderId`는 그 일을 한 사람). 안내 줄은 사람의 말이 아니니 답하지 않는다'),
  createdAt: iso.describe('보낸 시각'),
});
export type ChatMessageView = z.infer<typeof chatMessageSchema>;

export const chatRoomSchema = z.object({
  id: z.string().describe('방의 id'),
  kind: z.enum(['direct', 'group']).describe('`direct`는 1:1, `group`은 이름이 있는 여럿 방'),
  name: z.string().nullable().describe('여럿 방의 이름 — 1:1은 null(상대의 이름을 보여 준다)'),
  createdBy: z.string().describe('만든 사용자의 id — 여럿 방은 만든 사람만 초대한다'),
  members: z.array(z.object({ userId: z.string().describe('참여자의 id'), displayName: z.string().describe('참여자의 표시 이름') })).describe('참여자들(표시 이름 순)'),
  lastSeq: z.number().int().describe('방의 마지막 메시지 번호 — 메시지가 없으면 0'),
  lastMessageAt: iso.nullable().describe('마지막 메시지의 시각 — 없으면 null'),
  lastMessage: chatMessageSchema.nullable().describe('마지막 메시지 — 없으면 null'),
  unread: z.number().int().describe('내가 안 읽은 메시지 수 — 내가 보낸 것은 읽은 것으로 친다'),
});
export type ChatRoomView = z.infer<typeof chatRoomSchema>;

export const chatRoomCreatedSchema = chatRoomSchema.extend({ created: z.boolean().describe('이번 요청이 방을 새로 만들었으면 true — 이미 있던 1:1 방을 돌려준 것이면 false') });

export const chatSentSchema = chatMessageSchema.extend({
  duplicate: z.boolean().describe('같은 `clientMsgId`의 되풀이라 새로 만들지 않고 처음 받은 메시지를 돌려줬으면 true(다시 알리지도 않는다)'),
});

export const chatReadSchema = z.object({ lastReadSeq: z.number().int().describe('지금 내가 읽은 마지막 번호') });

export const chatUserSchema = z.object({ id: z.string().describe('사용자의 id'), displayName: z.string().describe('표시 이름') });
export type ChatUserView = z.infer<typeof chatUserSchema>;

/** 서버가 연결을 닫을 때의 코드(4000대는 응용이 정한다). 클라이언트가 까닭을 알아 다시 붙을지 정한다 */
export const CHAT_CLOSE = {
  /** 모르는 프레임·모르는 type·글이 아닌 프레임 — 조작·고장. 같은 것을 다시 보내도 닫힌다 */
  badFrame: 4400,
  /** 세션·토큰이 죽었다 — 다시 붙지 말고 새로 인증한다 */
  revoked: 4401,
  /** 같은 사용자의 연결이 상한을 넘어 가장 오래된 연결이 닫혔다 */
  evicted: 4409,
} as const;
