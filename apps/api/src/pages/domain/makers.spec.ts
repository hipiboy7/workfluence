import { describe, expect, it } from 'vitest';
import {
  advance,
  claimOwn,
  deliveredBy,
  emptyLedger,
  isFaithful,
  ledgerFromJson,
  ledgerToJson,
  makersFor,
  recordDelivered,
  settle,
  type DeletedItem,
  type Ledger,
  type Site,
} from './makers';

/**
 * A등급 — 멘션을 **만든** 사람 (P8_설계서_Mention C.2절, FR-900·904·907).
 *
 * 멘션 하나는 `@` 글자의 ID와 이름으로 가린다. 멤버의 변경이 끝날 때마다 문서의 멘션 자리를 다시 훑고,
 * 새로 생긴 자리에 그 멤버를 적는다 — **다만 그 멘션의 글자를 전부 그 멤버의 연결이 들여왔을 때만.**
 * 믿는 것은 서버가 직접 본 사실(어느 연결이 무엇을 들여왔나)뿐이다. 클라이언트 ID·이웃 같은, 클라이언트가
 * 정하는 값은 믿지 않는다.
 */

const U = '00000000-0000-4000-8000-00000000000a';
const X = '00000000-0000-4000-8000-00000000000b';

/** 클라이언트 `c`가 시계 `from`부터 이어 친 멘션 자리. `@`가 첫 글자다 */
const site = (c: number, from: number, name: string): Site => ({
  key: `${c}:${from}`,
  name,
  span: [...Array(name.length + 1)].map((_, i) => [c, from + i] as const),
});
/** 클라이언트 `c`의 `[from, to)`를 `who`가 들여온 장부 */
const ledgerWith = (...ranges: [number, number, number, string | null][]): Ledger => {
  const l = emptyLedger();
  for (const [c, from, to, who] of ranges) recordDelivered(l.delivered, c, { from, to }, who);
  return l;
};

describe('advance — 새로 생긴 자리', () => {
  it('**글자를 전부 들여온 사람이 그 변경을 보냈으면** 그 사람이다', () => {
    const l = advance(ledgerWith([1, 0, 10, U]), [site(1, 0, 'kim')], U);
    expect(l.makers.get('1:0|kim')).toBe(U);
  });

  it('**남이 들여온 글자를 내 변경이 멘션으로 완성하면 모름** — 공격자의 `hello@admin`에 피해자가 공백 하나 (P8 세 번째 코드 리뷰 2)', () => {
    const l = advance(ledgerWith([1, 0, 10, X]), [site(1, 0, 'kim')], U);
    expect(l.makers.get('1:0|kim')).toBeNull();
  });

  it('**내 글자를 남의 변경이 멘션으로 만들면 모름** — 남이 뒷글자를 지우거나 공백을 끼웠다', () => {
    const l = advance(ledgerWith([1, 0, 10, U]), [site(1, 0, 'kim')], X);
    expect(l.makers.get('1:0|kim')).toBeNull();
  });

  it('글자가 섞였으면 모름 — A가 `@ki`, B가 `m`', () => {
    const s: Site = { key: '1:0', name: 'kim', span: [[1, 0], [1, 1], [1, 2], [2, 0]] };
    const l = advance(ledgerWith([1, 0, 3, U], [2, 0, 1, X]), [s], X);
    expect(l.makers.get('1:0|kim')).toBeNull();
  });

  it('들여온 사람을 모르는 글자(정본·믿을 수 없는 변경)가 섞였으면 모름', () => {
    expect(advance(emptyLedger(), [site(1, 0, 'kim')], U).makers.get('1:0|kim')).toBeNull();
  });

  it('믿을 수 없는 변경(만든 사람 `null`)으로 생긴 자리는 모름이다', () => {
    expect(advance(ledgerWith([1, 0, 10, U]), [site(1, 0, 'kim')], null).makers.get('1:0|kim')).toBeNull();
  });
});

