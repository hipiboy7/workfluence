import { describe, expect, it } from 'vitest';
import {
  attributionFromJson,
  attributionToJson,
  claimAuthors,
  freezeUnknown,
  isStruck,
  recordStruck,
  type AuthorMap,
  type ClockRange,
  type StruckMap,
} from './authorship';

/**
 * A등급 — 클라이언트 ID → 사용자 대응표와 "남이 지운 흔적" (P8_설계서_Mention C.2절, FR-903·904).
 *
 * 이 표가 틀리면 **남의 이름으로 부른 알림**이 나간다. 그래서 축은 "언제 적지 않는가"다.
 */

const A = '00000000-0000-4000-8000-00000000000a';
const B = '00000000-0000-4000-8000-00000000000b';
const r = (from: number, to: number): ClockRange => ({ from, to });
const ranges = (...xs: [number, number, number][]): Map<number, ClockRange> => new Map(xs.map(([c, f, t]) => [c, r(f, t)]));

describe('claimAuthors — 한 ID만 새로 들어왔을 때', () => {
  it('처음 보는 ID는 그 사용자로 적는다', () => {
    const m: AuthorMap = new Map();
    expect(claimAuthors(m, A, ranges([7, 0, 5]), ranges([7, 0, 5]))).toEqual([]);
    expect(m.get(7)).toBe(A);
  });

  it('같은 사용자가 이어서 보내면 그대로다', () => {
    const m: AuthorMap = new Map([[7, A]]);
    expect(claimAuthors(m, A, ranges([7, 5, 6]), ranges([7, 5, 6]))).toEqual([]);
    expect(m.get(7)).toBe(A);
  });

  it('**다른 사용자가 같은 ID를 주장하면 `null`로 굳고, 굳힌 ID를 돌려준다** (FR-904)', () => {
    const m: AuthorMap = new Map([[7, A]]);
    expect(claimAuthors(m, B, ranges([7, 5, 6]), ranges([7, 5, 6]))).toEqual([7]);
    expect(m.has(7)).toBe(true);
    expect(m.get(7)).toBeNull();
  });

  it('**한번 굳은 ID는 되살리지 않는다** — 원래 주인이 다시 보내도 `null`이고, 새로 굳힌 것은 아니다', () => {
    const m: AuthorMap = new Map([[7, null]]);
    expect(claimAuthors(m, A, ranges([7, 5, 6]), ranges([7, 5, 6]))).toEqual([]);
    expect(m.get(7)).toBeNull();
  });

  it('**보냈지만 새로 들어가지 않은 ID는 적지 않는다** — 접속 직후의 "내 문서 전체"에는 남의 조각이 다 들어 있다', () => {
    const m: AuthorMap = new Map();
    expect(claimAuthors(m, A, ranges([7, 0, 5], [8, 0, 3], [9, 0, 2]), ranges([9, 0, 2]))).toEqual([]);
    expect([...m.entries()]).toEqual([[9, A]]);
  });

  it('아무것도 새로 들어가지 않았으면 표가 그대로다', () => {
    const m: AuthorMap = new Map([[1, A]]);
    expect(claimAuthors(m, B, ranges([1, 0, 4], [2, 0, 1]), new Map())).toEqual([]);
    expect([...m.entries()]).toEqual([[1, A]]);
  });
});

describe('claimAuthors — **보낸 것보다 더 들어왔을 때** (P8 자체 점검 1)', () => {
  it('**보내지 않은 ID가 들어오면 굳힌다** — Yjs가 보류해 둔 남의 조각이다', () => {
    const m: AuthorMap = new Map();
    expect(claimAuthors(m, A, ranges([9, 0, 2]), ranges([8, 0, 3], [9, 0, 2]))).toEqual([8]);
    expect(m.get(8)).toBeNull();
    expect(m.get(9)).toBe(A);
  });

  it('**보낸 시계 범위를 넘어 들어오면 굳힌다** — 남이 미리 보내 둔 위조 조각이 내 변경에 묻어 들어온 것이다', () => {
    // A가 5..10을 보냈는데 5..17이 들어왔다. 10..17은 B가 A의 ID로 미리 보내 둔 것이다
    const m: AuthorMap = new Map([[7, A]]);
    expect(claimAuthors(m, A, ranges([7, 5, 10]), ranges([7, 5, 17]))).toEqual([7]);
    expect(m.get(7)).toBeNull();
  });

  it('보낸 범위 안이면 앞쪽이 이미 있던 것이어도 괜찮다 — 겹쳐 보내는 것은 정상이다', () => {
    const m: AuthorMap = new Map([[7, A]]);
    expect(claimAuthors(m, A, ranges([7, 0, 10]), ranges([7, 5, 10]))).toEqual([]);
    expect(m.get(7)).toBe(A);
  });
});

describe('claimAuthors — **여러 ID가 한꺼번에 새로 들어왔을 때** (P8 자체 점검 2)', () => {
  it('**자기 것이 아닌 ID는 굳힌다** — 옛 문서를 쥔 채 새 방에 다시 보내면 남의 조각까지 새로 들어온다', () => {
    const m: AuthorMap = new Map([[1, A]]);
    // A가 옛 상태를 통째로 보냈다. 1은 A의 것이라 두고, 2(모름)와 3(B의 것)은 굳힌다
    m.set(3, B);
    expect(claimAuthors(m, A, ranges([1, 0, 9], [2, 0, 4], [3, 0, 2]), ranges([1, 5, 9], [2, 0, 4], [3, 0, 2])).sort()).toEqual([2, 3]);
    expect(m.get(1)).toBe(A);
    expect(m.get(2)).toBeNull();
    expect(m.get(3)).toBeNull();
  });

  it('여럿이 다 처음 보는 것이어도 **아무도 차지하지 못한다**', () => {
    const m: AuthorMap = new Map();
    expect(claimAuthors(m, A, ranges([1, 0, 1], [2, 0, 1]), ranges([1, 0, 1], [2, 0, 1])).sort()).toEqual([1, 2]);
    expect([...m.values()]).toEqual([null, null]);
  });
});

