import { CHAT_CLOSE, type ChatServerFrame } from '@workfluence/shared';
import { sign } from 'cookie-signature';
import { sql } from 'drizzle-orm';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { ApiTokensService } from '../api-tokens/api-tokens.service';
import { AuditService } from '../audit/audit.service';
import { RevocationBus } from '../common/revocation.bus';
import { loadEnv, type AppEnvToken } from '../config/config.module';
import { SettingsService } from '../settings/settings.service';
import { closeTestDb, openTestDb, resetTables, type TestDb } from '../test/db';
import { person } from '../test/people';
import { UsersService } from '../users/users.service';
import { CollabGateway } from '../pages/collab/collab.gateway';
import { ChatGateway } from './chat.gateway';
import { ChatHub } from './chat.hub';
import { ChatService } from './chat.service';

/** B등급 (P21_설계서_Chat C절 · FR-2405·2410~2412·2420 · NFR-240·241). 진짜 HTTP 서버와 진짜 WebSocket 클라이언트 */

const SECRET = 'spec-secret-0123456789abcdef0123456789abcdef';

let db: TestDb;
let env: AppEnvToken;
let bus: RevocationBus;
let hub: ChatHub;
let svc: ChatService;
let tokens: ApiTokensService;
let gw: ChatGateway;
let server: Server;
let port = 0;
const open: WebSocket[] = [];

type Client = { ws: WebSocket; frames: ChatServerFrame[]; closed: Promise<number>; next: (type: string) => Promise<ChatServerFrame> };

async function boot(over: Partial<AppEnvToken> = {}): Promise<void> {
  env = { ...loadEnv(), WF_API_JWT_SECRET: SECRET, WF_CHAT_ENABLED: true, WF_CHAT_MAX_MESSAGE_CHARS: 50, WF_CHAT_RECHECK_MS: 0, WF_CHAT_PING_MS: 60_000, ...over };
  bus = new RevocationBus();
  hub = new ChatHub();
  const settings = new SettingsService(db, env);
  const users = new UsersService(db, settings, bus);
  tokens = new ApiTokensService(db, new AuditService(db), users, bus, env);
  svc = new ChatService(db, hub, env);
  gw = new ChatGateway(db, env, svc, hub, users, tokens, settings, bus);
  gw.onModuleInit();
  server = createServer();
  gw.attach(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as AddressInfo).port;
}

beforeAll(async () => {
  ({ db } = await openTestDb());
});
afterAll(closeTestDb);
beforeEach(async () => {
  await resetTables(db);
  await boot();
});
afterEach(async () => {
  for (const w of open.splice(0)) w.terminate();
  await gw.onModuleDestroy();
  await new Promise<void>((r) => server.close(() => r()));
});

async function mkSession(uid: string, createdAt = Date.now()): Promise<string> {
  const sid = `sid-${Math.random().toString(36).slice(2, 10)}`;
  await db.execute(sql`INSERT INTO sessions (sid, sess, expire) VALUES (${sid}, ${JSON.stringify({ userId: uid, createdAt })}::json, now() + interval '1 hour')`);
  return sid;
}
const cookie = (sid: string) => `wf.sid=${encodeURIComponent(`s:${sign(sid, env.WF_SESSION_SECRET)}`)}`;

function attachClient(ws: WebSocket): Client {
  const frames: ChatServerFrame[] = [];
  const waiters: { type: string; resolve: (f: ChatServerFrame) => void }[] = [];
  ws.on('message', (d) => {
    const f = JSON.parse(d.toString()) as ChatServerFrame;
    frames.push(f);
    const i = waiters.findIndex((w) => w.type === f.type);
    if (i >= 0) waiters.splice(i, 1)[0]!.resolve(f);
  });
  const closed = new Promise<number>((r) => ws.on('close', (code) => r(code)));
  const next = (type: string) =>
    new Promise<ChatServerFrame>((resolve, reject) => {
      const found = frames.find((f) => f.type === type);
      if (found) {
        frames.splice(frames.indexOf(found), 1);
        return resolve(found);
      }
      const t = setTimeout(() => reject(new Error(`${type} 프레임이 오지 않았다`)), 2_000);
      waiters.push({ type, resolve: (f) => { clearTimeout(t); frames.splice(frames.indexOf(f), 1); resolve(f); } });
    });
  return { ws, frames, closed, next };
}

