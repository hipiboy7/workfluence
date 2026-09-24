import { describe, expect, it } from 'vitest';
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate } from 'y-protocols/awareness';
import * as Y from 'yjs';
import { readPresence, screenPresence, writePresence, type PresenceEntry } from './presence';

/**
 * A등급 — 사람 표시(awareness) 프레임 (P9_설계서_Gate D.5, FR-1004).
 *
 * 서버가 프레임을 **읽고 거른 뒤 다시 쓴다.** 읽기·쓰기는 y-protocols와 같은 모양이어야 한다 — 화면은
 * y-protocols의 `applyAwarenessUpdate`로 받는다. 그래서 시험의 기준은 y-protocols가 만든 프레임이다.
 */

const U = '00000000-0000-4000-8000-00000000000a';
const X = '00000000-0000-4000-8000-00000000000b';

function screenAwareness(name: string): Awareness {
  const a = new Awareness(new Y.Doc());
  a.setLocalStateField('user', { name, color: 'hsl(1 70% 45%)' });
  return a;
}

describe('읽기 · 다시 쓰기 — y-protocols와 같은 모양', () => {
  it('화면이 보내는 프레임을 읽는다 — 클라이언트 ID·시계·상태', () => {
    const a = screenAwareness('U');
    try {
      const entries = readPresence(encodeAwarenessUpdate(a, [a.clientID]));
      expect(entries).toEqual([{ client: a.clientID, clock: 1, state: { user: { name: 'U', color: 'hsl(1 70% 45%)' } } }]);
    } finally {
      a.destroy();
    }
  });

  it('읽은 것을 다시 쓰면 바이트까지 같다 — 여럿·빈 상태(떠남) 포함', () => {
    const a = screenAwareness('U');
    const b = screenAwareness('X');
    try {
      applyAwarenessUpdate(a, encodeAwarenessUpdate(b, [b.clientID]), 'remote');
      b.setLocalState(null);
      applyAwarenessUpdate(a, encodeAwarenessUpdate(b, [b.clientID]), 'remote');
      const frame = encodeAwarenessUpdate(a, [a.clientID, b.clientID]);
      const entries = readPresence(frame);
      expect(entries.map((e) => e.state === null)).toEqual([false, true]);
      expect(Buffer.from(writePresence(entries)).equals(Buffer.from(frame))).toBe(true);
    } finally {
      a.destroy();
      b.destroy();
    }
  });

  it('다시 쓴 프레임을 화면(y-protocols)이 그대로 받는다', () => {
    const peer = new Awareness(new Y.Doc());
    try {
      const out = writePresence([{ client: 12345, clock: 3, state: { user: { name: '서버가 정한 이름' } } }]);
      applyAwarenessUpdate(peer, out, 'remote');
      expect(peer.getStates().get(12345)).toEqual({ user: { name: '서버가 정한 이름' } });
    } finally {
      peer.destroy();
    }
  });

  it('항목이 없는 프레임은 빈 목록이다', () => {
    expect(readPresence(Uint8Array.of(0))).toEqual([]);
  });

  it.each<[string, Uint8Array]>([
    ['빈 프레임', new Uint8Array()],
    ['잘린 숫자', Uint8Array.of(0x80)],
    ['개수만 있고 항목이 없다', Uint8Array.of(1)],
    ['문자열 길이가 남은 바이트보다 길다', Uint8Array.of(1, 1, 1, 9, 0x7b)],
    ['JSON이 깨졌다', Uint8Array.of(1, 1, 1, 1, 0x7b)],
    ['상태가 객체도 null도 아니다', Uint8Array.of(1, 1, 1, 1, 0x33)],
    ['끝에 바이트가 남는다', Uint8Array.of(0, 7)],
    ['2^53을 넘는 숫자', Uint8Array.of(1, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x7f, 0, 4, 0x6e, 0x75, 0x6c, 0x6c)],
  ])('읽지 못하면 던진다 — %s', (_label, frame) => {
    expect(() => readPresence(frame)).toThrow();
  });
});

