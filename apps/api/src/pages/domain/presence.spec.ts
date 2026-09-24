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
  a.setLocalStateField('user', { name, color: '#b8433a' });
  return a;
}

describe('읽기 · 다시 쓰기 — y-protocols와 같은 모양', () => {
  it('화면이 보내는 프레임을 읽는다 — 클라이언트 ID·시계·상태', () => {
    const a = screenAwareness('U');
    try {
      const entries = readPresence(encodeAwarenessUpdate(a, [a.clientID]));
      expect(entries).toEqual([{ client: a.clientID, clock: 1, state: { user: { name: 'U', color: '#b8433a' } } }]);
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
    const out = screenPresence([entry(5, { user: { name: '관리자', color: '#1fa35c' }, cursor })], U, new Map([[5, U]]), '진짜 이름');
    expect(out).toEqual({ keep: [entry(5, { user: { name: '진짜 이름', color: '#1fa35c' }, cursor })], bind: [] });
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

  it('색은 `#rrggbb`만 — 캐럿(TipTap CollaborationCaret)이 받는 모양이다. 아니면 뺀다', () => {
    expect(clean({ user: { name: 'x', color: '#a1b2c3' } })).toEqual({ user: { name: 'U', color: '#a1b2c3' } });
    // 캐럿은 이 밖의 색을 투명으로 바꿔 그린다 — 화면이 예전에 만들던 `hsl(…)`도 그래서 캐럿이 보이지 않았다 (두 번째 자체 점검 5)
    for (const bad of ['hsl(7 70% 45%)', '#abc', '#a1b2c3ff', 'red; background:url(/api/pages)', 7]) {
      expect(clean({ user: { name: 'x', color: bad } })).toEqual({ user: { name: 'U' } });
    }
  });

  it('커서는 `{anchor, head}` 상대 위치 모양만 — 비었으면(null) 그대로, 모양이 틀리면 커서를 뺀다', () => {
    const pos = { type: null, tname: 'default', item: { client: 3, clock: 4 }, assoc: 0 };
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

/**
 * 커서 위치 — **동료의 편집기가 읽다 던지지 않는 것만** (P9 두 번째 보안 검토 1).
 *
 * 화면(y-tiptap의 커서 플러그인)은 남의 커서를 그릴 때마다 `Y.createAbsolutePositionFromRelativePosition`을 부른다. Yjs는
 * `item`·`type`·`tname`이 모두 비면 던진다. 그 예외는 **남의 변경을 받을 때마다** 편집기의 반영을 멈추고, 그 사람이 다음에 치는
 * 순간 멈춘 화면이 문서가 되어 **동료들의 편집이 모두에게서 지워졌다** — 브라우저에서 재현됐다.
 * 화면이 만드는 상대 위치는 늘 `type`·`tname` 중 **하나**가 있다(`Y.createRelativePosition`).
 */
describe('커서 위치 — Yjs가 읽어도 던지지 않는 모양만 (두 번째 보안 검토 1)', () => {
  const entry = (client: number, state: PresenceEntry['state']): PresenceEntry => ({ client, clock: 1, state });
  const cursorOf = (pos: unknown): unknown => {
    const kept = screenPresence([entry(5, { user: {}, cursor: { anchor: pos, head: pos } })], U, new Map([[5, U]]), 'U').keep[0].state;
    return (kept as { cursor?: unknown }).cursor;
  };
  /** 화면이 만드는 것과 같게 — `RelativePosition`을 JSON으로(빈 칸은 null로 남는다) */
  const asSent = (rpos: Y.RelativePosition): unknown => JSON.parse(JSON.stringify(rpos));

  it('화면이 만드는 상대 위치는 그대로 남긴다 — 글자 앞, 문서 끝(최상위 이름), 요소 끝(타입 ID)', () => {
    const d = new Y.Doc();
    const f = d.getXmlFragment('default');
    const p = new Y.XmlElement('paragraph');
    f.insert(0, [p]);
    const t = new Y.XmlText();
    p.insert(0, [t]);
    t.insert(0, '앞 문단');
    for (const rpos of [Y.createRelativePositionFromTypeIndex(t, 2), Y.createRelativePositionFromTypeIndex(f, f.length), Y.createRelativePositionFromTypeIndex(p, p.length, -1)]) {
      const pos = asSent(rpos);
      expect(cursorOf(pos)).toEqual({ anchor: pos, head: pos });
    }
  });

  it.each<[string, unknown]>([
    ['빈 위치', {}],
    ['전부 null', { type: null, tname: null, item: null, assoc: 0 }],
    ['글자만 있고 타입이 없다', { item: { client: 1, clock: 0 }, assoc: 0 }],
    ['타입 ID와 최상위 이름을 함께', { type: { client: 1, clock: 0 }, tname: 'default', item: null, assoc: 0 }],
    ['다른 최상위 이름 — 동료의 문서에 빈 최상위 타입이 생긴다', { tname: 'evil', assoc: 0 }],
    ['ID에 다른 키', { tname: 'default', item: { client: 1, clock: 0, evil: 1 }, assoc: 0 }],
    ['음수 시계', { tname: 'default', item: { client: 1, clock: -1 }, assoc: 0 }],
    ['숫자가 아닌 방향', { tname: 'default', item: null, assoc: '0' }],
  ])('%s는 뺀다', (_label, pos) => {
    expect(cursorOf(pos)).toBeUndefined();
  });

  it('남긴 커서는 Yjs가 읽어도 던지지 않는다', () => {
    const d = new Y.Doc();
    d.getXmlFragment('default').insert(0, [new Y.XmlElement('paragraph')]);
    const shapes: unknown[] = [
      {},
      { type: null, tname: null, item: null, assoc: 0 },
      { item: { client: 1, clock: 0 }, assoc: 0 },
      { tname: 'default', assoc: -1 },
      { type: { client: 999, clock: 3 }, tname: null, item: null, assoc: 0 },
      { tname: 'default', item: { client: 999, clock: 3 }, assoc: 0 },
    ];
    for (const pos of shapes) {
      const kept = cursorOf(pos) as { anchor: Record<string, unknown> } | undefined;
      if (!kept) continue;
      expect(() => Y.createAbsolutePositionFromRelativePosition(Y.createRelativePositionFromJSON(kept.anchor), d)).not.toThrow();
    }
  });
});