/** 열리면 `hello`까지 받은 클라이언트. 거절되면 HTTP 상태를 돌려준다 */
async function connect(path: string, headers: Record<string, string>): Promise<Client | number> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`, { headers });
  open.push(ws);
  const c = attachClient(ws);
  return new Promise((resolve) => {
    ws.once('open', () => void c.next('hello').then(() => resolve(c)));
    ws.once('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0));
    ws.once('error', () => undefined);
  });
}

const asClient = (c: Client | number): Client => {
  if (typeof c === 'number') throw new Error(`연결이 거절됐다: ${c}`);
  return c;
};

async function viaSession(userId: string, host = `127.0.0.1:${port}`): Promise<Client | number> {
  return connect('/api/chat/ws', { Cookie: cookie(await mkSession(userId)), Origin: `http://${host}` });
}
async function viaToken(userId: string, scopes: ('read' | 'write')[]): Promise<{ client: Client | number; tokenId: string; token: string }> {
  const { token, view } = await tokens.create(userId, { name: 't', scopes, expiresInDays: 1 }, null);
  return { client: await connect('/api/v1/chat/ws', { Authorization: `Bearer ${token}` }), tokenId: view.id, token };
}

describe('화면 연결 (FR-2405·2412)', () => {
  it('두 사람이 같은 방에서 주고받는다 — 보낸 사람은 ack와 message 둘 다 받는다', async () => {
    const a = await person(db, 'a');
    const b = await person(db, 'b');
    const { room } = await svc.createRoom(a, { kind: 'direct', userId: b.id });
    const ca = asClient(await viaSession(a.id));
    const cb = asClient(await viaSession(b.id));

    ca.ws.send(JSON.stringify({ type: 'send', roomId: room.id, body: '안녕', clientMsgId: 'c1' }));
    expect(await cb.next('message')).toMatchObject({ roomId: room.id, seq: 1, senderId: a.id, body: '안녕' });
    expect(await ca.next('message')).toMatchObject({ seq: 1, body: '안녕' });
    expect(await ca.next('ack')).toMatchObject({ clientMsgId: 'c1', roomId: room.id, seq: 1 });

    cb.ws.send(JSON.stringify({ type: 'send', roomId: room.id, body: '네' }));
    expect(await ca.next('message')).toMatchObject({ seq: 2, senderId: b.id });
  });

  it('hello가 참여한 방을 알려 주고, 새 방에 초대되면 연결을 다시 열지 않아도 room 프레임이 온다', async () => {
    const a = await person(db, 'a');
    const b = await person(db, 'b');
    const cb = asClient(await viaSession(b.id));
    expect(cb.frames.find((f) => f.type === 'hello')).toBeUndefined(); // connect가 이미 꺼냈다
    const { room } = await svc.createRoom(a, { kind: 'direct', userId: b.id });
    expect(await cb.next('room')).toEqual({ type: 'room', roomId: room.id, change: 'joined' });
    // 그 방의 메시지도 곧바로 받는다
    await svc.send(a, room.id, { body: 'hi' });
    expect(await cb.next('message')).toMatchObject({ body: 'hi' });
  });

  it('출처가 다르거나 없거나 쿠키가 없거나 가짜면 401', async () => {
    const a = await person(db, 'a');
    const sid = await mkSession(a.id);
    expect(await viaSession(a.id, 'evil.example')).toBe(401);
    expect(await connect('/api/chat/ws', { Cookie: cookie(sid) })).toBe(401); // Origin 없음
    expect(await connect('/api/chat/ws', { Origin: `http://127.0.0.1:${port}` })).toBe(401); // 쿠키 없음
    expect(await connect('/api/chat/ws', { Cookie: 'wf.sid=s%3Aforged.sig', Origin: `http://127.0.0.1:${port}` })).toBe(401);
    expect(await connect('/api/chat/ws', { Cookie: cookie('nope'), Origin: `http://127.0.0.1:${port}` })).toBe(401);
  });

  it('정지된 사람·비밀번호 변경이 강제된 사람·절대 타임아웃이 지난 세션은 들어오지 못한다', async () => {
    const s = await person(db, 's', 'member', { status: 'suspended' });
    const m = await person(db, 'm', 'member', { mustChangePassword: true });
    const old = await person(db, 'old');
    expect(await viaSession(s.id)).toBe(401);
    expect(await viaSession(m.id)).toBe(401);
    const sid = await mkSession(old.id, Date.now() - 100 * 3_600_000);
    expect(await connect('/api/chat/ws', { Cookie: cookie(sid), Origin: `http://127.0.0.1:${port}` })).toBe(401);
  });
});