describe('freezeUnknown — 방을 만들 때 이미 있는 ID', () => {
  it('표에 없는 ID는 `null`로 굳힌다 — 나중에 누가 먼저 차지하지 못하게', () => {
    const m: AuthorMap = new Map([[1, A]]);
    freezeUnknown(m, [1, 2, 3]);
    expect(m.get(1)).toBe(A);
    expect(m.get(2)).toBeNull();
    expect(m.get(3)).toBeNull();
    claimAuthors(m, B, ranges([2, 5, 6]), ranges([2, 5, 6]));
    expect(m.get(2)).toBeNull();
  });
});

describe('recordStruck / isStruck — 남이 지운 흔적 (P8 코드 리뷰 1)', () => {
  it('**남이 지운 것만 적는다** — 자기 글자를 자기가 지운 것(오타 고치기)은 적지 않는다', () => {
    const authors: AuthorMap = new Map([[7, A]]);
    const s: StruckMap = new Map();
    recordStruck(s, authors, A, [[7, 3, 1]]); // A가 자기 오타를 지웠다
    recordStruck(s, authors, B, [[7, 10, 4]]); // B가 A의 글자를 지웠다
    expect(isStruck(s, 7, 3, 1)).toBe(false);
    expect(isStruck(s, 7, 10, 4)).toBe(true);
  });

  it('**누가 지웠는지 모르거나, 지운 글자의 주인을 모르면 남이 지운 것으로 친다**', () => {
    const authors: AuthorMap = new Map([[7, A], [8, null]]);
    const s: StruckMap = new Map();
    recordStruck(s, authors, null, [[7, 0, 1]]);
    recordStruck(s, authors, A, [[8, 0, 1]]); // 굳은 ID의 글자
    recordStruck(s, authors, A, [[9, 0, 1]]); // 표에 없는 ID의 글자
    expect(isStruck(s, 7, 0, 1)).toBe(true);
    expect(isStruck(s, 8, 0, 1)).toBe(true);
    expect(isStruck(s, 9, 0, 1)).toBe(true);
  });

  it('구간이 **조금이라도 겹치면** 지운 흔적이다 — Yjs는 지운 조각을 합친다', () => {
    const s: StruckMap = new Map();
    recordStruck(s, new Map(), B, [[7, 10, 4]]);
    expect(isStruck(s, 7, 8, 3)).toBe(true); // 8..11
    expect(isStruck(s, 7, 13, 5)).toBe(true); // 13..18
    expect(isStruck(s, 7, 6, 4)).toBe(false); // 6..10 — 10은 포함하지 않는다
    expect(isStruck(s, 7, 14, 1)).toBe(false);
    expect(isStruck(s, 8, 10, 4)).toBe(false);
  });

  it('붙은 구간은 하나로 합친다 — 표가 지운 글자 수만큼 자라지 않게', () => {
    const s: StruckMap = new Map();
    for (let c = 0; c < 5; c++) recordStruck(s, new Map(), B, [[7, c, 1]]);
    recordStruck(s, new Map(), B, [[7, 20, 2]]);
    recordStruck(s, new Map(), B, [[7, 3, 4]]); // 앞 구간과 겹친다
    expect(s.get(7)).toEqual([
      [0, 7],
      [20, 2],
    ]);
  });
});

describe('직렬화 — `page_realtime.authors`', () => {
  it('왕복한다', () => {
    const a = {
      authors: new Map<number, string | null>([
        [7, A],
        [4294967295, null],
      ]),
      struck: new Map<number, [number, number][]>([[7, [[0, 3], [9, 1]]]]),
    };
    expect(attributionFromJson(attributionToJson(a))).toEqual(a);
  });

  it('JSON 모양은 `{clients: {"<id>": userId | null}, struck: {"<id>": [[clock, len]…]}}`이다', () => {
    expect(attributionToJson({ authors: new Map([[7, A], [8, null]]), struck: new Map([[7, [[1, 2]]]]) })).toEqual({
      clients: { '7': A, '8': null },
      struck: { '7': [[1, 2]] },
    });
  });

  it('**모양이 맞지 않는 사용자 항목은 버린다** — 버린 ID는 방을 만들 때 "모름"으로 굳는다', () => {
    const got = attributionFromJson({
      clients: {
        '7': A,
        '8': null,
        '-1': A,
        '1.5': A,
        '4294967296': A,
        abc: A,
        '9': 42,
        '10': 'not-a-uuid',
      },
      struck: {},
    });
    expect(got.authors).toEqual(new Map([[7, A], [8, null]]));
  });

  it('**지운 흔적이 하나라도 깨져 있으면 표 전체를 버린다** — 남이 지운 흔적을 잊으면 사칭이 통한다', () => {
    for (const struck of [{ '7': [[1]] }, { '7': [[-1, 2]] }, { x: [[1, 2]] }, { '7': 'x' }, { '7': [[1, 0]] }, []]) {
      const got = attributionFromJson({ clients: { '7': A }, struck });
      expect(got.authors.size).toBe(0);
      expect(got.struck.size).toBe(0);
    }
  });

  it('객체가 아니거나 옛 모양이면 빈 표다', () => {
    for (const raw of [null, [A], 'x', undefined, { '7': A }]) {
      const got = attributionFromJson(raw);
      expect(got.authors.size).toBe(0);
      expect(got.struck.size).toBe(0);
    }
  });
});
