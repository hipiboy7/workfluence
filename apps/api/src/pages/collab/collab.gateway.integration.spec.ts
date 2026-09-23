import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DocNode, Principal } from '@workfluence/shared';
import * as Y from 'yjs';
import { AuditService } from '../../audit/audit.service';
import { RevocationBus } from '../../common/revocation.bus';
import { loadEnv, type AppEnvToken } from '../../config/config.module';
import { InAppChannel, NotificationsService } from '../../notifications/notifications.service';
import { SettingsService } from '../../settings/settings.service';
import { SpacesService } from '../../spaces/spaces.service';
import { UsersService } from '../../users/users.service';
import { closeTestDb, openTestDb, resetTables, type TestDb } from '../../test/db';
import { PagesService } from '../pages.service';
import { yDocFromDoc } from '../domain/ydoc';
import { CollabGateway } from './collab.gateway';

/**
 * B등급 통합 — **실제 PostgreSQL** (3절).
 *
 * **왜 이 파일이 생겼나.** 이 게이트웨이는 저장소에서 상태가 가장 복잡한 368줄인데
 * 단위·통합 테스트가 한 건도 없었다 (P6 코드 리뷰 12). 그 사이에 "창을 닫으면
 * 프로세스가 죽는다", "접속만 해도 작성자가 바뀐다", "방이 고아가 되어 편집이 통째로
 * 사라진다"가 함께 들어와 있었다. 전부 **한 번 돌려 보면 드러나는 것**이다.
 *
 * 소켓은 가짜를 쓴다. 진짜 WebSocket을 띄우면 이 파일이 확인하는 것이 프로토콜이
 * 되는데, 확인하고 싶은 것은 **방의 상태 기계**다.
 */

type FakeSocket = {
  sent: Buffer[];
  closed: { code?: number; reason?: string } | null;
  terminated: boolean;
  pinged: number;
  readyState: number;
  OPEN: number;
  send(d: Buffer): void;
  close(code?: number, reason?: string): void;
  terminate(): void;
  ping(): void;
  on(event: string, fn: (...a: never[]) => void): void;
  emit(event: string, ...a: unknown[]): void;
};

function fakeSocket(): FakeSocket {
  const handlers = new Map<string, ((...a: never[]) => void)[]>();
  return {
    sent: [],
    closed: null,
    terminated: false,
    pinged: 0,
    readyState: 1,
    OPEN: 1,
    send(d) {
      this.sent.push(d);
    },
    close(code, reason) {
      this.closed = { code, reason };
      this.readyState = 3;
      this.emit('close');
    },
    terminate() {
      this.terminated = true;
      this.readyState = 3;
    },
    ping() {
      this.pinged += 1;
    },
    on(event, fn) {
      handlers.set(event, [...(handlers.get(event) ?? []), fn]);
    },
    emit(event, ...a) {
      for (const fn of handlers.get(event) ?? []) (fn as (...x: unknown[]) => void)(...a);
    },
  };
}

/**
 * 게이트웨이의 안쪽을 직접 부른다.
 *
 * `upgrade()`를 타려면 진짜 `IncomingMessage`와 HTTP 서버가 필요하다. 그 배선은
 * E2E가 이미 브라우저로 확인한다 (`e2e/collab.spec.ts`). 여기서 확인하는 것은
 * **방을 얻고, 붙고, 쓸고, 끊는** 안쪽이다.
 */
type Internals = {
  room(pageId: string, versionNo: number): Promise<{ doc: Y.Doc; lastActor: string | null; members: Set<unknown> }>;
  join(pageId: string, room: unknown, socket: unknown, principal: Principal, name: string, sid: string, spaceId: string): void;
  sweep(): Promise<void>;
  heartbeat(): void;
  rooms: Map<string, { lastActor: string | null; members: Set<unknown> }>;
};

let db: TestDb;
let gw: CollabGateway;
let inner: Internals;
let bus: RevocationBus;
let env: AppEnvToken;
let userId = '';
let otherId = '';
let spaceId = '';
let pageId = '';
let sid = '';