describe('headless 연결 (FR-2410)', () => {
  it('토큰으로 연결해 받고 보낸다 — Origin은 보지 않는다', async () => {
    const a = await person(db, 'a');
    const agent = await person(db, 'agent');
    const { room } = await svc.createRoom(a, { kind: 'direct', userId: agent.id });
    const { client } = await viaToken(agent.id, ['write']);
    const ca = asClient(client);
    await svc.send(a, room.id, { body: '에이전트님' });
    expect(await ca.next('message')).toMatchObject({ body: '에이전트님', senderId: a.id });
    ca.ws.send(JSON.stringify({ type: 'send', roomId: room.id, body: '네, 확인했습니다' }));
    expect(await ca.next('ack')).toMatchObject({ roomId: room.id, seq: 2 });
    expect((await svc.listMessages(a, room.id, {})).map((m) => m.body)).toEqual(['에이전트님', '네, 확인했습니다']);
  });

  it('read 토큰은 받기만 한다 — 보내면 그 메시지만 거절하고 연결은 둔다', async () => {
    const a = await person(db, 'a');
    const agent = await person(db, 'agent');
    const { room } = await svc.createRoom(a, { kind: 'direct', userId: agent.id });
    const ca = asClient((await viaToken(agent.id, ['read'])).client);
    ca.ws.send(JSON.stringify({ type: 'send', roomId: room.id, body: 'x', clientMsgId: 'k' }));
    expect(await ca.next('error')).toEqual({ type: 'error', code: 'INSUFFICIENT_SCOPE', roomId: room.id, clientMsgId: 'k' });
    expect(ca.ws.readyState).toBe(WebSocket.OPEN);
    expect(await svc.listMessages(a, room.id, {})).toEqual([]);
  });

  it('토큰이 없거나 가짜이거나 질의로 주면 401 — 토큰은 질의로 받지 않는다', async () => {
    const a = await person(db, 'a');
    const { token } = await viaToken(a.id, ['read']);
    expect(await connect('/api/v1/chat/ws', {})).toBe(401);
    expect(await connect('/api/v1/chat/ws', { Authorization: 'Bearer abc.def.ghi' })).toBe(401);
    expect(await connect(`/api/v1/chat/ws?token=${token}`, {})).toBe(401);
  });

  it('세션 쿠키로는 headless 경로에 들어가지 못한다', async () => {
    const a = await person(db, 'a');
    expect(await connect('/api/v1/chat/ws', { Cookie: cookie(await mkSession(a.id)), Origin: `http://127.0.0.1:${port}` })).toBe(401);
  });
});

describe('순서 (FR-2404)', () => {
  it('한 연결이 연달아 보낸 메시지는 보낸 순서대로 번호를 받는다', async () => {
    const a = await person(db, 'a');
    const b = await person(db, 'b');
    const { room } = await svc.createRoom(a, { kind: 'direct', userId: b.id });
    const c = asClient(await viaSession(a.id));
    for (let i = 0; i < 20; i++) c.ws.send(JSON.stringify({ type: 'send', roomId: room.id, body: `m${i}` }));
    for (let i = 0; i < 20; i++) await c.next('ack');
    expect((await svc.listMessages(a, room.id, { limit: 50 })).map((m) => m.body)).toEqual(Array.from({ length: 20 }, (_, i) => `m${i}`));
  });
});

