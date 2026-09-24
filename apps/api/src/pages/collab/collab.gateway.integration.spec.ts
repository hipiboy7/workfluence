import { Logger } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DocNode, Principal } from '@workfluence/shared';
import { DOCUMENT_SCHEMA_VERSION } from '@workfluence/shared';
import { COLLAB_CLOSE_REFUSED } from '@workfluence/shared';
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate } from 'y-protocols/awareness';
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
import type { Ledger } from '../domain/makers';
import { docFromYDoc, yDocFromDoc } from '../domain/ydoc';
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
  heartbeat(): void;
  join(pageId: string, room: unknown, socket: unknown, principal: Principal, name: string, sid: string, spaceId: string, ip?: string | null): void;
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
let mail: { notify: ReturnType<typeof vi.fn> };
let build: () => CollabGateway;

const HASH = '$argon2id$v=19$m=65536,t=3,p=4$c2FsdA$aGFzaA';
const doc = (t: string): DocNode => ({ type: 'doc', attrs: { schemaVersion: DOCUMENT_SCHEMA_VERSION }, content: [{ type: 'paragraph', content: [{ type: 'text', text: t }] }] });

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
  mail = { notify: vi.fn(async () => undefined) };
  // **같은 배선으로 하나 더 만들 수 있게 둔다.** 재기동을 흉내 내려면 메모리를 잃은 두 번째
  // 게이트웨이가 필요하다 (P8 FR-903)
  build = () =>
    new CollabGateway(
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
  gw = build();
  gw.onModuleInit();
  inner = gw as unknown as Internals;

  const space = await spaces.create({ name: '협업방', kind: 'personal', categoryId: null, description: '' }, { id: userId, role: 'admin' });
  spaceId = space.id;
  const page = await pagesSvc.create({ spaceId, parentId: null, title: '문서', content: doc('처음') }, { id: userId, role: 'admin' });
  pageId = page.id;
});

/**
 * **다음 파일로 넘어가기 전에 저장을 끝낸다.**
 *
 * 퇴장 저장은 `void ... .catch(...)`라 테스트가 끝나도 진행 중일 수 있다. 그 트랜잭션이
 * 살아 있는 채로 다음 파일의 `resetTables`가 `TRUNCATE`를 걸면 **교착이 난다** —
 * 그 파일은 "앞 테스트의 상태가 샌다"로 깨지고, 원인은 여기에 있다 (T-028과 같은 자리).
 */