const HASH = '$argon2id$v=19$m=65536,t=3,p=4$c2FsdA$aGFzaA';
const doc = (t: string): DocNode => ({ type: 'doc', attrs: { schemaVersion: 1 }, content: [{ type: 'paragraph', content: [{ type: 'text', text: t }] }] });

async function mkUser(username: string): Promise<string> {
  const r = await db.execute<{ id: string }>(
    sql`INSERT INTO users (username, display_name, role, status, password_hash) VALUES (${username}, ${username}, 'admin', 'active', ${HASH}) RETURNING id`,
  );
  return r.rows[0].id;
}

async function mkSession(uid: string, createdAt = Date.now()): Promise<string> {
  const id = `sid-${uid.slice(0, 8)}-${Math.random().toString(36).slice(2, 8)}`;
  await db.execute(
    sql`INSERT INTO sessions (sid, sess, expire) VALUES (${id}, ${JSON.stringify({ userId: uid, createdAt })}::json, now() + interval '1 hour')`,
  );
  return id;
}

/** 실제로 글자를 바꾸는 Yjs 변경을 만든다 */
function editUpdate(from: Y.Doc, text: string): Buffer {
  const client = new Y.Doc();
  Y.applyUpdate(client, Y.encodeStateAsUpdate(from));
  const frag = client.getXmlFragment('default');
  const p = new Y.XmlElement('paragraph');
  p.insert(0, [new Y.XmlText(text)]);
  frag.insert(frag.length, [p]);
  return Buffer.concat([Buffer.of(0), Buffer.from(Y.encodeStateAsUpdate(client, Y.encodeStateVector(from)))]);
}

beforeAll(async () => {
  ({ db } = await openTestDb());
  env = { ...loadEnv(), WF_COLLAB_IDLE_SAVE_MS: 1, WF_COLLAB_RECHECK_MS: 0, WF_COLLAB_PING_MS: 30_000 };
});
afterAll(closeTestDb);

beforeEach(async () => {
  await resetTables(db);
  userId = await mkUser('collab-a');
  otherId = await mkUser('collab-b');
  sid = await mkSession(userId);

  const spaces = new SpacesService(db);
  const notifications = new NotificationsService(db, new InAppChannel());
  const pagesSvc = new PagesService(db, spaces, notifications);
  const users = new UsersService(db, new SettingsService(db, env), new RevocationBus());
  bus = new RevocationBus();
  const mail = { notify: vi.fn(async () => undefined) };
  gw = new CollabGateway(
    db,
    env,
    spaces,
    users,
    pagesSvc,
    new AuditService(db),
    mail as unknown as ConstructorParameters<typeof CollabGateway>[6],
    new SettingsService(db, env),
    bus,
  );
  gw.onModuleInit();
  inner = gw as unknown as Internals;

  const space = await spaces.create({ name: '협업방', kind: 'personal', categoryId: null, description: '' }, { id: userId, role: 'admin' });
  spaceId = space.id;
  const page = await pagesSvc.create({ spaceId, parentId: null, title: '문서', content: doc('처음') }, { id: userId, role: 'admin' });
  pageId = page.id;
});

async function currentVersion(): Promise<number> {
  const r = await db.execute<{ n: number }>(sql`SELECT current_version_no AS n FROM pages WHERE id = ${pageId}`);
  return Number(r.rows[0].n);
}

async function attach(uid = userId, session = sid): Promise<{ socket: FakeSocket; room: Awaited<ReturnType<Internals['room']>> }> {
  const page = await db.execute<{ n: number }>(sql`SELECT current_version_no AS n FROM pages WHERE id = ${pageId}`);
  const room = await inner.room(pageId, Number(page.rows[0].n));
  const socket = fakeSocket();
  inner.join(pageId, room, socket, { id: uid, role: 'admin' }, 'tester', session, spaceId);
  return { socket, room };
}

