import { COLLAB_CLOSE_REFUSED, COLLAB_MSG } from '@workfluence/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate } from 'y-protocols/awareness';
import * as Y from 'yjs';
import { CollabLink, colorFor, type CollabState, type SocketLike } from './collabLink';

/**
 * 실시간 편집의 연결 하나 — **브라우저 없이** 상태 기계를 본다 (P9_설계서_Gate G절, 3절).
 *
 * 소켓은 가짜다. 확인하는 것은 무엇을 언제 보내고, 받은 것을 어떻게 넘기고, 끊길 때 무엇을 말하는가다. 서버 쪽 판정은
 * 게이트웨이 통합 시험이, 화면 전체의 흐름은 E2E가 본다.
 */

class FakeSocket implements SocketLike {
  readyState = 0;
  binaryType: BinaryType = 'blob';
  sent: Uint8Array[] = [];
  closed = false;
  onopen: SocketLike['onopen'] = null;
  onmessage: SocketLike['onmessage'] = null;
  onclose: SocketLike['onclose'] = null;
  onerror: SocketLike['onerror'] = null;
  send(data: Uint8Array): void {
    this.sent.push(data);
  }
  close(): void {
    this.closed = true;
    this.readyState = 3;
  }
  open(): void {
    this.readyState = 1;
    this.onopen?.({} as Event);
  }
  deliver(kind: number, payload: Uint8Array): void {
    const frame = new Uint8Array(payload.length + 1);
    frame[0] = kind;
    frame.set(payload, 1);
    this.onmessage?.({ data: frame.buffer } as MessageEvent<ArrayBuffer>);
  }
  shut(code: number): void {
    this.readyState = 3;
    this.onclose?.({ code } as CloseEvent);
  }
}

const cleanup: (() => void)[] = [];
afterEach(() => {
  while (cleanup.length) cleanup.pop()!();
});

function setup(doc = new Y.Doc(), awareness = new Awareness(doc)) {
  cleanup.push(() => awareness.destroy());
  const states: CollabState[] = [];
  const blocked: (string | null)[] = [];
  let socket!: FakeSocket;
  const link = new CollabLink({
    url: 'ws://example.internal/api/ws/pages/p',
    doc,
    awareness,
    user: { name: '나', color: colorFor('나') },
    onState: (s) => states.push(s),
    onSaveBlocked: (r) => blocked.push(r),
    connect: () => (socket = new FakeSocket()),
  });
  return { link, socket, doc, awareness, states, blocked };
}
const kinds = (s: FakeSocket): number[] => s.sent.map((f) => f[0]);
/** 보낸 사람 표시 프레임을 동료의 화면(y-protocols)처럼 받아, 그 화면이 알게 된 **남의** 몫을 돌려준다 */
function seenBy(frames: Uint8Array[]): Map<number, unknown> {
  const peer = new Awareness(new Y.Doc());
  cleanup.push(() => peer.destroy());
  for (const f of frames) if (f[0] === COLLAB_MSG.awareness) applyAwarenessUpdate(peer, f.subarray(1), 'remote');
  return new Map([...peer.getStates()].filter(([id]) => id !== peer.clientID));
}

describe('여는 순서 (P9 D.4)', () => {
  it('열리면 **나를 먼저 알리고** 전체 상태를 보낸다 — 알림에는 내 몫 하나만', () => {
    const { socket, awareness, states } = setup();
    socket.open();
    expect(states).toEqual(['connecting', 'live']);
    expect(kinds(socket)).toEqual([COLLAB_MSG.awareness, COLLAB_MSG.update]);
    const peer = seenBy(socket.sent);
    expect([...peer.keys()]).toEqual([awareness.clientID]);
    expect(peer.get(awareness.clientID)).toEqual({ user: { name: '나', color: colorFor('나') } });
  });

  it('**같은 문서로 다시 붙어도 나를 알린다** — 앞 연결이 내 표시를 지운 뒤라도 (두 번째 코드 리뷰 1)', () => {
    const doc = new Y.Doc();
    const awareness = new Awareness(doc);
    const first = setup(doc, awareness);
    first.socket.open();
    first.link.close();
    expect(awareness.getLocalState()).toBeNull(); // 정리하며 퇴장을 알렸다
    const again = setup(doc, awareness);
    again.socket.open();
    const peer = seenBy(again.socket.sent);
    expect(peer.get(awareness.clientID)).toEqual({ user: { name: '나', color: colorFor('나') } });
  });

  it('Yjs가 문서의 ID를 바꿔도 **사람 표시의 ID로** 알린다 (두 번째 자체 점검 6)', () => {
    const doc = new Y.Doc();
    const awareness = new Awareness(doc);
    const shown = awareness.clientID;
    doc.clientID = shown + 1; // 남이 내 ID로 쓴 것을 받으면 Yjs가 스스로 바꾼다
    const { socket } = setup(doc, awareness);
    expect(() => socket.open()).not.toThrow();
    expect([...seenBy(socket.sent).keys()]).toEqual([shown]);
  });
});