describe('advance — 있던 자리와 사라진 자리', () => {
  it('**있던 자리는 그대로다** — 남이 다른 곳을 고쳐도, 서식을 걸었다 풀어도', () => {
    const before = advance(ledgerWith([1, 0, 10, U]), [site(1, 0, 'kim')], U);
    const l = advance(before, [site(1, 0, 'kim')], X);
    expect(l.makers.get('1:0|kim')).toBe(U);
  });

  it('사라진 자리는 표에서 빠진다', () => {
    const before = advance(ledgerWith([1, 0, 10, U]), [site(1, 0, 'kim')], U);
    expect(advance(before, [], X).makers.size).toBe(0);
  });

  it('**치는 동안의 중간 이름은 "사라짐"으로 치지 않는다** — `@kim`이 `@kiml`로 자라는 것은 옮긴 것이 아니다', () => {
    let l = ledgerWith([1, 0, 10, U]);
    l = advance(l, [site(1, 0, 'kim')], U);
    l = advance(l, [site(1, 0, 'kiml')], U);
    expect(l.gone.has('kim')).toBe(false);
    // 그 뒤 X가 다른 곳에서 `@kim`을 불러도 X의 것이다
    recordDelivered(l.delivered, 2, { from: 0, to: 10 }, X);
    l = advance(l, [site(1, 0, 'kiml'), site(2, 0, 'kim')], X);
    expect(l.makers.get('2:0|kim')).toBe(X);
  });

  describe('**옮김** — 사라진 이름이 다음 저장 전에 다시 생기면 (P8 세 번째 코드 리뷰 1)', () => {
    it('**남의 멘션을 잘라 붙이면 모름** — 두 변경에 걸쳐도 (잘라내기 → 붙여 넣기)', () => {
      let l = ledgerWith([1, 0, 10, U], [2, 0, 10, X]);
      l = advance(l, [site(1, 0, 'kim')], U); // U가 부른다
      l = advance(l, [], X); // X가 잘라낸다
      l = advance(l, [site(2, 0, 'kim')], X); // X가 붙여 넣는다 — 글자는 X가 들여왔다
      expect(l.makers.get('2:0|kim')).toBeNull();
    });

    it('한 변경 안에서 옮겨도 모름 — 편집기는 문단을 제목으로 바꿀 때 글자를 새로 만든다', () => {
      let l = ledgerWith([1, 0, 10, U], [2, 0, 10, X]);
      l = advance(l, [site(1, 0, 'kim')], U);
      l = advance(l, [site(2, 0, 'kim')], X);
      expect(l.makers.get('2:0|kim')).toBeNull();
    });

    it('자기 멘션을 자기가 옮겼으면 그대로 자기 것', () => {
      let l = ledgerWith([1, 0, 20, U]);
      l = advance(l, [site(1, 0, 'kim')], U);
      l = advance(l, [], U);
      l = advance(l, [site(1, 10, 'kim')], U);
      expect(l.makers.get('1:10|kim')).toBe(U);
    });

    it('**저장이 끝나면 잊는다** — 저장된 멘션은 직전 버전에 있어 다시 알림이 되지 않는다', () => {
      let l = ledgerWith([1, 0, 10, U], [2, 0, 10, X]);
      l = advance(l, [site(1, 0, 'kim')], U);
      l = settle(advance(l, [], X));
      l = advance(l, [site(2, 0, 'kim')], X);
      expect(l.makers.get('2:0|kim')).toBe(X);
    });

    it('다른 이름이 사라진 것은 상관없다', () => {
      let l = ledgerWith([1, 0, 10, U], [2, 0, 10, X]);
      l = advance(l, [site(1, 0, 'lee')], U);
      l = advance(l, [site(2, 0, 'kim')], X);
      expect(l.makers.get('2:0|kim')).toBe(X);
    });
  });

  it('앞의 장부를 바꾸지 않는다 (들여온 기록은 함께 쓴다)', () => {
    const before = advance(ledgerWith([1, 0, 10, U]), [site(1, 0, 'kim')], U);
    advance(before, [], X);
    expect(before.makers.get('1:0|kim')).toBe(U);
    expect(before.gone.size).toBe(0);
  });
});

describe('recordDelivered / deliveredBy — 어느 연결이 들여왔나', () => {
  it('구간 안의 글자는 그 사람이고, 밖은 모름이다', () => {
    const l = ledgerWith([7, 0, 5, U], [7, 5, 9, X]);
    expect(deliveredBy(l.delivered, 7, 0)).toBe(U);
    expect(deliveredBy(l.delivered, 7, 4)).toBe(U);
    expect(deliveredBy(l.delivered, 7, 5)).toBe(X);
    expect(deliveredBy(l.delivered, 7, 9)).toBeNull();
    expect(deliveredBy(l.delivered, 8, 0)).toBeNull();
  });

  it('**같은 사람이 이어 들여온 구간은 합친다** — 한 글자씩 쳐도 장부가 글자 수만큼 자라지 않는다', () => {
    const l = emptyLedger();
    for (let i = 0; i < 50; i++) recordDelivered(l.delivered, 7, { from: i, to: i + 1 }, U);
    expect(l.delivered.get(7)).toEqual([[0, 50, U]]);
  });
});