describe('마지막 퇴장 저장 (FR-710)', () => {
  it('고친 뒤 마지막 사람이 나가면 버전이 하나 남는다', async () => {
    const before = await currentVersion();
    const { socket, room } = await attach();
    socket.emit('message', editUpdate(room.doc, '새 문단'));
    socket.close();
    await vi.waitFor(async () => expect(await currentVersion()).toBe(before + 1));
  });

  it('**접속만 하고 아무것도 안 고치면 버전이 생기지 않는다** (FR-707)', async () => {
    const before = await currentVersion();
    const { socket, room } = await attach();
    // 화면이 접속 직후 보내는 "내 빈 문서 전체" — 내용은 하나도 안 바뀐다
    socket.emit('message', Buffer.concat([Buffer.of(0), Buffer.from(Y.encodeStateAsUpdate(new Y.Doc()))]));
    expect(room.lastActor).toBeNull();
    socket.close();
    await new Promise((r) => setTimeout(r, 50));
    expect(await currentVersion()).toBe(before);
  });

  it('**접속만으로 작성자가 바뀌지 않는다** (FR-802)', async () => {
    const a = await attach(userId);
    a.socket.emit('message', editUpdate(a.room.doc, 'A가 쓴 글'));
    expect(a.room.lastActor).toBe(userId);

    // B가 들어와 자기 상태를 보낸다. 아무것도 안 고쳤다
    const b = fakeSocket();
    inner.join(pageId, a.room, b, { id: otherId, role: 'admin' }, 'B', await mkSession(otherId), spaceId);
    b.emit('message', Buffer.concat([Buffer.of(0), Buffer.from(Y.encodeStateAsUpdate(new Y.Doc()))]));
    expect(a.room.lastActor).toBe(userId);
  });
});

describe('저장이 실패해도 프로세스가 죽지 않는다 (P6 코드 리뷰 1)', () => {
  it('페이지가 사라진 채로 마지막 사람이 나가도 처리되지 않은 거부가 생기지 않는다', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown): void => void unhandled.push(e);
    process.on('unhandledRejection', onUnhandled);
    try {
      const { socket, room } = await attach();
      socket.emit('message', editUpdate(room.doc, '쓰는 중'));
      // 다른 사람이 그 사이에 페이지를 휴지통에 넣었다
      await db.execute(sql`UPDATE pages SET deleted_at = now() WHERE id = ${pageId}`);
      socket.close();
      await new Promise((r) => setTimeout(r, 100));
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });
});

describe('살아 있는 연결의 권한 (P7 FR-800·805)', () => {
  it('세션이 사라지면 다음 재판정에서 끊는다', async () => {
    const { socket } = await attach();
    await db.execute(sql`DELETE FROM sessions WHERE sid = ${sid}`);
    await inner.sweep();
    expect(socket.closed?.code).toBe(1008);
    expect(socket.closed?.reason).toBe('세션 없음');
  });

  it('계정이 비활성이 되면 끊는다', async () => {
    const { socket } = await attach();
    await db.execute(sql`UPDATE users SET status = 'pending' WHERE id = ${userId}`);
    await inner.sweep();
    expect(socket.closed?.reason).toBe('계정 비활성');
  });

  it('**스페이스에서 쓰기 권한을 잃으면 끊는다** — Crew에서 빠지는 데는 부를 자리가 없다', async () => {
    const other = await mkSession(otherId);
    const { socket } = await attach(otherId, other);
    // 남의 개인 스페이스다 — 애초에 못 들어오지만, 들어온 뒤 잃는 경우를 만든다
    await db.execute(sql`UPDATE spaces SET status = 'suspended' WHERE id = ${spaceId}`);
    await inner.sweep();
    expect(socket.closed?.reason).toBe('쓰기 권한 없음');
  });

  it('아무 문제가 없으면 끊지 않는다', async () => {
    const { socket } = await attach();
    await inner.sweep();
    expect(socket.closed).toBeNull();
  });

  it('**세션 파기는 즉시 전달된다** — 주기를 기다리지 않는다 (FR-805)', async () => {
    const { socket } = await attach();
    bus.revoke(userId);
    expect(socket.closed?.code).toBe(1008);
  });

  it('남의 세션 파기에는 끊기지 않는다', async () => {
    const { socket } = await attach();
    bus.revoke(otherId);
    expect(socket.closed).toBeNull();
  });
});