describe('보내는 것 — 내 것만 (두 번째 코드 리뷰 9)', () => {
  it('내 편집은 보내고 받은 편집은 되돌려 보내지 않는다', () => {
    const { socket, doc } = setup();
    socket.open();
    const before = socket.sent.length;
    doc.getXmlFragment('default').insert(0, [new Y.XmlElement('paragraph')]);
    expect(kinds(socket).slice(before)).toEqual([COLLAB_MSG.update]);
    const other = new Y.Doc();
    other.getXmlFragment('default').insert(0, [new Y.XmlElement('paragraph')]);
    socket.deliver(COLLAB_MSG.update, Y.encodeStateAsUpdate(other));
    expect(socket.sent.length).toBe(before + 1);
  });

  it('받은 남의 표시는 되돌려 보내지 않는다 — 서버가 읽고 버릴 뿐이다', () => {
    const { socket, awareness } = setup();
    socket.open();
    const before = socket.sent.length;
    const peer = new Awareness(new Y.Doc());
    cleanup.push(() => peer.destroy());
    peer.setLocalStateField('user', { name: '동료' });
    socket.deliver(COLLAB_MSG.awareness, encodeAwarenessUpdate(peer, [peer.clientID]));
    expect(awareness.getStates().has(peer.clientID)).toBe(true);
    expect(socket.sent.length).toBe(before);
  });

  it('내 표시를 고치면 **내 몫만** 보낸다 — 알고 있는 남의 몫은 싣지 않는다', () => {
    const { socket, awareness } = setup();
    socket.open();
    const peer = new Awareness(new Y.Doc());
    cleanup.push(() => peer.destroy());
    peer.setLocalStateField('user', { name: '동료' });
    socket.deliver(COLLAB_MSG.awareness, encodeAwarenessUpdate(peer, [peer.clientID]));
    const before = socket.sent.length;
    awareness.setLocalStateField('cursor', null);
    expect([...seenBy(socket.sent.slice(before)).keys()]).toEqual([awareness.clientID]);
  });
});

describe('받는 것 — 저장 상태 (P9 FR-1011)', () => {
  it('서버가 알린 까닭을 넘기고, 풀리면 null을 넘긴다. 읽지 못하는 알림은 무시한다', () => {
    const { socket, blocked } = setup();
    socket.open();
    const enc = new TextEncoder();
    socket.deliver(COLLAB_MSG.status, enc.encode(JSON.stringify({ saveBlocked: '노드 수 50000 초과' })));
    socket.deliver(COLLAB_MSG.status, enc.encode('{깨진'));
    socket.deliver(COLLAB_MSG.status, enc.encode(JSON.stringify({ saveBlocked: null })));
    expect(blocked).toEqual(['노드 수 50000 초과', null]);
  });
});

describe('끊길 때 (P9 FR-1005·1011, 코드 리뷰 7)', () => {
  it('그냥 끊기면 "끊겼다", 관문이 끊으면(4400) "받지 않았다" — 어느 쪽이든 저장 상태는 지운다', () => {
    const a = setup();
    a.socket.open();
    a.socket.shut(1006);
    expect(a.states.at(-1)).toBe('offline');
    expect(a.blocked).toEqual([null]);
    const b = setup();
    b.socket.open();
    b.socket.shut(COLLAB_CLOSE_REFUSED);
    b.socket.onerror?.({} as Event);
    expect(b.states.at(-1)).toBe('refused');
  });

  it('정리한 뒤에는 **옛 소켓의 소식을 듣지 않는다** — 다시 붙을 때 옛 소켓이 늦게 닫혀도 새 화면이 "끊겼다"가 되지 않는다', () => {
    const { link, socket, states } = setup();
    socket.open();
    link.close();
    expect(socket.closed).toBe(true);
    expect([socket.onopen, socket.onmessage, socket.onclose, socket.onerror]).toEqual([null, null, null, null]);
    expect(states).toEqual(['connecting', 'live']);
  });
});

describe('색 (P9 D.5, 두 번째 자체 점검 5)', () => {
  it('캐럿이 받는 `#rrggbb`로 만들고, 같은 이름은 늘 같은 색이다', () => {
    for (const name of ['나', 'E2E 협업동료', 'collab-a', '']) {
      expect(colorFor(name)).toMatch(/^#[0-9a-f]{6}$/);
      expect(colorFor(name)).toBe(colorFor(name));
    }
    expect(colorFor('가')).not.toBe(colorFor('나'));
  });
});
