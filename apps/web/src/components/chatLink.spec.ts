import { CHAT_CLOSE, type ChatServerFrame } from '@workfluence/shared';
import { describe, expect, it } from 'vitest';
import { ChatSendError, createChatLink, type ChatLinkState, type ChatSocketLike } from './chatLink';

class FakeSocket implements ChatSocketLike {
  sent: string[] = [];
  closed = false;
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  send(d: string) {
    this.sent.push(d);
  }
  close() {
    this.closed = true;
  }
  recv(f: ChatServerFrame) {
    this.onmessage?.({ data: JSON.stringify(f) });
  }
  drop(code = 1006) {
    this.onclose?.({ code });
  }
}

function harness() {
  const sockets: FakeSocket[] = [];
  const states: ChatLinkState[] = [];
  const frames: ChatServerFrame[] = [];
  let resyncs = 0;
  const timers: { fn: () => void; ms: number; id: number; live: boolean }[] = [];
  const link = createChatLink({
    open: () => {
      const s = new FakeSocket();
      sockets.push(s);
      return s;
    },
    onState: (s) => states.push(s),
    onFrame: (f) => void (f.type !== 'hello' && frames.push(f)), // hello는 화면이 방 목록을 받는 신호로 쓴다
    onResync: () => resyncs++,
    setTimer: (fn, ms) => {
      const t = { fn, ms, id: timers.length, live: true };
      timers.push(t);
      return t.id;
    },
    clearTimer: (id) => {
      timers[id as number]!.live = false;
    },
    newId: (() => {
      let n = 0;
      return () => `id${++n}`;
    })(),
    backoffMs: [10, 20, 40],
    ackTimeoutMs: 500,
  });
  const fire = (ms?: number) => timers.filter((t) => t.live && (ms === undefined || t.ms === ms)).forEach((t) => ((t.live = false), t.fn()));
  const hello = (s: FakeSocket) => s.recv({ type: 'hello', userId: 'u1', roomIds: [] });
  return { link, sockets, states, frames, timers, fire, hello, resyncs: () => resyncs };
}