describe('받지 않는 프레임 (C.2)', () => {
  it('모르는 type·모르는 칸·JSON이 아닌 글·바이너리는 연결을 닫는다', async () => {
    const a = await person(db, 'a');
    for (const bad of ['{', '[]', JSON.stringify({ type: 'drop' }), JSON.stringify({ type: 'send', roomId: 'x', body: 'y' }), Buffer.from([1, 2, 3])]) {
      const c = asClient(await viaSession(a.id));
      c.ws.send(bad);
      expect(await c.closed).toBe(CHAT_CLOSE.badFrame);
    }
  });
  it('본문 문제는 그 메시지만 거절한다', async () => {
    const a = await person(db, 'a');
    const b = await person(db, 'b');
    const { room } = await svc.createRoom(a, { kind: 'direct', userId: b.id });
    const c = asClient(await viaSession(a.id));
    c.ws.send(JSON.stringify({ type: 'send', roomId: room.id, body: ' ' }));
    expect(await c.next('error')).toMatchObject({ code: 'EMPTY', roomId: room.id });
    c.ws.send(JSON.stringify({ type: 'send', roomId: room.id, body: 'x'.repeat(51) }));
    expect(await c.next('error')).toMatchObject({ code: 'TOO_LONG' });
    expect(c.ws.readyState).toBe(WebSocket.OPEN);
  });
  it('참여하지 않은 방에 보내면 ROOM_NOT_FOUND — 연결은 둔다', async () => {
    const a = await person(db, 'a');
    const b = await person(db, 'b');
    const c = await person(db, 'c');
    const { room } = await svc.createRoom(a, { kind: 'direct', userId: b.id });
    const cc = asClient(await viaSession(c.id));
    cc.ws.send(JSON.stringify({ type: 'send', roomId: room.id, body: 'x' }));
    expect(await cc.next('error')).toMatchObject({ code: 'ROOM_NOT_FOUND' });
  });
  it('프레임이 상한을 넘으면 1009로 닫는다', async () => {
    const a = await person(db, 'a');
    const c = asClient(await viaSession(a.id));
    c.ws.send('x'.repeat(env.WF_CHAT_MAX_FRAME_BYTES + 1));
    expect(await c.closed).toBe(1009);
  });
});

describe('보내기 한도·연결 상한 (NFR-240·241)', () => {
  it('연결마다 분당 한도를 넘으면 그 메시지만 RATE_LIMITED', async () => {
    await gw.onModuleDestroy();
    await new Promise<void>((r) => server.close(() => r()));
    await boot({ WF_CHAT_SEND_PER_MIN: 2 });
    const a = await person(db, 'a');
    const b = await person(db, 'b');
    const { room } = await svc.createRoom(a, { kind: 'direct', userId: b.id });
    const c = asClient(await viaSession(a.id));
    for (let i = 0; i < 3; i++) c.ws.send(JSON.stringify({ type: 'send', roomId: room.id, body: `m${i}` }));
    expect(await c.next('error')).toMatchObject({ code: 'RATE_LIMITED' });
    await c.next('ack');
    await c.next('ack');
    expect((await svc.listMessages(a, room.id, {})).length).toBe(2);
  });
  it('동시 연결 상한을 넘으면 가장 오래된 연결을 닫는다', async () => {
    await gw.onModuleDestroy();
    await new Promise<void>((r) => server.close(() => r()));
    await boot({ WF_CHAT_MAX_CONNECTIONS_PER_USER: 2 });
    const a = await person(db, 'a');
    const c1 = asClient(await viaSession(a.id));
    const c2 = asClient(await viaSession(a.id));
    const c3 = asClient(await viaSession(a.id));
    expect(await c1.closed).toBe(CHAT_CLOSE.evicted);
    expect(c2.ws.readyState).toBe(WebSocket.OPEN);
    expect(c3.ws.readyState).toBe(WebSocket.OPEN);
    expect(gw.connectionCount).toBe(2);
  });
});

