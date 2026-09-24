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

  describe('**한 번에 생긴 것만 옮김일 수 있다** — 붙여 넣기·되돌리기·재구성은 멘션을 통째로 만든다 (네 번째 검토 2)', () => {
    const made = (c: number, from: number, to: number) => new Map([[c, { from, to }]]);

    it('**한 글자씩 쳐서 만든 멘션은 옮김이 아니다** — 정본의 `@kim`을 지우고 저장한 뒤 같은 사람이 다시 쳐서 부른다', () => {
      let l = ledgerWith([2, 0, 10, U]);
      l = advance(l, [site(1, 0, 'kim')], null); // 정본의 멘션 — 만든 사람을 모른다
      l = advance(l, [], U); // U가 지웠다 → kim: 모름
      // U가 `@kim`을 한 글자씩 친다 — 마지막 글자 `m`만 이 변경에서 들어왔다
      l = advance(l, [site(2, 0, 'kim')], U, made(2, 3, 4));
      expect(l.makers.get('2:0|kim')).toBe(U);
    });

    it('**통째로 붙여 넣은 멘션은 옮김일 수 있다** — 같은 상황에서 붙여 넣으면 모름', () => {
      let l = ledgerWith([2, 0, 10, U]);
      l = advance(l, [site(1, 0, 'kim')], null);
      l = advance(l, [], U);
      l = advance(l, [site(2, 0, 'kim')], U, made(2, 0, 4));
      expect(l.makers.get('2:0|kim')).toBeNull();
    });
  });

  describe('**옮김** — 사라진 이름이 다시 생기면 (P8 세 번째 코드 리뷰 1)', () => {
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

    it('**저장된 버전에 그 이름이 있으면 잊는다** — 다시 생겨도 새 멘션이 아니라 알림이 되지 않는다', () => {
      let l = ledgerWith([1, 0, 10, U], [2, 0, 10, X]);
      l = advance(l, [site(1, 0, 'kim')], U);
      l = advance(l, [], X);
      l = settle(l, new Set(['kim']), l.seq);
      l = advance(l, [site(2, 0, 'kim')], X);
      expect(l.makers.get('2:0|kim')).toBe(X);
    });

    it('**저장된 버전에 그 이름이 없으면 잊지 않는다** — 잘라낸 뒤 저장이 끼고 그 뒤에 붙여 넣어도 모름', () => {
      let l = ledgerWith([1, 0, 10, U], [2, 0, 10, X]);
      l = advance(l, [site(1, 0, 'kim')], U);
      l = advance(l, [], X);
      l = settle(l, new Set(['lee']), l.seq); // 잘라낸 상태로 저장됐다
      l = advance(l, [site(2, 0, 'kim')], X);
      expect(l.makers.get('2:0|kim')).toBeNull();
    });

    it('**저장하는 사이에 생긴 기억은 그 저장이 지우지 않는다** — 저장을 시작할 때 뜬 것만 잊는다 (네 번째 코드 리뷰 1)', () => {
      let l = ledgerWith([1, 0, 10, U], [2, 0, 10, X]);
      l = advance(l, [site(1, 0, 'kim')], U);
      const atStart = l.seq; // 저장 시작 — 버전에는 kim이 있다
      l = advance(l, [], X); // 저장이 DB를 기다리는 사이 X가 잘라냈다
      l = settle(l, new Set(['kim']), atStart);
      expect([...l.gone.get('kim')!.keys()]).toEqual([U]);
      l = advance(l, [site(2, 0, 'kim')], X); // (다음 저장에 kim이 없은 뒤) 붙여 넣는다
      expect(l.makers.get('2:0|kim')).toBeNull();
    });

    it('**남이 내 멘션을 자라게 한 것은 옮김의 시작일 수 있다** — `@bob` → `@bobx`는 기억한다 (네 번째 코드 리뷰 2)', () => {
      let l = ledgerWith([1, 0, 10, U], [2, 0, 10, X]);
      l = advance(l, [site(1, 0, 'bob')], U);
      l = advance(l, [site(1, 0, 'bobx')], X); // X가 x를 붙였다
      expect([...l.gone.get('bob')!.keys()]).toEqual([U]);
      // X가 그것을 잘라 붙이고 x를 지워 `@bob`을 되살린다 — 글자는 X의 것이지만 옮긴 것이다
      l = advance(l, [site(2, 0, 'bob')], X);
      expect(l.makers.get('2:0|bob')).toBeNull();
    });

    it('**같은 사람이 여러 번 사라지게 해도 한 번만 적는다** — 기억이 오타 수만큼 자라지 않는다 (네 번째 코드 리뷰 3)', () => {
      let l = ledgerWith([1, 0, 50, U]);
      for (let i = 0; i < 5; i++) {
        l = advance(l, [site(1, i * 5, 'bob')], U);
        l = advance(l, [], U);
      }
      expect([...l.gone.get('bob')!.keys()]).toEqual([U]);
    });

    it('**같은 사람이 저장하는 사이에 다시 사라지게 해도 잊지 않는다** — 순번으로 가린다', () => {
      let l = ledgerWith([1, 0, 50, U], [2, 0, 10, X]);
      l = advance(l, [site(1, 0, 'bob'), site(1, 10, 'bob')], U);
      l = advance(l, [site(1, 10, 'bob')], U); // U가 앞의 @bob을 지웠다 — bob:U를 기억한다
      const atStart = l.seq; // 저장 시작 (버전에는 뒤의 @bob이 있다)
      l = advance(l, [], X); // 그 사이 X가 뒤의 @bob을 잘라냈다 — 또 bob:U
      l = settle(l, new Set(['bob']), atStart);
      expect(l.gone.has('bob')).toBe(true);
      l = advance(l, [site(2, 0, 'bob')], X);
      expect(l.makers.get('2:0|bob')).toBeNull();
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
  const sent = (...xs: [number, number, number][]) => ({ structs: r(...xs), deletes: new Map<number, [number, number][]>() });

  it('**보낸 것 중 시계 0부터인 클라이언트가 하나뿐이고 그것이 새로 들어왔으면** 그 연결이 만든 것이다 — 누가 만들었는지도 적는다', () => {
    const own = new Set<number>();
    const owners = new Map<number, string>();
    claimOwn(own, owners, U, sent([7, 0, 3]), r([7, 0, 3]));
    expect(own.has(7)).toBe(true);
    expect(owners.get(7)).toBe(U);
  });

  it('0부터가 아니면 아니다 — 남의 클라이언트를 이어 보낸 것이다', () => {
    const own = new Set<number>();
    claimOwn(own, new Map(), U, sent([7, 3, 5]), r([7, 3, 5]));
    expect(own.size).toBe(0);
  });

  it('**보내지 않은 클라이언트는 0부터 들어와도 아니다** — 남이 미리 보내 둔 조각이 묻어 들어온 것이다', () => {
    const own = new Set<number>();
    claimOwn(own, new Map(), U, sent([7, 0, 3]), r([7, 0, 3], [8, 0, 2]));
    expect([...own]).toEqual([7]);
  });

  it('**보낸 것 중 0부터인 것이 여럿이면** 아무것도 아니다 — 옛 문서를 통째로 다시 보낸 것이다 (P8 세 번째 코드 리뷰 3)', () => {
    const own = new Set<number>();
    claimOwn(own, new Map(), U, sent([7, 0, 3], [8, 0, 2]), r([7, 0, 3], [8, 0, 2]));
    expect(own.size).toBe(0);
  });

  it('**믿을 수 없는 변경이어도 자기 클라이언트는 알아본다** — 첫 변경에 위조가 묻었다고 그 연결이 끝까지 모름이 되면 안 된다 (네 번째 검토 1)', () => {
    // U가 보낸 것은 7:0..2인데 남이 미리 보내 둔 7:2..4가 함께 들어왔다 — 클라이언트는 여전히 U가 만든 것이다
    const own = new Set<number>();
    claimOwn(own, new Map(), U, sent([7, 0, 2]), r([7, 0, 4]));
    expect(own.has(7)).toBe(true);
  });

  it('**남이 만든 클라이언트는 차지하지 못한다**', () => {
    const own = new Set<number>();
    claimOwn(own, new Map([[7, X]]), U, sent([7, 0, 3]), r([7, 0, 3]));
    expect(own.size).toBe(0);
  });

  it('**같은 사람이 다시 붙으면 이어받는다** — 같은 Y.Doc으로 재접속하면 시계가 0이 아니다 (네 번째 검토 5)', () => {
    const own = new Set<number>();
    claimOwn(own, new Map([[7, U]]), U, sent([7, 9, 12]), r([7, 9, 12]));
    expect(own.has(7)).toBe(true);
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

    it('**들어오자마자 지워진 글자는 설명이 아니다** — 보류 삭제 위조가 바로 그 모양이다 (속성 충돌은 부르는 쪽이 거른다)', () => {
      expect(isFaithful(sent([[3, 0, 5]]), got([3, 0, 5]), [del(3, 2, 1, '1:0')])).toBe(false);
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
    expect(back.seq).toBe(l.seq);
    l.owners.set(7, U);
    expect(ledgerFromJson(ledgerToJson(l)).owners).toEqual(new Map([[7, U]]));
  });

  it('JSON 모양은 `{makers, delivered, gone, seq, owners}`이다', () => {
    let l = advance(ledgerWith([7, 3, 7, U]), [site(7, 3, 'kim')], U);
    l = advance(l, [], U);
    l.owners.set(7, U);
    expect(ledgerToJson(l)).toEqual({ makers: [], delivered: [[7, 3, 7, U]], gone: [['kim', [[U, 2]]]], seq: 2, owners: [[7, U]] });
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
      gone: [['kim', [[U, 3], [null, 4]]], ['Kim', [[U, 1]]], ['lee', [['x', 1]]], ['park', [[U, -1]]], 'x'],
      seq: 2,
      owners: [[7, U], [8, null], [-1, U], [9, 'x'], 'x'],
    });
    expect(got.makers).toEqual(new Map<string, string | null>([['7:0|kim', U], ['8:0|lee', null]]));
    expect(got.delivered).toEqual(new Map([[7, [[0, 3, U]]]]));
    expect(got.gone).toEqual(new Map([['kim', new Map<string | null, number>([[U, 3], [null, 4]])]]));
    // 순번은 적힌 기록보다 작아지지 않는다 — 작아지면 그 뒤의 기록이 저장 한 번에 잊힌다
    expect(got.seq).toBe(4);
    expect(got.owners).toEqual(new Map([[7, U]]));
  });

  it('객체가 아니거나 다른 모양이면 빈 장부다', () => {
    for (const raw of [null, [U], 'x', undefined, {}, { makers: 'x' }, { clients: {}, struck: {} }]) {
      const l = ledgerFromJson(raw);
      expect([l.makers.size, l.delivered.size, l.gone.size, l.seq, l.owners.size]).toEqual([0, 0, 0, 0, 0]);
    }
  });
});