describe('거르기 — 남의 몫은 빼고, 이름은 서버가 정한다 (D.5)', () => {
  const entry = (client: number, state: PresenceEntry['state']): PresenceEntry => ({ client, clock: 1, state });

  it('보낸 사람이 주인인 몫은 남기고 이름을 서버가 아는 표시 이름으로 바꾼다 — 화면이 만드는 색과 커서는 그대로', () => {
    const at = { tname: 'default', item: { client: 5, clock: 2 }, assoc: 0 };
    const cursor = { anchor: at, head: { type: { client: 5, clock: 0 }, item: { client: 5, clock: 3 }, assoc: -1 } };
    const out = screenPresence([entry(5, { user: { name: '관리자', color: 'hsl(120 70% 45%)' }, cursor })], U, new Map([[5, U]]), '진짜 이름');
    expect(out).toEqual({ keep: [entry(5, { user: { name: '진짜 이름', color: 'hsl(120 70% 45%)' }, cursor })], bind: [] });
  });

  it('주인 없는 몫은 보낸 사람에게 묶고 남긴다 — 화면이 열자마자 자기 ID를 알리는 때다 (D.4)', () => {
    expect(screenPresence([entry(7, { user: { name: 'U' } })], U, new Map(), 'U')).toEqual({ keep: [entry(7, { user: { name: 'U' } })], bind: [7] });
  });

  it('남이 주인인 몫은 뺀다 — 정상 화면은 받은 남의 표시를 되돌려 보낸다(메아리). 남의 커서·이름을 꾸미는 길도 막힌다', () => {
    expect(screenPresence([entry(5, { user: { name: 'U' } })], X, new Map([[5, U]]), 'X')).toEqual({ keep: [], bind: [] });
  });

  it('떠남(빈 상태)은 그대로 남긴다', () => {
    expect(screenPresence([entry(5, null)], U, new Map([[5, U]]), 'U')).toEqual({ keep: [entry(5, null)], bind: [] });
  });

  it('상태에 사람이 없거나 모양이 틀려도 이름을 서버가 채운다', () => {
    expect(screenPresence([entry(5, {})], U, new Map([[5, U]]), 'U').keep[0].state).toEqual({ user: { name: 'U' } });
    expect(screenPresence([entry(5, { user: 'x' })], U, new Map([[5, U]]), 'U').keep[0].state).toEqual({ user: { name: 'U' } });
  });

  it('같은 프레임에 섞여 와도 항목마다 따로 판정한다 — 여럿인 프레임의 주인 없는 몫은 묶지 않고 뺀다(자기 알림은 한 항목이다)', () => {
    const out = screenPresence([entry(5, { user: { name: 'a' } }), entry(6, { user: { name: 'b' } }), entry(8, { user: { name: 'c' } })], U, new Map([[5, U], [6, X]]), 'U');
    expect(out.keep.map((e) => e.client)).toEqual([5]);
    expect(out.bind).toEqual([]);
  });
});

/**
 * 상태 거르기 — **화면이 만드는 모양만 남긴다** (P9 코드 리뷰 6 · 보안 검토 3).
 * 캐럿(TipTap CollaborationCaret)은 `user.color`를 `style`에 그대로 넣고, 커서(y-prosemirror)는 `cursor`를 상대 위치로 읽는다.
 * 조작한 클라이언트가 그 값으로 동료의 화면에 CSS를 넣거나 커서 그리기를 깨뜨리지 못하게, 알려진 모양이 아니면 그 필드를 뺀다.
 */
describe('상태 거르기 — 화면이 만드는 모양만 (P9 코드 리뷰 6·보안 검토 3)', () => {
  const entry = (client: number, state: PresenceEntry['state']): PresenceEntry => ({ client, clock: 1, state });
  const clean = (state: Record<string, unknown>): Record<string, unknown> | null => screenPresence([entry(5, state)], U, new Map([[5, U]]), 'U').keep[0].state;

  it('색은 `hsl(…)`·`#rrggbb` 모양만 — 아니면 뺀다', () => {
    expect(clean({ user: { name: 'x', color: 'hsl(7 70% 45%)' } })).toEqual({ user: { name: 'U', color: 'hsl(7 70% 45%)' } });
    expect(clean({ user: { name: 'x', color: '#a1b2c3' } })).toEqual({ user: { name: 'U', color: '#a1b2c3' } });
    expect(clean({ user: { name: 'x', color: 'red; background:url(/api/pages)' } })).toEqual({ user: { name: 'U' } });
    expect(clean({ user: { name: 'x', color: 7 } })).toEqual({ user: { name: 'U' } });
  });

  it('커서는 `{anchor, head}` 상대 위치 모양만 — 비었으면(null) 그대로, 모양이 틀리면 커서를 뺀다', () => {
    const pos = { type: { client: 1, clock: 2 }, tname: 'default', item: { client: 3, clock: 4 }, assoc: 0 };
    expect(clean({ user: {}, cursor: { anchor: pos, head: pos } })).toEqual({ user: { name: 'U' }, cursor: { anchor: pos, head: pos } });
    expect(clean({ user: {}, cursor: null })).toEqual({ user: { name: 'U' }, cursor: null });
    for (const bad of [{ anchor: 5, head: pos }, { anchor: pos }, { anchor: { ...pos, evil: 1 }, head: pos }, { anchor: { item: { client: -1, clock: 0 } }, head: pos }, 'x']) {
      expect(clean({ user: {}, cursor: bad })).toEqual({ user: { name: 'U' } });
    }
  });

  it('모르는 필드는 뺀다', () => {
    expect(clean({ user: { name: 'x', evil: 1 }, evil: { a: 1 } })).toEqual({ user: { name: 'U' } });
  });
});

describe('묶기 상한 — 한 항목짜리 프레임의 살아 있는 몫만, 연결마다 몇 개까지 (P9 코드 리뷰 5·자체 점검 3)', () => {
  const entry = (client: number, state: PresenceEntry['state']): PresenceEntry => ({ client, clock: 1, state });

  it('주인 없는 몫이 떠남(null)으로 오면 묶지 않고 뺀다 — 정상 화면은 자기 ID를 먼저 알린 뒤에 떠난다', () => {
    expect(screenPresence([entry(7, null)], U, new Map(), 'U')).toEqual({ keep: [], bind: [] });
  });

  it('묶을 수 있는 수(`canBind`)가 남지 않았으면 묶지 않고 뺀다', () => {
    expect(screenPresence([entry(7, { user: {} })], U, new Map(), 'U', 0)).toEqual({ keep: [], bind: [] });
    expect(screenPresence([entry(7, { user: {} })], U, new Map(), 'U', 1)).toEqual({ keep: [entry(7, { user: { name: 'U' } })], bind: [7] });
  });
});