describe('claimOwn — 연결 자신의 클라이언트', () => {
  const r = (...xs: [number, number, number][]) => new Map(xs.map(([c, from, to]) => [c, { from, to }]));

  it('**한 클라이언트만, 시계 0부터** 새로 들어왔으면 그 연결이 만든 클라이언트다', () => {
    const own = new Set<number>();
    claimOwn(own, r([7, 0, 3]));
    expect(own.has(7)).toBe(true);
  });

  it('0부터가 아니면 아니다 — 남의 클라이언트를 이어 보낸 것이다', () => {
    const own = new Set<number>();
    claimOwn(own, r([7, 3, 5]));
    expect(own.size).toBe(0);
  });

  it('**여러 클라이언트가 한꺼번에** 들어왔으면 아무것도 아니다 — 옛 문서를 통째로 다시 보낸 것이다 (P8 세 번째 코드 리뷰 3)', () => {
    const own = new Set<number>();
    claimOwn(own, r([7, 0, 3], [8, 0, 2]));
    expect(own.size).toBe(0);
  });
});

describe('isFaithful — 그 변경이 **보낸 것만큼만** 문서를 바꿨나', () => {
  const sent = (structs: [number, number, number][], deletes: [number, number, number][] = []) => ({
    structs: new Map(structs.map(([c, from, to]) => [c, { from, to }])),
    deletes: new Map<number, [number, number][]>(
      deletes.reduce<[number, [number, number][]][]>((acc, [c, clock, len]) => {
        const hit = acc.find(([k]) => k === c);
        if (hit) hit[1].push([clock, len]);
        else acc.push([c, [[clock, len]]]);
        return acc;
      }, []),
    ),
  });
  const got = (...xs: [number, number, number][]) => new Map(xs.map(([c, from, to]) => [c, { from, to }]));
  const del = (client: number, clock: number, len: number, parent: string | null = null): DeletedItem => ({ client, clock, len, parent });

  it('보낸 것이 그대로 들어갔으면 믿는다', () => {
    expect(isFaithful(sent([[7, 5, 10]], [[7, 0, 2]]), got([7, 5, 10]), [del(7, 0, 2)])).toBe(true);
  });

  it('아무것도 안 바뀌었으면 믿는다', () => {
    expect(isFaithful(sent([[7, 0, 10]]), new Map(), [])).toBe(true);
  });

  it('**보낸 구간보다 더 들어오면 믿지 않는다** — 남이 미리 보내 둔 위조 조각이 묻어 들어온 것이다', () => {
    expect(isFaithful(sent([[7, 5, 10]]), got([7, 5, 17]), [])).toBe(false);
  });

  it('보내지 않은 클라이언트의 조각이 들어와도 믿지 않는다', () => {
    expect(isFaithful(sent([[7, 5, 10]]), got([7, 5, 10], [8, 0, 3]), [])).toBe(false);
  });

  it('**보내지 않은 삭제가 일어나면 믿지 않는다** — 남이 미리 보내 둔 미래 시계의 삭제 집합이다', () => {
    expect(isFaithful(sent([[7, 5, 25]]), got([7, 5, 25]), [del(7, 8, 1, '7:6')])).toBe(false);
  });

  it('보낸 삭제 구간 안이면 믿는다 — 붙어 있는 구간은 합쳐 본다', () => {
    expect(isFaithful(sent([], [[7, 0, 2], [7, 2, 3]]), new Map(), [del(7, 0, 5)])).toBe(true);
    expect(isFaithful(sent([], [[7, 0, 2], [7, 3, 3]]), new Map(), [del(7, 0, 5)])).toBe(false);
  });

  describe('**동시 편집에서 Yjs가 스스로 지우는 것은 설명된다** (P8 세 번째 코드 리뷰 4)', () => {
    it('**지운 문단에 딸려 지워진 남의 글자** — 부모가 이 변경에서 지워졌고 그 부모의 삭제는 보낸 것이다', () => {
      // U가 문단(9:0)과 그 글자 덩어리(9:1)를 지웠다. X가 방금 친 글자(5:0..4)는 U가 몰랐다
      const d = [del(9, 0, 1), del(9, 1, 1, '9:0'), del(9, 2, 2, '9:1'), del(5, 0, 4, '9:1')];
      expect(isFaithful(sent([], [[9, 0, 4]]), new Map(), d)).toBe(true);
    });

    it('**방금 들어와 곧바로 진 조각** — 같은 속성을 둘이 동시에 바꿨다', () => {
      expect(isFaithful(sent([[3, 0, 1]], [[1, 1, 1]]), got([3, 0, 1]), [del(3, 0, 1, '1:0')])).toBe(true);
    });

    it('부모가 지워졌어도 **그 부모의 삭제를 설명할 수 없으면** 믿지 않는다', () => {
      expect(isFaithful(sent([], []), new Map(), [del(9, 0, 1), del(5, 0, 4, '9:0')])).toBe(false);
    });
  });
});