describe('끊기 (FR-2411)', () => {
  it('세션을 모두 끊으면(비밀번호 변경·강제 종료) 그 사람의 화면·headless 연결이 모두 끊긴다. 다른 사람은 그대로', async () => {
    const a = await person(db, 'a');
    const b = await person(db, 'b');
    const s = asClient(await viaSession(a.id));
    const t = asClient((await viaToken(a.id, ['write'])).client);
    const other = asClient(await viaSession(b.id));
    bus.revoke(a.id);
    expect(await s.closed).toBe(CHAT_CLOSE.revoked);
    expect(await t.closed).toBe(CHAT_CLOSE.revoked);
    expect(other.ws.readyState).toBe(WebSocket.OPEN);
  });
  it('로그아웃은 그 세션의 연결만 끊는다', async () => {
    const a = await person(db, 'a');
    const sid1 = await mkSession(a.id);
    const sid2 = await mkSession(a.id);
    const h = (sid: string) => ({ Cookie: cookie(sid), Origin: `http://127.0.0.1:${port}` });
    const c1 = asClient(await connect('/api/chat/ws', h(sid1)));
    const c2 = asClient(await connect('/api/chat/ws', h(sid2)));
    const t = asClient((await viaToken(a.id, ['read'])).client);
    bus.revoke(a.id, sid1);
    expect(await c1.closed).toBe(CHAT_CLOSE.revoked);
    expect(c2.ws.readyState).toBe(WebSocket.OPEN);
    expect(t.ws.readyState).toBe(WebSocket.OPEN);
  });
  it('토큰 하나를 폐기하면 그 토큰의 연결만 끊는다 — 같은 사람의 다른 토큰·화면 연결은 그대로', async () => {
    const a = await person(db, 'a');
    const one = await viaToken(a.id, ['write']);
    const two = await viaToken(a.id, ['write']);
    const c1 = asClient(one.client);
    const c2 = asClient(two.client);
    const s = asClient(await viaSession(a.id));
    await tokens.revoke(a.id, one.tokenId, null);
    expect(await c1.closed).toBe(CHAT_CLOSE.revoked);
    expect(c2.ws.readyState).toBe(WebSocket.OPEN);
    expect(s.ws.readyState).toBe(WebSocket.OPEN);
  });
  it('주기 재판정이 만료·정지·세션 삭제를 잡는다', async () => {
    const a = await person(db, 'a');
    const b = await person(db, 'b');
    const c = await person(db, 'c');
    const sidA = await mkSession(a.id);
    const ca = asClient(await connect('/api/chat/ws', { Cookie: cookie(sidA), Origin: `http://127.0.0.1:${port}` }));
    const cb = asClient(await viaSession(b.id));
    const tk = await viaToken(c.id, ['write']);
    const cc = asClient(tk.client);
    await db.execute(sql`DELETE FROM sessions WHERE sid = ${sidA}`);
    await db.execute(sql`UPDATE users SET status = 'suspended' WHERE id = ${b.id}`);
    await db.execute(sql`UPDATE api_tokens SET expires_at = now() - interval '1 second', created_at = now() - interval '1 day' WHERE id = ${tk.tokenId}`);
    await (gw as unknown as { recheck(): Promise<void> }).recheck();
    expect(await ca.closed).toBe(CHAT_CLOSE.revoked);
    expect(await cb.closed).toBe(CHAT_CLOSE.revoked);
    expect(await cc.closed).toBe(CHAT_CLOSE.revoked);
  });
  it('판정이 아직 안 돌아올 주기면 건드리지 않는다', async () => {
    await gw.onModuleDestroy();
    await new Promise<void>((r) => server.close(() => r()));
    await boot({ WF_CHAT_RECHECK_MS: 3_600_000 });
    const a = await person(db, 'a');
    const sid = await mkSession(a.id);
    const c = asClient(await connect('/api/chat/ws', { Cookie: cookie(sid), Origin: `http://127.0.0.1:${port}` }));
    await db.execute(sql`DELETE FROM sessions WHERE sid = ${sid}`);
    await (gw as unknown as { recheck(): Promise<void> }).recheck();
    expect(c.ws.readyState).toBe(WebSocket.OPEN);
  });
});

describe('끄기 (FR-2420)', () => {
  it('꺼져 있으면 채팅 경로는 404로 닫힌다 — 응답 없이 열려 남지 않는다', async () => {
    await gw.onModuleDestroy();
    await new Promise<void>((r) => server.close(() => r()));
    await boot({ WF_CHAT_ENABLED: false });
    const a = await person(db, 'a');
    expect(await viaSession(a.id)).toBe(404);
    expect((await viaToken(a.id, ['read'])).client).toBe(404);
  });
});

describe('편집 게이트웨이와 같은 서버에서 (C.1)', () => {
  it('편집 게이트웨이는 채팅 경로를 건드리지 않는다 — 404로 닫지도 소켓을 파괴하지도 않는다', async () => {
    const collab = new CollabGateway(...(Array(9).fill({}) as ConstructorParameters<typeof CollabGateway>));
    const calls: string[] = [];
    const socket = { on: () => undefined, write: (s: string) => calls.push(`write:${s}`), destroy: () => calls.push('destroy') };
    for (const url of ['/api/chat/ws', '/api/v1/chat/ws?x=1']) {
      await (collab as unknown as { upgrade(r: unknown, s: unknown, h: Buffer): Promise<void> }).upgrade({ url, headers: {} }, socket, Buffer.alloc(0));
    }
    expect(calls).toEqual([]);
    // 편집 경로가 아닌 것은 그대로 404다(P6 자체 점검 13)
    await (collab as unknown as { upgrade(r: unknown, s: unknown, h: Buffer): Promise<void> }).upgrade({ url: '/other', headers: {} }, socket, Buffer.alloc(0));
    expect(calls).toEqual([expect.stringContaining('404'), 'destroy']);
  });
});