describe('createChatLink (G절)', () => {
  it('hello를 받으면 live가 되고 처음에는 다시 메우지 않는다', () => {
    const h = harness();
    h.link.start();
    h.hello(h.sockets[0]!);
    expect(h.states).toEqual(['live']); // 처음 상태(connecting)에서 live로
    expect(h.resyncs()).toBe(0);
  });

  it('끊기면 offline이 되어 기다린 뒤 다시 붙고, hello가 오면 놓친 것을 메운다', () => {
    const h = harness();
    h.link.start();
    h.hello(h.sockets[0]!);
    h.sockets[0]!.drop();
    expect(h.link.state).toBe('offline');
    h.fire(10);
    expect(h.sockets).toHaveLength(2);
    h.hello(h.sockets[1]!);
    expect(h.link.state).toBe('live');
    expect(h.resyncs()).toBe(1);
  });

  it('붙지 못하는 동안 기다림이 늘어나다 멈추고, 붙으면 처음으로 돌아온다', () => {
    const h = harness();
    h.link.start();
    for (const ms of [10, 20, 40, 40]) {
      h.sockets.at(-1)!.drop();
      expect(h.timers.filter((t) => t.live).map((t) => t.ms)).toEqual([ms]);
      h.fire();
    }
    h.hello(h.sockets.at(-1)!);
    h.sockets.at(-1)!.drop();
    expect(h.timers.filter((t) => t.live).map((t) => t.ms)).toEqual([10]);
  });

  it('세션이 끝나(4401) 닫히면 다시 붙지 않는다 — revoked', () => {
    const h = harness();
    h.link.start();
    h.hello(h.sockets[0]!);
    h.sockets[0]!.drop(CHAT_CLOSE.revoked);
    expect(h.link.state).toBe('revoked');
    expect(h.timers.filter((t) => t.live)).toEqual([]);
  });

  it('서버가 프레임을 받지 않고 끊으면(4400) 다시 붙지 않는다 — refused', () => {
    const h = harness();
    h.link.start();
    h.hello(h.sockets[0]!);
    h.sockets[0]!.drop(CHAT_CLOSE.badFrame);
    expect(h.link.state).toBe('refused');
  });

  it('연결 상한으로 밀려나면(4409) 스스로 다시 붙지 않는다 — 사람이 누르면 다시 붙는다 (코드 리뷰 4)', () => {
    const h = harness();
    h.link.start();
    h.hello(h.sockets[0]!);
    h.sockets[0]!.drop(CHAT_CLOSE.evicted);
    expect(h.link.state).toBe('evicted');
    expect(h.timers.filter((t) => t.live)).toEqual([]);
    h.link.reconnect();
    expect(h.sockets).toHaveLength(2);
    h.hello(h.sockets[1]!);
    expect(h.link.state).toBe('live');
    expect(h.resyncs()).toBe(1);
  });

  it('보내기는 ack로 끝난다 — clientMsgId를 붙여 보낸다', async () => {
    const h = harness();
    h.link.start();
    h.hello(h.sockets[0]!);
    const p = h.link.send('r1', '안녕');
    expect(JSON.parse(h.sockets[0]!.sent[0]!)).toEqual({ type: 'send', roomId: 'r1', body: '안녕', clientMsgId: 'id1' });
    h.sockets[0]!.recv({ type: 'ack', clientMsgId: 'id1', roomId: 'r1', seq: 7, createdAt: 't' });
    await expect(p).resolves.toEqual({ seq: 7, roomId: 'r1', createdAt: 't', clientMsgId: 'id1' });
    expect(h.frames).toEqual([]); // 보내기의 결과는 호출한 쪽이 받는다
  });

  it('서버가 그 메시지만 거절하면 그 까닭으로 실패한다', async () => {
    const h = harness();
    h.link.start();
    h.hello(h.sockets[0]!);
    const p = h.link.send('r1', 'x', 'k1');
    h.sockets[0]!.recv({ type: 'error', code: 'TOO_LONG', roomId: 'r1', clientMsgId: 'k1' });
    await expect(p).rejects.toMatchObject({ name: 'ChatSendError', code: 'TOO_LONG', clientMsgId: 'k1' });
  });

  it('끊겨 있으면 보내지 못하고, 보내는 중에 끊기면 OFFLINE으로 실패한다(같은 clientMsgId로 다시 보낼 수 있다)', async () => {
    const h = harness();
    h.link.start();
    await expect(h.link.send('r1', 'x', 'k0')).rejects.toBeInstanceOf(ChatSendError); // connecting
    h.hello(h.sockets[0]!);
    const p = h.link.send('r1', 'x', 'k1');
    h.sockets[0]!.drop();
    await expect(p).rejects.toMatchObject({ code: 'OFFLINE', clientMsgId: 'k1' });
  });

  it('ack가 오지 않으면 TIMEOUT', async () => {
    const h = harness();
    h.link.start();
    h.hello(h.sockets[0]!);
    const p = h.link.send('r1', 'x', 'k1');
    h.fire(500);
    await expect(p).rejects.toMatchObject({ code: 'TIMEOUT' });
  });

  it('새 메시지·방 프레임은 화면으로 넘긴다', () => {
    const h = harness();
    h.link.start();
    h.hello(h.sockets[0]!);
    h.sockets[0]!.recv({ type: 'message', roomId: 'r1', seq: 1, senderId: 'u2', body: 'hi', kind: 'user', createdAt: 't' });
    h.sockets[0]!.recv({ type: 'room', roomId: 'r2', change: 'joined' });
    expect(h.frames.map((f) => f.type)).toEqual(['message', 'room']);
  });

  it('옛 소켓의 늦은 닫힘·메시지는 새 연결을 건드리지 않는다', () => {
    const h = harness();
    h.link.start();
    h.hello(h.sockets[0]!);
    h.sockets[0]!.drop();
    h.fire(10);
    h.hello(h.sockets[1]!);
    h.sockets[0]!.drop(); // 늦게 온 닫힘
    h.sockets[0]!.recv({ type: 'message', roomId: 'r1', seq: 9, senderId: 'u2', body: 'old', kind: 'user', createdAt: 't' });
    expect(h.link.state).toBe('live');
    expect(h.frames).toEqual([]);
  });

  it('멈추면 소켓을 닫고 다시 붙지 않는다', () => {
    const h = harness();
    h.link.start();
    h.hello(h.sockets[0]!);
    h.link.stop();
    expect(h.sockets[0]!.closed).toBe(true);
    h.sockets[0]!.drop();
    expect(h.timers.filter((t) => t.live)).toEqual([]);
  });
});
