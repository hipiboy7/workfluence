import { describe, expect, it } from 'vitest';
import { authorsFromJson, authorsToJson, claimAuthors, freezeUnknown, type AuthorMap } from './authorship';

/**
 * A등급 — 클라이언트 ID → 사용자 대응표 (P8_설계서_Mention C.2절, FR-903·904).
 *
 * 이 표가 틀리면 **남의 이름으로 부른 알림**이 나간다. 그래서 축은 "언제 적지 않는가"다.
 */

const A = '00000000-0000-4000-8000-00000000000a';
const B = '00000000-0000-4000-8000-00000000000b';

describe('claimAuthors — 적을 때', () => {
  it('처음 보는 ID는 그 사용자로 적는다', () => {
    const m: AuthorMap = new Map();
    claimAuthors(m, A, [7], [7]);
    expect(m.get(7)).toBe(A);
  });

  it('같은 사용자가 다시 보내면 그대로다', () => {
    const m: AuthorMap = new Map([[7, A]]);
    claimAuthors(m, A, [7], [7]);
    expect(m.get(7)).toBe(A);
  });

  it('**다른 사용자가 같은 ID를 주장하면 `null`로 굳는다** — 누가 진짜인지 모른다 (FR-904)', () => {
    const m: AuthorMap = new Map([[7, A]]);
    claimAuthors(m, B, [7], [7]);
    expect(m.has(7)).toBe(true);
    expect(m.get(7)).toBeNull();
  });

  it('**한번 굳은 ID는 되살리지 않는다** — 원래 주인이 다시 보내도 `null`이다', () => {
    const m: AuthorMap = new Map([[7, null]]);
    claimAuthors(m, A, [7], [7]);
    expect(m.get(7)).toBeNull();
  });

  it('**보냈지만 새로 들어가지 않은 ID는 적지 않는다** — 접속 직후의 "내 문서 전체"에는 남의 조각이 다 들어 있다', () => {
    const m: AuthorMap = new Map();
    claimAuthors(m, A, [7, 8, 9], [9]);
    expect([...m.entries()]).toEqual([[9, A]]);
  });

  it('**새로 들어갔지만 이 연결이 보내지 않은 ID도 적지 않는다** — Yjs가 보류해 둔 남의 조각이다', () => {
    const m: AuthorMap = new Map();
    claimAuthors(m, A, [9], [8, 9]);
    expect(m.has(8)).toBe(false);
    expect(m.get(9)).toBe(A);
  });

  it('아무것도 새로 들어가지 않았으면 표가 그대로다', () => {
    const m: AuthorMap = new Map([[1, A]]);
    claimAuthors(m, B, [1, 2], []);
    expect([...m.entries()]).toEqual([[1, A]]);
  });
});

describe('freezeUnknown — 방을 만들 때 이미 있는 ID', () => {
  it('표에 없는 ID는 `null`로 굳힌다 — 나중에 누가 먼저 차지하지 못하게', () => {
    const m: AuthorMap = new Map([[1, A]]);
    freezeUnknown(m, [1, 2, 3]);
    expect(m.get(1)).toBe(A);
    expect(m.get(2)).toBeNull();
    expect(m.get(3)).toBeNull();
    // 굳힌 뒤에는 누구도 차지하지 못한다
    claimAuthors(m, B, [2], [2]);
    expect(m.get(2)).toBeNull();
  });
});

describe('직렬화 — `page_realtime.authors`', () => {
  it('왕복한다', () => {
    const m: AuthorMap = new Map([
      [7, A],
      [4294967295, null],
    ]);
    expect(authorsFromJson(authorsToJson(m))).toEqual(m);
  });

  it('JSON 모양은 `{"<clientId>": userId | null}`이다', () => {
    expect(authorsToJson(new Map([[7, A], [8, null]]))).toEqual({ '7': A, '8': null });
  });

  it('**모양이 맞지 않는 항목은 버린다** — 파생 데이터라 버려도 그 글자가 "모름"이 될 뿐이다', () => {
    const got = authorsFromJson({
      '7': A,
      '8': null,
      '-1': A, // 음수 ID는 없다
      '1.5': A, // 정수가 아니다
      '4294967296': A, // 32비트를 넘는다
      abc: A,
      '9': 42, // 사용자 id가 문자열이 아니다
      '10': 'not-a-uuid',
    });
    expect(got).toEqual(new Map([[7, A], [8, null]]));
  });

  it('객체가 아니면 빈 표다', () => {
    expect(authorsFromJson(null).size).toBe(0);
    expect(authorsFromJson([A]).size).toBe(0);
    expect(authorsFromJson('x').size).toBe(0);
    expect(authorsFromJson(undefined).size).toBe(0);
  });
});
