import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { screenIsAhead } from './received';

/**
 * A등급 — **저장하고 보기로가 화면의 입력을 다 받았는가** (P13 D.7, FR-1462). 화면이 보낸 스냅숏(상태 벡터 + 지운 기록)과 방의 문서를 견준다.
 * 처음 판은 상태 벡터만 보았다 — 지우기는 상태 벡터를 올리지 않아, 지우기만 한 입력이 닿지 않아도 "받았다"였다 (좁은 자체 점검 2)
 */

const sync = (from: Y.Doc, to: Y.Doc) => Y.applyUpdate(to, Y.encodeStateAsUpdate(from, Y.encodeStateVector(to)));
const snap = (d: Y.Doc) => Y.encodeSnapshot(Y.snapshot(d));

/** 화면이 글을 쓰고 서버가 받은 상태 */
function pair() {
  const server = new Y.Doc();
  const screen = new Y.Doc();
  screen.getText('t').insert(0, '처음 문장입니다');
  sync(screen, server);
  return { server, screen };
}

/** 스냅숏을 손으로 만든다 — 조작한 화면이 보낼 수 있는 값 */
const forged = (sv: Map<number, number>, deleted: Map<number, { clock: number; len: number }[]>) => {
  const ds = Y.createDeleteSet();
  for (const [client, items] of deleted) ds.clients.set(client, items as never);
  return Y.encodeSnapshot(Y.createSnapshot(ds, sv));
};

describe('screenIsAhead — 화면이 서버보다 앞섰나', () => {
  it('받은 그대로면 아니다', () => {
    const { server, screen } = pair();
    expect(screenIsAhead(server, snap(screen))).toBe(false);
  });

  it('**넣은 것이 닿지 않았으면 앞선다**', () => {
    const { server, screen } = pair();
    screen.getText('t').insert(0, '보내지 못한 ');
    expect(screenIsAhead(server, snap(screen))).toBe(true);
    sync(screen, server);
    expect(screenIsAhead(server, snap(screen))).toBe(false);
    // 서버가 아직 모르는 사람(처음 붙어 쓴 화면)이 넣은 것도
    const newcomer = new Y.Doc();
    sync(server, newcomer);
    newcomer.getText('t').insert(0, '새로 온 사람의 ');
    expect(screenIsAhead(server, snap(newcomer))).toBe(true);
  });

  it('**지우기만 한 것이 닿지 않아도 앞선다** — 상태 벡터는 그대로다 (좁은 자체 점검 2)', () => {
    const { server, screen } = pair();
    const before = Y.encodeStateVector(screen);
    screen.getText('t').delete(0, 3);
    expect(Y.encodeStateVector(screen)).toEqual(before); // 상태 벡터만으로는 가릴 수 없다
    expect(screenIsAhead(server, snap(screen))).toBe(true);
    sync(screen, server);
    expect(screenIsAhead(server, snap(screen))).toBe(false);
  });

  it('**지운 구간의 일부만 닿았으면 앞선다** — 앞의 지우기는 닿고 뒤의 것은 오는 중', () => {
    const { server, screen } = pair();
    screen.getText('t').delete(0, 2);
    sync(screen, server);
    screen.getText('t').delete(0, 2); // 이어지는 구간 — 화면의 지운 기록에서 앞 구간과 하나로 합쳐진다
    expect(screenIsAhead(server, snap(screen))).toBe(true);
    sync(screen, server);
    expect(screenIsAhead(server, snap(screen))).toBe(false);
  });

  it('서버가 앞선 것(동료가 넣고 지운 것)은 상관없다', () => {
    const { server, screen } = pair();
    const peer = new Y.Doc();
    sync(server, peer);
    peer.getText('t').insert(0, '동료의 ');
    peer.getText('t').delete(5, 2);
    sync(peer, server);
    expect(screenIsAhead(server, snap(screen))).toBe(false);
  });

  it('서버가 지운 조각을 거둬 간 것(gc)도 지운 것으로 본다 — 덮어쓴 지도 안의 값', () => {
    const server = new Y.Doc({ gc: true });
    const screen = new Y.Doc({ gc: false });
    const nested = new Y.Map<string>();
    screen.getMap('m').set('k', nested);
    nested.set('a', 'x');
    nested.set('b', 'y');
    sync(screen, server);
    screen.getMap('m').set('k', '다른 값'); // 안의 지도가 통째로 지워진다
    expect(screenIsAhead(server, snap(screen))).toBe(true);
    sync(screen, server);
    // 서버는 지워진 지도의 값을 거둬 갔다 — 조각이 `GC`로 바뀌었다
    expect([...server.store.clients.values()].flat().some((s) => s instanceof Y.GC)).toBe(true);
    expect(screenIsAhead(server, snap(screen))).toBe(false);
  });

  it('**읽지 못하는 값은 보지 않는다** — 조작한 값은 그 사람의 저장 판정만 흐린다', () => {
    const { server } = pair();
    for (const bad of [new Uint8Array([255, 255, 255]), new Uint8Array([]), new Uint8Array([1])]) expect(screenIsAhead(server, bad)).toBe(false);
  });

  it('서버가 모르는 클라이언트의 지운 기록, 서버가 가진 것을 넘는 구간이면 앞선다(조작) — 그 사람의 저장만 멈춘다', () => {
    const { server, screen } = pair();
    const sv = Y.decodeStateVector(Y.encodeStateVector(screen));
    const [client, clock] = [...sv][0];
    expect(screenIsAhead(server, forged(sv, new Map([[client + 1, [{ clock: 0, len: 1 }]]])))).toBe(true);
    expect(screenIsAhead(server, forged(sv, new Map([[client, [{ clock: clock - 1, len: 2 }]]])))).toBe(true);
    // 길이 0인 구간은 지운 것이 없다
    expect(screenIsAhead(server, forged(sv, new Map([[client, [{ clock: 0, len: 0 }]]])))).toBe(false);
  });
});