afterEach(async () => {
  await gw.onModuleDestroy().catch(() => undefined);
  await new Promise((r) => setTimeout(r, 30));
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
  it('첫 주기에는 ping만 보낸다', async () => {
    // **`await`를 빠뜨리면 이 테스트는 아무것도 확인하지 않는다.** `attach`가 DB에서
    // 양보하는 사이 `heartbeat()`가 빈 방을 돌아 단언이 한 번도 실행되지 않는다 (P7 자체 점검 4)
    const { socket } = await attach();
    inner.heartbeat();
    expect(socket.pinged).toBe(1);
    expect(socket.terminated).toBe(false);
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
    expect(ok.saved).toBe(true);
    expect(await currentVersion()).toBe(before + 1);
  });

  it('방이 없으면 `false`다 — 화면은 이 값을 보고 이동을 멈춘다', async () => {
    expect((await gw.flush(pageId)).saved).toBe(false);
  });

  it('**본문이 그대로여도 제목이 바뀌면 남는다** (P6 코드 리뷰 5b)', async () => {
    const before = await currentVersion();
    await attach();
    expect((await gw.flush(pageId, '제목만 고침')).saved).toBe(true);
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

describe('끊기로 한 연결 (P7 보안 검토 F1·F2)', () => {
  it('**끊은 뒤에 온 변경은 적용하지 않는다** — `close()`는 30초 동안 메시지를 더 올린다', async () => {
    const { socket, room } = await attach();
    bus.revoke(userId);
    expect(socket.closed?.code).toBe(1008);
    // 답하지 않는 클라이언트가 계속 보내는 상황
    socket.emit('message', editUpdate(room.doc, '끊긴 뒤에 쓴 글'));
    expect(room.lastActor).toBeNull();
    expect(room.members.size).toBe(0);
  });

  it('로그아웃은 **그 세션의 연결만** 끊는다 — 다른 기기 편집을 끊을 이유가 없다', async () => {
    const a = await attach(userId, sid);
    const otherSid = await mkSession(userId);
    const b = fakeSocket();
    inner.join(pageId, a.room, b, { id: userId, role: 'admin' }, '다른 기기', otherSid, spaceId);

    bus.revoke(userId, sid);
    expect(a.socket.closed?.code).toBe(1008);
    expect(b.closed).toBeNull();
  });

  it('비밀번호 변경·강제 종료는 `sid` 없이 불러 **전부** 끊는다', async () => {
    const a = await attach(userId, sid);
    const b = fakeSocket();
    inner.join(pageId, a.room, b, { id: userId, role: 'admin' }, '다른 기기', await mkSession(userId), spaceId);

    bus.revoke(userId);
    expect(a.socket.closed?.code).toBe(1008);
    expect(b.closed?.code).toBe(1008);
  });
});

describe('저장할 수 없는 문서 (P7 자체 점검 3)', () => {
  it('**검증에 실패하면 `flush`가 `saved: false`와 이유를 돌려준다**', async () => {
    const { room } = await attach();
    // 허용 목록 밖 노드를 방의 문서에 직접 넣는다 (깨진 클라이언트가 보내는 상황)
    room.doc.transact(() => {
      const frag = room.doc.getXmlFragment('default');
      frag.insert(frag.length, [new Y.XmlElement('script')]);
    }, { principal: { id: userId } });

    const r = await gw.flush(pageId);
    expect(r.saved).toBe(false);
    expect(r.reason).toContain('문서 검증 실패');
  });

  it('**사람이 남아 있으면 방을 지우지 않는다** — 지우면 그 뒤 편집이 아무데도 안 간다', async () => {
    const { room } = await attach();
    room.doc.transact(() => {
      const frag = room.doc.getXmlFragment('default');
      frag.insert(frag.length, [new Y.XmlElement('script')]);
    }, { principal: { id: userId } });

    await gw.flush(pageId);
    expect(inner.rooms.get(pageId)).toBe(room);
    expect(room.members.size).toBe(1);
  });
});

describe('바뀌지 않은 문서로 다시 판정하지 않는다 (P8 다섯 번째 검토 4)', () => {
  /** 유휴 기준(이 시험에서는 1ms)을 넘긴다 */
  const idle = (): Promise<void> => new Promise((r) => setTimeout(r, 5));

  it('**썼다 지워 정본과 같아지면 유휴 판정은 한 번이다** — 전에는 다음 변경이 올 때까지 매초 질의 둘과 상태 쓰기를 되풀이했다', async () => {
    const before = await currentVersion();
    const { socket, room } = await attach();
    const client = new Y.Doc();
    Y.applyUpdate(client, Y.encodeStateAsUpdate(room.doc));
    const send = (fn: (f: Y.XmlFragment) => void): void => {
      const sv = Y.encodeStateVector(client);
      client.transact(() => fn(client.getXmlFragment('default')));
      socket.emit('message', Buffer.concat([Buffer.of(0), Buffer.from(Y.encodeStateAsUpdate(client, sv))]));
    };
    const para = (f: Y.XmlFragment, text: string): void => {
      const p = new Y.XmlElement('paragraph');
      p.insert(0, [new Y.XmlText(text)]);
      f.insert(f.length, [p]);
    };
    send((f) => para(f, '잠깐'));
    send((f) => f.delete(f.length - 1, 1));

    const remember = vi.spyOn(gw as unknown as { rememberState: (...a: unknown[]) => Promise<void> }, 'rememberState');
    try {
      for (let i = 0; i < 3; i++) {
        await idle();
        await inner.sweep();
      }
      expect(remember).toHaveBeenCalledTimes(1);
    } finally {
      remember.mockRestore();
    }
    expect(await currentVersion()).toBe(before);

    // 다음 변경은 다시 판정되어 저장된다
    send((f) => para(f, '진짜 글'));
    await idle();
    await inner.sweep();
    expect(await currentVersion()).toBe(before + 1);
  });

  it('**검증에 실패한 문서도 다음 변경까지 다시 판정하지 않는다** — 경고가 매초 쌓이지 않고, 상태와 방은 남는다 (FR-708)', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn');
    try {
      const { room } = await attach();
      room.doc.transact(() => {
        const frag = room.doc.getXmlFragment('default');
        frag.insert(frag.length, [new Y.XmlElement('script')]);
      }, { principal: { id: userId } });
      for (let i = 0; i < 3; i++) {
        await idle();
        await inner.sweep();
      }
      expect(warn.mock.calls.filter(([m]) => String(m).includes('검증 실패로 저장하지 않았다'))).toHaveLength(1);
      expect(inner.rooms.get(pageId)).toBe(room);
    } finally {
      warn.mockRestore();
    }
  });
});

/**
 * 멘션을 **만든** 사람 — 그 멘션의 글자를 전부 자기 연결로 들여오고 그 멘션을 생기게 한 사람 (P8_설계서_Mention C.2절, 보류 21).
 *
 * **실제 게이트웨이를 탄다.** 규칙을 옮겨 적은 도우미로 시험하면 규칙이 바뀔 때 시험이 따라오지 않는다
 * (P8 두 번째 검토 8). 사람마다 **화면처럼** 문서 하나를 두고, 방에서 받은 것은 되돌려 보내지 않으며,
 * 자기 트랜잭션 하나씩만 보낸다 (`CollabEditor.tsx`와 같다).
 */
describe('멘션을 만든 사람 (P8 FR-900~908)', () => {
  const MSG = (u: Uint8Array): Buffer => Buffer.concat([Buffer.of(0), Buffer.from(u)]);
  type RoomLike = Awaited<ReturnType<Internals['room']>>;
  type Peer = { doc: Y.Doc; socket: FakeSocket; uid: string };
  const frag = (d: Y.Doc): Y.XmlFragment => d.getXmlFragment('default');
  const textAt = (f: Y.XmlFragment, i: number): Y.XmlText => (f.get(i) as Y.XmlElement).get(0) as Y.XmlText;
  const newPara = (f: Y.XmlFragment, text: string, kind = 'paragraph'): void => {
    const p = new Y.XmlElement(kind);
    if (kind === 'heading') p.setAttribute('level', 2 as never);
    p.insert(0, [new Y.XmlText(text)]);
    f.insert(f.length, [p]);
  };

  let carolId = '';
  let room: RoomLike;
  beforeEach(async () => {
    carolId = await mkUser('collab-c');
    room = await inner.room(pageId, await currentVersion());
  });

  /** 들어온다. 화면은 접속 직후 **자기 문서 전체**를 보낸다 — 거기에는 남이 쓴 조각이 다 들어 있다 */
  async function enter(uid: string, into: RoomLike = room, g: Internals = inner, ip: string | null = null): Promise<Peer> {
    const socket = fakeSocket();
    g.join(pageId, into, socket, { id: uid, role: 'admin' }, uid, await mkSession(uid), spaceId, ip);
    const doc = new Y.Doc();
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(into.doc), 'remote');
    socket.emit('message', MSG(Y.encodeStateAsUpdate(doc)));
    return { doc, socket, uid };
  }
  /**
   * 방에서 받은 것을 반영하고, **자기 트랜잭션 하나**를 보낸다.
   *
   * 보내는 것은 **그 로컬 트랜잭션의 `update` 이벤트**다 — 화면(`CollabEditor.tsx`의 `onDocUpdate`)과 같다.
   * `encodeStateAsUpdate(doc, sv)`로 보내면 문서에 보류돼 있던 **남의 조각까지** 실려 화면과 다른 것을 시험하게 된다.
   */
  function act(p: Peer, fn: (f: Y.XmlFragment) => void, into: RoomLike = room): void {
    Y.applyUpdate(p.doc, Y.encodeStateAsUpdate(into.doc), 'remote');
    let local: Uint8Array | null = null;
    const onUpdate = (u: Uint8Array, origin: unknown): void => {
      if (origin !== 'remote') local = u;
    };
    p.doc.on('update', onUpdate);
    p.doc.transact(() => fn(frag(p.doc)));
    p.doc.off('update', onUpdate);
    if (local) p.socket.emit('message', MSG(local));
  }
  /** 한 글자씩 친다 — 치는 동안 `@coll`·`@colla`… 같은 중간 이름이 생겼다 사라진다 */
  function typeAt(p: Peer, which: (f: Y.XmlFragment) => Y.XmlText, at: number, s: string): void {
    [...s].forEach((c, i) => act(p, (f) => which(f).insert(at + i, c)));
  }
  const last = (f: Y.XmlFragment): Y.XmlText => textAt(f, f.length - 1);

  async function mentionRows(uid: string): Promise<{ actor_id: string | null }[]> {
    const r = await db.execute<{ actor_id: string | null }>(sql`SELECT actor_id FROM notifications WHERE user_id = ${uid}`);
    return r.rows;
  }
  async function saveAndCarol(): Promise<{ actor_id: string | null }[]> {
    expect((await gw.flush(pageId)).saved).toBe(true);
    return mentionRows(carolId);
  }
  const AWARE = (u: Uint8Array): Buffer => Buffer.concat([Buffer.of(1), Buffer.from(u)]);
  /** 클라이언트 ID의 주인 (P9 D.4) */
  const ownerOf = (client: number): string | undefined => (room as unknown as { ledger: Ledger }).ledger.owners.get(client);
  /** 관문이 남긴 감사로그 (P9 D.6) */
  async function rejections(): Promise<{ actor_id: string; target_id: string; rule: string; reason: string; ip: string | null }[]> {
    const r = await db.execute<{ actor_id: string; target_id: string; rule: string; reason: string; ip: string | null }>(
      sql`SELECT actor_id, target_id, detail->>'rule' AS rule, detail->>'reason' AS reason, ip FROM audit_events WHERE action = 'page.collab.reject' ORDER BY created_at`,
    );
    return r.rows;
  }

  it('**인수 기준 — A가 `@B`를 치고 B가 마지막으로 고쳐도 "A 님이 불렀다"다**', async () => {
    await db.execute(sql`UPDATE users SET email = 'b@example.internal' WHERE id = ${otherId}`);
    const a = await enter(userId);
    act(a, (f) => newPara(f, ''));
    typeAt(a, last, 0, '@collab-b 확인 부탁');
    const b = await enter(otherId);
    act(b, (f) => newPara(f, 'B가 고친 문단'));
    expect(room.lastActor).toBe(otherId);

    expect((await gw.flush(pageId)).saved).toBe(true);
    expect(await mentionRows(otherId)).toEqual([{ actor_id: userId }]);
    // 메일에도 A의 이름이 간다 (FR-905). 기본 이름은 여전히 넘기지 않는다
    await vi.waitFor(() => expect(mail.notify).toHaveBeenCalled());
    const [outcome, fallbackName, , auditActor] = mail.notify.mock.calls[0] as [{ recipients: { calledBy: string | null }[] }, string | null, string, string | undefined];
    expect(fallbackName).toBeNull();
    expect(outcome.recipients).toEqual([expect.objectContaining({ calledBy: 'collab-a' })]);
    // 메일 감사의 "누가"도 A다 — 마지막으로 키를 누른 B가 아니다 (P8 코드 리뷰 3)
    expect(auditActor).toBe(userId);
  });

  describe('정상 — 부른 사람의 이름으로 나간다', () => {
    it('남의 글 뒤에 이어 부른다', async () => {
      const x = await enter(otherId);
      const u = await enter(userId);
      act(x, (f) => newPara(f, '참석: '));
      typeAt(u, last, 4, '@collab-c');
      expect(await saveAndCarol()).toEqual([{ actor_id: userId }]);
    });

    it('자기 오타를 지우고 이어 친다 (`@collab-cc` → 지움 → ` 확인`)', async () => {
      const u = await enter(userId);
      act(u, (f) => newPara(f, ''));
      typeAt(u, last, 0, '@collab-cc');
      act(u, (f) => last(f).delete(9, 1));
      typeAt(u, last, 9, ' 확인');
      expect(await saveAndCarol()).toEqual([{ actor_id: userId }]);
    });

    it('**정본 글자를 지우고 그 자리에 부른다** — 모든 페이지는 정본에서 시작한다 (P8 두 번째 검토 4)', async () => {
      const u = await enter(userId);
      act(u, (f) => textAt(f, 0).delete(0, 2)); // "처음"을 지운다
      typeAt(u, (f) => textAt(f, 0), 0, '@collab-c');
      expect(await saveAndCarol()).toEqual([{ actor_id: userId }]);
    });

    it('**남이 서식을 걸었다가 풀어도** 그대로다 (P8 두 번째 검토 6)', async () => {
      const u = await enter(userId);
      const x = await enter(otherId);
      act(u, (f) => newPara(f, 'hi @collab-c 확인'));
      act(x, (f) => last(f).format(3, 9, { bold: {} }));
      act(x, (f) => last(f).format(3, 9, { bold: null }));
      expect(await saveAndCarol()).toEqual([{ actor_id: userId }]);
    });

    it('남이 바로 뒤에 조사를 붙인다 (`@collab-c 확인` → `@collab-c님 확인`)', async () => {
      const u = await enter(userId);
      const x = await enter(otherId);
      act(u, (f) => newPara(f, '@collab-c 확인'));
      act(x, (f) => last(f).insert(9, '님'));
      expect(await saveAndCarol()).toEqual([{ actor_id: userId }]);
    });

    it('자기 문단을 자기가 제목으로 바꾼다 — 편집기는 글자를 새로 만든다', async () => {
      const u = await enter(userId);
      act(u, (f) => newPara(f, '@collab-c 확인'));
      act(u, (f) => {
        f.delete(f.length - 1, 1);
        newPara(f, '@collab-c 확인', 'heading');
      });
      expect(await saveAndCarol()).toEqual([{ actor_id: userId }]);
    });
  });

  describe('남이 손대 멘션이 생겼다 — **누구의 이름으로도 나가지 않는다** (P8 코드 리뷰 1 · 보안 검토 1 · 세 번째 코드 리뷰 2)', () => {
    it('남이 글자를 지워 새 이름을 만들면 모름 (`@collab-cx` → `@collab-c`) — 글자는 U가, 변경은 X가 했다', async () => {
      const u = await enter(userId);
      const x = await enter(otherId);
      act(u, (f) => newPara(f, '@collab-cx 확인'));
      act(x, (f) => last(f).delete(9, 1));
      expect(await saveAndCarol()).toEqual([{ actor_id: null }]);
    });

    it('남이 앞글자를 지워 멘션으로 만들어도 마찬가지다 (`x@collab-c` → `@collab-c`)', async () => {
      const u = await enter(userId);
      const x = await enter(otherId);
      act(u, (f) => newPara(f, 'hi x@collab-c'));
      act(x, (f) => last(f).delete(3, 1));
      expect(await saveAndCarol()).toEqual([{ actor_id: null }]);
    });

    it('남이 경계에 공백을 끼워도 (`x@collab-c` → `x @collab-c`)', async () => {
      const u = await enter(userId);
      const x = await enter(otherId);
      act(u, (f) => newPara(f, 'x@collab-c'));
      act(x, (f) => last(f).insert(1, ' '));
      expect(await saveAndCarol()).toEqual([{ actor_id: null }]);
    });

    it('남이 이름을 갈라도 (`@collab-clee` → `@collab-c lee`)', async () => {
      const u = await enter(userId);
      const x = await enter(otherId);
      act(u, (f) => newPara(f, '@collab-clee'));
      act(x, (f) => last(f).insert(9, ' '));
      expect(await saveAndCarol()).toEqual([{ actor_id: null }]);
    });

    it('**남의 글을 내 입력이 멘션으로 완성해도 모름** — X가 U의 커서 뒤에 `hello@collab-c`, U가 공백 하나 (세 번째 코드 리뷰 2)', async () => {
      const u = await enter(userId);
      const x = await enter(otherId);
      act(u, (f) => newPara(f, '메모: '));
      act(x, (f) => last(f).insert(4, 'hello@collab-c'));
      act(u, (f) => last(f).insert(9, ' ')); // `hello @collab-c`
      expect(await saveAndCarol()).toEqual([{ actor_id: null }]);
    });

    it('**남의 멘션을 잘라 붙이면 모름** — 두 변경에 걸쳐도 (세 번째 코드 리뷰 1)', async () => {
      const u = await enter(userId);
      const x = await enter(otherId);
      act(u, (f) => newPara(f, '@collab-c 확인'));
      act(x, (f) => f.delete(f.length - 1, 1)); // 잘라내기
      act(x, (f) => newPara(f, '@collab-c 확인')); // 붙여 넣기 — 글자는 X가 새로 들여왔다
      expect(await saveAndCarol()).toEqual([{ actor_id: null }]);
    });

    it('**잘라낸 뒤 저장이 끼고 그 뒤에 붙여 넣어도 모름** — 저장된 버전에 그 이름이 없다', async () => {
      const u = await enter(userId);
      const x = await enter(otherId);
      act(u, (f) => newPara(f, '@collab-c 확인'));
      act(x, (f) => f.delete(f.length - 1, 1)); // 잘라내기
      act(u, (f) => newPara(f, '다른 글')); // 그 사이 다른 편집이 있어
      expect((await gw.flush(pageId)).saved).toBe(true); // 생각하는 사이 저장이 끼었다
      act(x, (f) => newPara(f, '@collab-c 확인')); // 붙여 넣기
      expect(await saveAndCarol()).toEqual([{ actor_id: null }]);
    });

    it('둘이 나눠 쳤으면 모름 (A가 `@collab-`, B가 `c`)', async () => {
      const u = await enter(userId);
      const x = await enter(otherId);
      act(u, (f) => newPara(f, '@collab-'));
      act(x, (f) => last(f).insert(8, 'c'));
      expect(await saveAndCarol()).toEqual([{ actor_id: null }]);
    });

    it('**남의 문단을 제목으로 바꾸면 모름** — 옮긴 사람이 부른 것이 아니고, 원래 사람 이름을 옮겨 붙이지도 않는다 (P8 두 번째 검토 5)', async () => {
      const u = await enter(userId);
      const x = await enter(otherId);
      act(u, (f) => newPara(f, '@collab-c 확인'));
      act(x, (f) => {
        f.delete(f.length - 1, 1);
        newPara(f, '@collab-c 확인', 'heading');
      });
      expect(await saveAndCarol()).toEqual([{ actor_id: null }]);
    });
  });

  describe('조작한 클라이언트 — 관문이 받지 않는다 (P9 FR-1000~1006, 보류 22·23·24)', () => {
    const refusedCode = (p: Peer): number | undefined => p.socket.closed?.code;

    it('**남의 클라이언트 ID로 쓰면 받지 않고 끊는다** — 문서도 동료도 그대로, 감사로그에 누가·어느 규칙 (주인 규칙)', async () => {
      const u = await enter(userId);
      act(u, (f) => newPara(f, '안녕'));
      const x = await enter(otherId, room, inner, '10.0.0.8');
      const forged = new Y.Doc();
      Y.applyUpdate(forged, Y.encodeStateAsUpdate(u.doc));
      forged.clientID = u.doc.clientID;
      const sv = Y.encodeStateVector(forged);
      newPara(frag(forged), '@collab-c 이것 좀');
      const before = u.socket.sent.length;
      x.socket.emit('message', MSG(Y.encodeStateAsUpdate(forged, sv)));
      expect(refusedCode(x)).toBe(COLLAB_CLOSE_REFUSED);
      expect(u.socket.sent.length).toBe(before); // 퍼뜨리지 않았다
      expect(JSON.stringify(docFromYDoc(room.doc))).not.toContain('@collab-c');
      expect(await saveAndCarol()).toEqual([]);
      await vi.waitFor(async () =>
        expect(await rejections()).toEqual([{ actor_id: otherId, target_id: pageId, rule: 'owner', reason: '남의 클라이언트 ID로 쓴 조각', ip: '10.0.0.8' }]),
      );
    });

    it('**주인 없는 클라이언트를 이어 쓴 사람이 그 주인이 된다** — 정본에서 만든 서버 클라이언트처럼. 다음 사람은 받지 않는다 (D.4)', async () => {
      const x = await enter(otherId);
      const u = await enter(userId);
      const serverClient = room.doc.clientID; // 정본에서 방을 만든 문서의 클라이언트 — 아무도 알리지 않았다
      const continueAs = (text: string): Buffer => {
        const forged = new Y.Doc();
        Y.applyUpdate(forged, Y.encodeStateAsUpdate(room.doc));
        forged.clientID = serverClient;
        const sv = Y.encodeStateVector(forged);
        newPara(frag(forged), text);
        return MSG(Y.encodeStateAsUpdate(forged, sv));
      };
      x.socket.emit('message', continueAs('X가 이어 씀'));
      expect(refusedCode(x)).toBeUndefined();
      expect(ownerOf(serverClient)).toBe(otherId);
      u.socket.emit('message', continueAs('U도 이어 씀'));
      expect(refusedCode(u)).toBe(COLLAB_CLOSE_REFUSED);
      const text = JSON.stringify(docFromYDoc(room.doc));
      expect(text).toContain('X가 이어 씀');
      expect(text).not.toContain('U도 이어 씀');
    });

    it('**끊은 뒤에 온 말은 듣지 않는다** — 답하지 않는 클라이언트가 닫기 핸드셰이크 동안 계속 쓰지 못한다 (P7 F2와 같은 자리)', async () => {
      const u = await enter(userId);
      const x = await enter(otherId);
      act(x, (f) => f.insert(f.length, [new Y.XmlHook('hook') as never]));
      expect(refusedCode(x)).toBe(COLLAB_CLOSE_REFUSED);
      const before = u.socket.sent.length;
      act(x, (f) => newPara(f, '끊긴 뒤의 글'));
      expect(u.socket.sent.length).toBe(before);
      expect(JSON.stringify(docFromYDoc(room.doc))).not.toContain('끊긴 뒤의 글');
    });

    it('**커서 정보로 알려진 ID를 먼저 차지하려 해도 받지 않는다** — 알리는 순간 주인이 정해지고, 주인의 입력은 그대로 닿는다 (P8 다섯 번째 검토 1, 보류 24)', async () => {
      const daveId = await mkUser('collab-d');
      const x = await enter(otherId);
      const u = await enter(userId);
      // 화면은 열자마자 커서 정보(awareness)로 **자기 클라이언트 ID**를 알린다(`CollabEditor.tsx`) — 커서를 보이려면 알려야 한다
      const told = new Awareness(u.doc);
      const heard = new Awareness(new Y.Doc());
      try {
        told.setLocalStateField('user', { name: 'U' });
        u.socket.emit('message', AWARE(encodeAwarenessUpdate(told, [u.doc.clientID])));
        for (const f of x.socket.sent) if (f[0] === 1) applyAwarenessUpdate(heard, new Uint8Array(f.subarray(1)), 'remote');
        const stolen = u.doc.clientID;
        expect([...heard.getStates().keys()]).toContain(stolen);
        // 그러나 **알리는 순간 U에게 묶였다** — 그 알림이 X에게 가기 전이다
        expect(ownerOf(stolen)).toBe(userId);

        const forged = new Y.Doc();
        Y.applyUpdate(forged, Y.encodeStateAsUpdate(room.doc));
        forged.clientID = stolen;
        const sv = Y.encodeStateVector(forged);
        newPara(frag(forged), '@collab-c 확인');
        x.socket.emit('message', MSG(Y.encodeStateAsUpdate(forged, sv)));
        expect(refusedCode(x)).toBe(COLLAB_CLOSE_REFUSED);

        // U는 자기 ID 그대로 쓴다 — 전에는 앞 글자가 서버에서 버려졌다
        act(u, (f) => newPara(f, ''));
        expect(u.doc.clientID).toBe(stolen);
        typeAt(u, last, 0, '@collab-d 확인');
        expect(JSON.stringify(docFromYDoc(room.doc))).toContain('@collab-d 확인');
        expect((await gw.flush(pageId)).saved).toBe(true);
        expect(await mentionRows(carolId)).toEqual([]);
        expect(await mentionRows(daveId)).toEqual([{ actor_id: userId }]);
      } finally {
        told.destroy();
        heard.destroy();
      }
    });

    it('**알리기 전에 남이 먼저 쓴 ID로는 주인도 쓰지 못한다 — 대신 조용히 버려지지 않고 끊겨 드러난다** (D.4)', async () => {
      // 화면은 열자마자 ID를 알리므로 실제 화면에서는 생기지 않는 순서다. 생기면 입력이 조용히 사라지는 대신(Phase 8까지) 끊긴다
      const x = await enter(otherId);
      const u = await enter(userId);
      const stolen = u.doc.clientID;
      const forged = new Y.Doc();
      Y.applyUpdate(forged, Y.encodeStateAsUpdate(room.doc));
      forged.clientID = stolen;
      const sv = Y.encodeStateVector(forged);
      newPara(frag(forged), 'X');
      x.socket.emit('message', MSG(Y.encodeStateAsUpdate(forged, sv)));
      expect(ownerOf(stolen)).toBe(otherId); // X가 새 클라이언트를 만든 것과 서버는 가릴 수 없다

      let local: Uint8Array | null = null;
      const onUpdate = (up: Uint8Array, origin: unknown): void => {
        if (origin !== 'remote') local = up;
      };
      u.doc.on('update', onUpdate);
      u.doc.transact(() => newPara(frag(u.doc), 'U가 먼저 쳐 둔 글'));
      u.doc.off('update', onUpdate);
      if (local) u.socket.emit('message', MSG(local));
      expect(refusedCode(u)).toBe(COLLAB_CLOSE_REFUSED);
      expect(JSON.stringify(docFromYDoc(room.doc))).not.toContain('먼저 쳐 둔 글');
    });

    it('**보류될 위조 조각은 받지 않는다** — 앞선 시계를 숨겨 보내면 끊고, 주인의 입력은 묻어 들어오는 것 없이 그대로 닿는다 (완결 규칙, P8 자체 점검 1)', async () => {
      const warn = vi.spyOn(Logger.prototype, 'warn');
      try {
        const u = await enter(userId);
        const sendOwn = (fn: (f: Y.XmlFragment) => void): void => {
          const sv = Y.encodeStateVector(u.doc);
          u.doc.transact(() => fn(frag(u.doc)));
          u.socket.emit('message', MSG(Y.encodeStateAsUpdate(u.doc, sv)));
        };
        act(u, (f) => newPara(f, '안녕'));

        const x = await enter(otherId);
        const forged = new Y.Doc();
        Y.applyUpdate(forged, Y.encodeStateAsUpdate(u.doc));
        forged.clientID = u.doc.clientID;
        last(frag(forged)).insert(2, 'xxxxx');
        const hidden = Y.encodeStateVector(forged);
        last(frag(forged)).insert(7, ' @collab-c 확인');
        x.socket.emit('message', MSG(Y.encodeStateAsUpdate(forged, hidden)));
        expect(refusedCode(x)).toBe(COLLAB_CLOSE_REFUSED);

        sendOwn((f) => last(f).insert(2, '하세요요요'));
        const text = JSON.stringify(docFromYDoc(room.doc));
        expect(text).toContain('안녕하세요요요');
        expect(text).not.toContain('@collab-c');
        expect(await saveAndCarol()).toEqual([]);
        // 관문을 지난 변경은 늘 믿을 수 있다 — Phase 8의 경고가 나오지 않는다 (D.8)
        expect(warn.mock.calls.map((c) => String(c[0]))).not.toContainEqual(expect.stringContaining('보낸 것보다 문서를 더 바꿨다'));
        expect(warn.mock.calls.map((c) => String(c[0]))).toContainEqual(expect.stringContaining('rule=complete'));
      } finally {
        warn.mockRestore();
      }
    });

    it('**아직 없는 글자를 지우는 삭제는 받지 않는다** — 주인이 칠 글자를 미리 지워 두는 길 (완결 규칙, P8 두 번째 검토 1)', async () => {
      const u = await enter(userId);
      act(u, (f) => newPara(f, ''));
      const rehearsal = new Y.Doc();
      Y.applyUpdate(rehearsal, Y.encodeStateAsUpdate(u.doc));
      rehearsal.clientID = u.doc.clientID;
      last(frag(rehearsal)).insert(0, '@collab-cx 확인');
      let deletion: Uint8Array | null = null;
      rehearsal.on('update', (upd: Uint8Array) => (deletion = upd));
      last(frag(rehearsal)).delete(9, 1);
      expect(Y.parseUpdateMeta(deletion!).from.size).toBe(0);

      const x = await enter(otherId);
      x.socket.emit('message', MSG(deletion!));
      expect(refusedCode(x)).toBe(COLLAB_CLOSE_REFUSED);
      const own = Y.encodeStateVector(u.doc);
      u.doc.transact(() => last(frag(u.doc)).insert(0, '@collab-cx 확인'));
      u.socket.emit('message', MSG(Y.encodeStateAsUpdate(u.doc, own)));
      expect(JSON.stringify(docFromYDoc(room.doc))).toContain('@collab-cx 확인');
      expect(await saveAndCarol()).toEqual([]);
    });

    it('**읽을 수 없는 변경과 사람 표시도 받지 않는다** — 정상 화면은 그런 것을 보내지 않는다', async () => {
      const u = await enter(userId);
      const x = await enter(otherId);
      x.socket.emit('message', Buffer.from([0, 0xff, 0xff, 0xff]));
      expect(refusedCode(x)).toBe(COLLAB_CLOSE_REFUSED);
      const y2 = await enter(otherId);
      y2.socket.emit('message', Buffer.from([1, 1, 5, 1, 1, 0x7b]));
      expect(refusedCode(y2)).toBe(COLLAB_CLOSE_REFUSED);
      expect(refusedCode(u)).toBeUndefined();
      await vi.waitFor(async () => expect((await rejections()).map((r) => r.rule).sort()).toEqual(['presence', 'structure']));
    });

    it('**사람 표시에서 남의 몫은 퍼뜨리지 않고, 이름은 서버가 정한다** — 남의 커서·이름을 꾸미지 못한다 (D.5, FR-1004)', async () => {
      const u = await enter(userId);
      const x = await enter(otherId);
      const watcher = await enter(otherId);
      const mine = new Awareness(u.doc);
      // X가 U의 클라이언트 ID로 꾸민 사람 표시 — Awareness는 만들 때의 문서 ID를 쓴다
      const fakeDoc = new Y.Doc();
      fakeDoc.clientID = u.doc.clientID;
      const fake = new Awareness(fakeDoc);
      const seen = new Awareness(new Y.Doc());
      try {
        // U가 자기 몫을 알리면서 이름을 '관리자'라고 적는다 — 서버는 U의 표시 이름으로 바꿔 퍼뜨린다
        mine.setLocalStateField('user', { name: '관리자', color: 'red' });
        u.socket.emit('message', AWARE(encodeAwarenessUpdate(mine, [u.doc.clientID])));
        // X가 U의 몫을 꾸며 보낸다(같은 클라이언트 ID) — 퍼뜨리지 않는다
        fake.setLocalStateField('user', { name: '가짜 U' });
        const sentBefore = watcher.socket.sent.length;
        x.socket.emit('message', AWARE(encodeAwarenessUpdate(fake, [u.doc.clientID])));
        expect(watcher.socket.sent.length).toBe(sentBefore);
        for (const f of watcher.socket.sent) if (f[0] === 1) applyAwarenessUpdate(seen, new Uint8Array(f.subarray(1)), 'remote');
        expect(seen.getStates().get(u.doc.clientID)).toEqual({ user: { name: userId, color: 'red' } });
        expect(refusedCode(x)).toBeUndefined(); // 메아리일 수 있어 끊지는 않는다
      } finally {
        mine.destroy();
        fake.destroy();
        seen.destroy();
      }
    });

    it('**옛 문서를 통째로 다시 보내면 모름** — 남의 글자를 보낸 사람 것으로 치지 않는다 (P8 자체 점검 2 · 세 번째 코드 리뷰 3)', async () => {
      const old = new Y.Doc();
      Y.applyUpdate(old, Y.encodeStateAsUpdate(yDocFromDoc(doc('처음'))));
      const aOld = new Y.Doc();
      Y.applyUpdate(aOld, Y.encodeStateAsUpdate(old));
      newPara(frag(aOld), '@collab-c 확인');
      const bOld = new Y.Doc();
      Y.applyUpdate(bOld, Y.encodeStateAsUpdate(aOld));
      newPara(frag(bOld), 'B의 문단');

      const x = await enter(otherId);
      x.socket.emit('message', MSG(Y.encodeStateAsUpdate(bOld)));
      expect(JSON.stringify(docFromYDoc(room.doc))).toContain('@collab-c');
      expect(await saveAndCarol()).toEqual([{ actor_id: null }]);
    });
  });

  it('**적용한 뒤 다른 관찰자가 던져도 퍼뜨린다** — 받은 쪽은 적용됐는지를 예외로 판단하지 않는다 (네 번째 코드 리뷰 5)', async () => {
    const u = await enter(userId);
    const x = await enter(otherId);
    let once = true;
    room.doc.on('afterTransaction', () => {
      if (!once) return;
      once = false;
      throw new Error('다른 관찰자의 실수');
    });
    const before = x.socket.sent.length;
    act(u, (f) => newPara(f, '안녕'));
    expect(x.socket.sent.length).toBeGreaterThan(before);
  });

  it('**편집기가 만들지 않는 노드는 받지 않는다** — 보낸 연결만 끊기고 방은 그대로 흐른다: 중계도 저장도 (P9 D.2, 보류 23 · P8 세 번째 검토 2)', async () => {
    const u = await enter(userId);
    const x = await enter(otherId);
    const peer = await enter(otherId);
    // X가 조작한 클라이언트로 문서에 `Y.XmlHook` 하나를 넣으려 한다 — 전에는 동료의 편집기가 그리다 던졌다
    const before = peer.socket.sent.length;
    act(x, (f) => f.insert(f.length, [new Y.XmlHook('hook') as never]));
    expect(x.socket.closed?.code).toBe(COLLAB_CLOSE_REFUSED);
    expect(peer.socket.sent.length).toBe(before);
    expect(room.doc.getXmlFragment('default').toArray().some((n) => n instanceof Y.XmlHook)).toBe(false);
    // U가 평범하게 친다 — 동료에게 전달되고 저장된다
    act(u, (f) => newPara(f, '@collab-c 확인'));
    expect(peer.socket.sent.length).toBeGreaterThan(before);
    expect(await saveAndCarol()).toEqual([{ actor_id: userId }]);
  });

  describe('**정상 사용에서 이름이 비지 않는다** (네 번째 검토 1·2·5·6)', () => {
    it('**남이 지운 이름을 내가 한 글자씩 쳐서 부르면 나다** — 옮김은 통째로 생길 때만이다', async () => {
      const x = await enter(otherId);
      const u = await enter(userId);
      act(x, (f) => newPara(f, '@collab-c 완료'));
      act(x, (f) => f.delete(f.length - 1, 1)); // X가 지웠다 — collab-c를 기억한다
      act(u, (f) => newPara(f, '다른 글'));
      expect((await gw.flush(pageId)).saved).toBe(true); // collab-c 없이 저장됐다
      act(u, (f) => newPara(f, ''));
      typeAt(u, last, 0, '@collab-c 다시 확인');
      expect(await saveAndCarol()).toEqual([{ actor_id: userId }]);
    });

    it('**같은 Y.Doc으로 다시 붙은 뒤에 친 멘션도 그 사람이다** — 같은 사람이 만든 클라이언트를 이어받는다', async () => {
      const u = await enter(userId);
      act(u, (f) => newPara(f, '처음 친 글'));
      // 화면이 연결만 다시 연다 (표시 이름이 바뀌면 그렇다) — 문서는 그대로다
      const again = fakeSocket();
      inner.join(pageId, room, again, { id: userId, role: 'admin' }, userId, await mkSession(userId), spaceId);
      again.emit('message', MSG(Y.encodeStateAsUpdate(u.doc)));
      u.socket = again;
      act(u, (f) => newPara(f, ''));
      typeAt(u, last, 0, '@collab-c 확인');
      expect(await saveAndCarol()).toEqual([{ actor_id: userId }]);
    });

    it('**첫 변경에 남의 보류 조각이 묻어도** 그 뒤 내 멘션은 나다 — 자기 클라이언트는 믿을 수 없는 변경에서도 알아본다', async () => {
      const u = await enter(userId);
      const x = await enter(otherId);
      // X가 U의 첫 문단 모양을 흉내 내고(같은 ID가 된다) 그 안에 **제 글자만** 보내 둔다 → 부모가 없어 보류된다
      const mimic = new Y.Doc();
      Y.applyUpdate(mimic, Y.encodeStateAsUpdate(room.doc));
      mimic.clientID = u.doc.clientID;
      newPara(frag(mimic), '');
      const z = new Y.Doc();
      Y.applyUpdate(z, Y.encodeStateAsUpdate(mimic));
      const svZ = Y.encodeStateVector(z);
      last(frag(z)).insert(0, 'X의 글');
      x.socket.emit('message', MSG(Y.encodeStateAsUpdate(z, svZ)));
      // U의 첫 변경이 그 부모를 만든다 — 보류분이 함께 들어와 믿을 수 없는 변경이 된다
      act(u, (f) => newPara(f, ''));
      typeAt(u, last, 0, '@collab-c 확인');
      expect(await saveAndCarol()).toEqual([{ actor_id: userId }]);
    });

    it('**첫 조각이 이미 지워진 문단으로 들어가도** 그 뒤 내 멘션은 나다', async () => {
      const u = await enter(userId);
      const x = await enter(otherId);
      act(x, (f) => f.delete(0, 1)); // X가 "처음" 문단을 지웠다
      // U는 그것을 받기 전에 그 문단에 한 글자를 쳤다 — 서버에서는 지워진 채로 들어온다
      const sv = Y.encodeStateVector(u.doc);
      u.doc.transact(() => textAt(frag(u.doc), 0).insert(0, '가'));
      u.socket.emit('message', MSG(Y.encodeStateAsUpdate(u.doc, sv)));
      act(u, (f) => newPara(f, ''));
      typeAt(u, last, 0, '@collab-c 확인');
      expect(await saveAndCarol()).toEqual([{ actor_id: userId }]);
    });
  });

  describe('**동시 편집은 위조가 아니다** — Yjs가 스스로 지우는 것 (세 번째 코드 리뷰 4)', () => {
    const forgeryWarnings = (spy: { mock: { calls: unknown[][] } }): string[] =>
      spy.mock.calls.map((c) => String(c[0])).filter((m) => m.includes('보낸 것보다'));

    it('X가 치는 동안 U가 그 문단을 지운다 — X의 새 글자가 딸려 지워진다', async () => {
      const warn = vi.spyOn(Logger.prototype, 'warn');
      try {
        const u = await enter(userId);
        const x = await enter(otherId);
        act(u, (f) => newPara(f, '가나'));
        act(x, (f) => last(f).insert(2, ' @collab-c'));
        // U는 X의 글자를 받기 전에 문단을 지웠다
        const sv = Y.encodeStateVector(u.doc);
        u.doc.transact(() => frag(u.doc).delete(frag(u.doc).length - 1, 1));
        u.socket.emit('message', MSG(Y.encodeStateAsUpdate(u.doc, sv)));
        expect(JSON.stringify(docFromYDoc(room.doc))).not.toContain('가나');
        expect(forgeryWarnings(warn)).toEqual([]);
      } finally {
        warn.mockRestore();
      }
    });

    it('둘이 같은 속성을 동시에 바꾼다 — 진 쪽 값이 들어오자마자 지워진다', async () => {
      const warn = vi.spyOn(Logger.prototype, 'warn');
      try {
        const u = await enter(userId);
        const x = await enter(otherId);
        act(u, (f) => newPara(f, '제목', 'heading'));
        Y.applyUpdate(x.doc, Y.encodeStateAsUpdate(room.doc), 'remote');
        const svU = Y.encodeStateVector(u.doc);
        const svX = Y.encodeStateVector(x.doc);
        (frag(u.doc).get(frag(u.doc).length - 1) as Y.XmlElement).setAttribute('level', 3 as never);
        (frag(x.doc).get(frag(x.doc).length - 1) as Y.XmlElement).setAttribute('level', 1 as never);
        x.socket.emit('message', MSG(Y.encodeStateAsUpdate(x.doc, svX)));
        u.socket.emit('message', MSG(Y.encodeStateAsUpdate(u.doc, svU)));
        expect(forgeryWarnings(warn)).toEqual([]);
      } finally {
        warn.mockRestore();
      }
    });
  });

  it('**만든 사람 표는 실시간 상태와 함께 남고, 재기동한 게이트웨이가 잇는다** (FR-903)', async () => {
    const u = await enter(userId);
    // 멘션과 함께 **저장할 수 없는 문서**를 만든다 — 버전은 안 생기고 상태만 남는 경로다. 관문이 받는 모양이어야 해서
    // (P9부터 `script` 같은 요소는 문 앞에서 끊긴다) 정상 편집기도 만들 수 있는 **깊이 한도(64) 넘는 인용**으로 만든다
    act(u, (f) => {
      newPara(f, '@collab-c 확인');
      let inner: Y.XmlElement = new Y.XmlElement('paragraph');
      for (let i = 0; i < 70; i++) {
        const q = new Y.XmlElement('blockquote');
        q.insert(0, [inner]);
        inner = q;
      }
      f.insert(f.length, [inner]);
    });
    expect((await gw.flush(pageId)).saved).toBe(false);
    const saved = await db.execute<{ authors: { makers: [number, number, string, string | null][] } }>(
      sql`SELECT authors FROM page_realtime WHERE page_id = ${pageId}`,
    );
    expect(saved.rows[0].authors.makers).toContainEqual([u.doc.clientID, expect.any(Number), 'collab-c', userId]);

    // 서버가 다시 떴다 — 메모리의 방은 없다
    const gw2 = build();
    try {
      const inner2 = gw2 as unknown as Internals;
      const room2 = await inner2.room(pageId, await currentVersion());
      expect(room2).not.toBe(room);
      const x = await enter(otherId, room2, inner2);
      // X가 그 깊은 인용을 지운다. **지우기만 했다** — 새 멘션은 없다
      act(x, (f) => f.delete(f.length - 1, 1), room2);

      expect((await gw2.flush(pageId)).saved).toBe(true);
      // 표가 없었으면 방을 다시 만들 때 그 자리는 "모름"이 됐다
      expect(await mentionRows(carolId)).toEqual([{ actor_id: userId }]);
    } finally {
      await gw2.onModuleDestroy().catch(() => undefined);
    }
  });
});