describe('makersFor — 이름마다, 나온 곳마다', () => {
  it('문서 순서대로 낸다. 표에 없는 자리는 모름이다', () => {
    let l = ledgerWith([1, 0, 10, U], [3, 0, 10, X]);
    l = advance(l, [site(1, 0, 'kim'), site(3, 0, 'kim')], U);
    l = { ...l, makers: new Map([['1:0|kim', U], ['3:0|kim', X]]) };
    expect(makersFor(l.makers, [site(1, 0, 'kim'), site(2, 0, 'kim'), site(3, 0, 'kim'), site(4, 0, 'lee')])).toEqual(
      new Map([
        ['kim', [U, null, X]],
        ['lee', [null]],
      ]),
    );
  });
});

describe('직렬화 — `page_realtime.authors`', () => {
  it('왕복한다', () => {
    let l = ledgerWith([7, 0, 12, U], [8, 0, 3, null]);
    l = advance(l, [site(7, 0, 'kim'), site(7, 6, 'a.b-c_d')], U);
    l = advance(l, [site(7, 6, 'a.b-c_d')], U); // kim이 사라져 기억에 남는다
    const back = ledgerFromJson(ledgerToJson(l));
    expect(back.makers).toEqual(l.makers);
    expect(back.delivered).toEqual(l.delivered);
    expect(back.gone).toEqual(l.gone);
  });

  it('JSON 모양은 `{makers, delivered, gone}`이다', () => {
    const l = advance(ledgerWith([7, 3, 7, U]), [site(7, 3, 'kim')], U);
    expect(ledgerToJson(l)).toEqual({ makers: [[7, 3, 'kim', U]], delivered: [[7, 3, 7, U]], gone: [] });
  });

  it('**모양이 맞지 않는 항목은 버린다** — 버린 자리·구간은 "모름"이 된다', () => {
    const got = ledgerFromJson({
      makers: [
        [7, 0, 'kim', U],
        [8, 0, 'lee', null],
        [-1, 0, 'kim', U],
        [1.5, 0, 'kim', U],
        [4294967296, 0, 'kim', U],
        [9, -1, 'kim', U],
        [9, 0, 'Kim', U],
        [9, 0, 'k', U],
        [9, 0, 'kim', 'not-a-uuid'],
        [9, 0, 'kim'],
        'x',
      ],
      delivered: [[7, 0, 3, U], [7, 3, 1, U], [7, -1, 3, U], [7, 0, 3, 'x'], 'x'],
      gone: [['kim', [U, null]], ['Kim', [U]], ['lee', ['x']], 'x'],
    });
    expect(got.makers).toEqual(new Map<string, string | null>([['7:0|kim', U], ['8:0|lee', null]]));
    expect(got.delivered).toEqual(new Map([[7, [[0, 3, U]]]]));
    expect(got.gone).toEqual(new Map([['kim', [U, null]]]));
  });

  it('객체가 아니거나 다른 모양이면 빈 장부다', () => {
    for (const raw of [null, [U], 'x', undefined, {}, { makers: 'x' }, { clients: {}, struck: {} }]) {
      const l = ledgerFromJson(raw);
      expect([l.makers.size, l.delivered.size, l.gone.size]).toEqual([0, 0, 0]);
    }
  });
});
