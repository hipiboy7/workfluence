import { describe, expect, it } from 'vitest';
import { advanceMakers, isFaithful, makersFor, makersFromJson, makersToJson, type MakerMap, type Site } from './makers';

/**
 * A등급 — 멘션을 **생기게 한** 사람 (P8_설계서_Mention C.2절, FR-900·904·907).
 *
 * 멘션 하나는 `@` 글자의 ID와 이름으로 가린다. 멤버의 변경이 적용될 때마다 문서의 멘션 자리를 다시 훑고,
 * **그 변경으로 새로 생긴 자리**에 그 멤버를 적는다. 이름이 붙을 수 있는 사람은 **자기 연결로 그 멘션을
 * 만든 사람뿐**이다 — 글자의 클라이언트 ID나 Yjs가 적어 둔 이웃처럼 클라이언트가 정하는 값은 믿지 않는다.
 */

const U = '00000000-0000-4000-8000-00000000000a';
const X = '00000000-0000-4000-8000-00000000000b';
const site = (key: string, name: string): Site => ({ key, name });

describe('advanceMakers — 새로 생긴 자리에 그 변경을 보낸 사람을 적는다', () => {
  it('새 자리는 그 사람이다', () => {
    const m = advanceMakers(new Map(), [site('1:0', 'kim')], U);
    expect(m.get('1:0|kim')).toBe(U);
  });

  it('**있던 자리는 그대로다** — 남이 다른 곳을 고쳐도, 서식을 걸어도 바뀌지 않는다', () => {
    const before: MakerMap = new Map([['1:0|kim', U]]);
    const m = advanceMakers(before, [site('1:0', 'kim'), site('2:0', 'lee')], X);
    expect(m.get('1:0|kim')).toBe(U);
    expect(m.get('2:0|lee')).toBe(X);
  });

  it('**사라진 자리는 지운다** — 다시 생기면 그때 만든 사람이 만든 것이다', () => {
    const m = advanceMakers(new Map([['1:0|kim', U]]), [], X);
    expect(m.size).toBe(0);
  });

  it('**남이 글자를 지우거나 끼워 넣어 새 이름을 만들면 그 남이 만든 것이다** — 원래 쓴 사람이 아니다', () => {
    // U가 `@kim.lee`를 쳤다(그 사이 `@kim`·`@kim.`은 이미 사라졌다). X가 `.lee`를 지워 `@kim`이 새로 생긴다
    const typed = advanceMakers(new Map(), [site('1:0', 'kim.lee')], U);
    const m = advanceMakers(typed, [site('1:0', 'kim')], X);
    expect(m.get('1:0|kim')).toBe(X);
  });

  it('믿을 수 없는 변경(만든 사람 `null`)으로 생긴 자리는 모름이다', () => {
    expect(advanceMakers(new Map(), [site('1:0', 'kim')], null).get('1:0|kim')).toBeNull();
  });

  describe('**같은 변경에서 같은 이름이 사라지고 생기면 옮긴 것이다** — 문단을 제목으로 바꾸면 편집기가 글자를 새로 만든다', () => {
    it('자기 멘션을 자기가 옮겼으면 그대로 자기 것', () => {
      const m = advanceMakers(new Map([['1:0|kim', U]]), [site('9:0', 'kim')], U);
      expect(m.get('9:0|kim')).toBe(U);
    });

    it('**남의 멘션을 옮겼으면 모름** — 옮긴 사람이 부른 것이 아니고, 원래 사람 이름을 옮겨 붙일 수도 없다', () => {
      const m = advanceMakers(new Map([['1:0|kim', U]]), [site('9:0', 'kim')], X);
      expect(m.get('9:0|kim')).toBeNull();
    });

    it('사라진 쪽에 모름이 섞였으면 모름', () => {
      const m = advanceMakers(new Map<string, string | null>([['1:0|kim', U], ['2:0|kim', null]]), [site('9:0', 'kim')], U);
      expect(m.get('9:0|kim')).toBeNull();
    });

    it('다른 이름이 사라진 것은 상관없다', () => {
      const m = advanceMakers(new Map([['1:0|lee', U]]), [site('9:0', 'kim')], X);
      expect(m.get('9:0|kim')).toBe(X);
    });
  });

  it('앞의 표를 바꾸지 않는다', () => {
    const before: MakerMap = new Map([['1:0|kim', U]]);
    advanceMakers(before, [], X);
    expect(before.get('1:0|kim')).toBe(U);
  });
});

describe('makersFor — 이름마다, 나온 곳마다', () => {
  it('문서 순서대로 낸다. 표에 없는 자리는 모름이다', () => {
    const m: MakerMap = new Map([['1:0|kim', U], ['3:0|kim', X]]);
    expect(makersFor(m, [site('1:0', 'kim'), site('2:0', 'kim'), site('3:0', 'kim'), site('4:0', 'lee')])).toEqual(
      new Map([
        ['kim', [U, null, X]],
        ['lee', [null]],
      ]),
    );
  });
});

describe('isFaithful — 그 변경이 **보낸 것만큼만** 문서를 바꿨나 (P8 자체 점검 1 · 두 번째 검토 1)', () => {
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

  it('보낸 것이 그대로 들어갔으면 믿는다', () => {
    expect(isFaithful(sent([[7, 5, 10]], [[7, 0, 2]]), got([7, 5, 10]), [[7, 0, 2]])).toBe(true);
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

  it('**보내지 않은 삭제가 일어나면 믿지 않는다** — 남이 미리 보내 둔 미래 시계의 삭제 집합이 이 변경의 글자를 지운 것이다', () => {
    expect(isFaithful(sent([[7, 5, 25]]), got([7, 5, 25]), [[7, 8, 17]])).toBe(false);
  });

  it('보낸 삭제 구간 안이면 믿는다 — 붙어 있는 구간은 합쳐 본다', () => {
    expect(isFaithful(sent([], [[7, 0, 2], [7, 2, 3]]), new Map(), [[7, 0, 5]])).toBe(true);
    expect(isFaithful(sent([], [[7, 0, 2], [7, 3, 3]]), new Map(), [[7, 0, 5]])).toBe(false);
  });
});

describe('직렬화 — `page_realtime.authors`', () => {
  it('왕복한다', () => {
    const m: MakerMap = new Map<string, string | null>([
      ['7:0|kim', U],
      ['4294967295:12|a.b-c_d', null],
    ]);
    expect(makersFromJson(makersToJson(m))).toEqual(m);
  });

  it('JSON 모양은 `{makers: [[client, clock, name, userId | null]…]}`이다', () => {
    expect(makersToJson(new Map([['7:3|kim', U]]))).toEqual({ makers: [[7, 3, 'kim', U]] });
  });

  it('**모양이 맞지 않는 항목은 버린다** — 버린 자리는 방을 만들 때 "모름"이 된다', () => {
    const got = makersFromJson({
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
    });
    expect(got).toEqual(new Map<string, string | null>([['7:0|kim', U], ['8:0|lee', null]]));
  });

  it('객체가 아니거나 다른 모양이면 빈 표다', () => {
    for (const raw of [null, [U], 'x', undefined, {}, { makers: 'x' }, { clients: {}, struck: {} }]) expect(makersFromJson(raw).size).toBe(0);
  });
});