describe('하트비트 (P7 FR-801)', () => {
  it('첫 주기에는 ping만 보낸다', () => {
    void attach();
    inner.heartbeat();
    for (const room of inner.rooms.values()) {
      for (const m of room.members) {
        const s = (m as { socket: FakeSocket }).socket;
        expect(s.pinged).toBe(1);
        expect(s.terminated).toBe(false);
      }
    }
  });

  it('pong이 없으면 다음 주기에 끊는다', async () => {
    const { socket } = await attach();
    inner.heartbeat(); // ping, alive=false
    inner.heartbeat(); // 답이 없었다 → terminate
    expect(socket.terminated).toBe(true);
  });

  it('pong이 오면 끊지 않는다', async () => {
    const { socket } = await attach();
    inner.heartbeat();
    socket.emit('pong');
    inner.heartbeat();
    expect(socket.terminated).toBe(false);
  });
});

describe('flush — 화면의 저장 버튼 (P6 코드 리뷰 11)', () => {
  it('**저장이 끝난 뒤에 돌아온다** — 호출부가 읽는 버전이 실제와 맞아야 한다', async () => {
    const before = await currentVersion();
    const { room } = await attach();
    const sock = [...room.members][0] as { socket: FakeSocket };
    sock.socket.emit('message', editUpdate(room.doc, '저장할 글'));
    const ok = await gw.flush(pageId, '새 제목');
    expect(ok).toBe(true);
    expect(await currentVersion()).toBe(before + 1);
  });

  it('방이 없으면 `false`다 — 화면은 이 값을 보고 이동을 멈춘다', async () => {
    expect(await gw.flush(pageId)).toBe(false);
  });

  it('**본문이 그대로여도 제목이 바뀌면 남는다** (P6 코드 리뷰 5b)', async () => {
    const before = await currentVersion();
    await attach();
    expect(await gw.flush(pageId, '제목만 고침')).toBe(true);
    expect(await currentVersion()).toBe(before + 1);
    const r = await db.execute<{ title: string }>(sql`SELECT title FROM pages WHERE id = ${pageId}`);
    expect(r.rows[0].title).toBe('제목만 고침');
  });
});

describe('정본이 앞선 방 (자체 점검 7)', () => {
  it('그 사이 REST로 저장됐으면 협업 상태를 버리고 연결을 끊는다', async () => {
    const { socket, room } = await attach();
    socket.emit('message', editUpdate(room.doc, '협업으로 쓴 글'));
    // 다른 경로가 먼저 저장했다
    await db.execute(sql`UPDATE pages SET current_version_no = current_version_no + 1 WHERE id = ${pageId}`);
    await gw.flush(pageId);
    expect(socket.closed).not.toBeNull();
    expect(inner.rooms.has(pageId)).toBe(false);
  });
});

describe('빈 문서 보호가 퇴장 경로를 막는다 (P6 코드 리뷰 8)', () => {
  it('내용을 전부 지운 채 마지막 사람이 나가도 빈 버전이 덮이지 않는다', async () => {
    const before = await currentVersion();
    const { socket, room } = await attach();
    // 방의 문서를 통째로 비운다 (어긋난 동기화·클라이언트 버그가 만드는 상태)
    const empty = yDocFromDoc({ type: 'doc', content: [] });
    room.doc.transact(() => {
      const frag = room.doc.getXmlFragment('default');
      frag.delete(0, frag.length);
    }, { principal: { id: userId } });
    void empty;
    socket.close();
    await new Promise((r) => setTimeout(r, 100));
    expect(await currentVersion()).toBe(before);
  });
});
