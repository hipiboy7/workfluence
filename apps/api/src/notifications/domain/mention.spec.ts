import type { DocNode } from '@workfluence/shared';
import { describe, expect, it } from 'vitest';
import { extractText } from '@workfluence/shared';
import { extractMentions, mentionAuthors, scanMentions } from './mention';

/** A등급 (P4_설계서_Admin E절, FR-501). 테스트를 먼저 썼다. */

const doc = (...texts: string[]): DocNode => ({
  type: 'doc',
  content: texts.map((text) => ({ type: 'paragraph', content: [{ type: 'text', text }] })),
});

describe('extractMentions', () => {
  it('@아이디를 뽑는다', () => {
    expect(extractMentions(doc('@kim 확인 부탁'))).toEqual(['kim']);
    expect(extractMentions(doc('@a.b @c-d @e_f'))).toEqual(['a.b', 'c-d', 'e_f']);
  });

  it('여러 문단에 걸쳐도 찾는다', () => {
    expect(extractMentions(doc('첫 줄 @kim', '둘째 줄 @lee'))).toEqual(['kim', 'lee']);
  });

  it('같은 사람을 여러 번 적어도 하나다 (FR-504)', () => {
    expect(extractMentions(doc('@kim @kim 그리고 또 @kim'))).toEqual(['kim']);
  });

  it('**말 한가운데의 @는 멘션이 아니다** — email이 알림을 만들면 안 된다', () => {
    expect(extractMentions(doc('kim@example.internal로 보내라'))).toEqual([]);
    expect(extractMentions(doc('a@b'))).toEqual([]);
  });

  it('여는 괄호·따옴표 뒤의 @는 멘션이다', () => {
    expect(extractMentions(doc('(@kim) "@lee" [@park]'))).toEqual(['kim', 'lee', 'park']);
  });

  it('**뒤쪽 구분자는 자를 수도 안 자를 수도 있으므로 둘 다 후보로 낸다**', () => {
    // `.`·`-`·`_`는 아이디에도 쓰이고 문장부호로도 쓰인다. `@kim_`을 무조건 잘라
    // `kim`에게 보내면 **엉뚱한 사람이 불린다** (코드 리뷰 7). 실제 사용자와 맞추는 것은
    // 부르는 쪽의 일이고, 여기서는 자르지 않은 것을 **먼저** 둔다
    expect(extractMentions(doc('@kim_ 확인'))).toEqual(['kim_', 'kim']);
    expect(extractMentions(doc('@kim, @lee. @park?'))).toEqual(['kim', 'lee.', 'lee', 'park']);
    expect(extractMentions(doc('@kim...'))).toEqual(['kim...', 'kim']);
  });

  it('한글 **조사가 뒤에 붙어도** 아이디만 뽑는다', () => {
    expect(extractMentions(doc('담당자는 @kim님입니다'))).toEqual(['kim']);
  });

  it('**앞이 글자면 멘션이 아니다** — 메일 주소가 알림을 만들면 안 된다', () => {
    // 이 경계는 앞쪽만 막는다. 뒤쪽을 막으면 한국어 조사에서 깨진다
    expect(extractMentions(doc('담당자는@kim'))).toEqual([]);
  });

  it('아이디 규칙(소문자·숫자·._- 2~64자)을 벗어나면 뽑지 않는다', () => {
    expect(extractMentions(doc('@K'))).toEqual([]); // 한 글자
    expect(extractMentions(doc('@KIM'))).toEqual([]); // 대문자
    expect(extractMentions(doc('@한글'))).toEqual([]);
    expect(extractMentions(doc(`@${'a'.repeat(65)}`))).toEqual([]);
  });

  it('찾은 순서를 지킨다 — 화면이 그 순서로 보여 준다', () => {
    expect(extractMentions(doc('@lee @kim @ahn'))).toEqual(['lee', 'kim', 'ahn']);
  });

  it('빈 문서·멘션 없는 문서는 빈 배열', () => {
    expect(extractMentions(doc())).toEqual([]);
    expect(extractMentions(doc('아무도 부르지 않는다'))).toEqual([]);
  });
});

/**
 * P8_설계서_Mention C.3절 (FR-900·901). **테스트를 먼저 썼다.**
 *
 * `scanMentions`는 `extractMentions`가 쓰는 규칙을 **위치까지** 돌려준다. 규칙이 둘이 되면
 * 알림은 가는데 "누가 불렀나"만 비는 식으로 조용히 어긋난다 — 그래서 하나를 나눠 쓴다.
 */
describe('scanMentions — 위치까지', () => {
  it('`@`의 위치와 이름 끝(제외)을 준다', () => {
    expect(scanMentions('hi @kim 님')).toEqual([{ name: 'kim', start: 3, end: 7 }]);
  });

  it('뒤쪽 구분자를 뗀 후보는 **더 짧은 구간**이다', () => {
    expect(scanMentions('@kim.')).toEqual([
      { name: 'kim.', start: 0, end: 5 },
      { name: 'kim', start: 0, end: 4 },
    ]);
  });

  it('**같은 이름이 여러 번 나오면 전부 낸다** — 누가 쳤는지는 곳마다 다를 수 있다', () => {
    expect(scanMentions('@kim 그리고 @kim').map((m) => m.start)).toEqual([0, 9]);
  });

  it('**`extractMentions`와 같은 이름을 같은 순서로 찾는다**', () => {
    const samples = ['@kim 확인', '(@lee) "@park"', 'kim@example.internal', '@kim. @kim_ 그리고 @a', '첫 줄 @x1\n\n\n둘째 @y2'];
    for (const text of samples) {
      const d = doc(...text.split('\n'));
      const names = [...new Set(scanMentions(extractText(d)).map((m) => m.name))];
      expect(names).toEqual(extractMentions(d));
    }
  });
});

describe('mentionAuthors — 이름마다 친 사람', () => {
  /** 글자 하나에 작성자 하나. 문자열로 적으면 읽기 쉽다: `A`·`B`는 사람, `.`은 모름 */
  const by = (s: string): (string | null)[] => [...s].map((c) => (c === '.' ? null : c));

  it('`@`부터 이름 끝까지 한 사람이 쳤으면 그 사람이다', () => {
    expect(mentionAuthors('hi @kim', by('BBBAAAA'))).toEqual(new Map([['kim', 'A']]));
  });

  it('**한 글자라도 다른 사람이 쳤으면 모른다** — A가 `@ki`, B가 `m`', () => {
    expect(mentionAuthors('@kim', by('AAAB')).get('kim')).toBeNull();
  });

  it('모르는 글자가 섞여도 모른다', () => {
    expect(mentionAuthors('@kim', by('AA.A')).get('kim')).toBeNull();
  });

  it('**멘션 밖의 글자는 보지 않는다** — 앞의 공백을 누가 쳤든 상관없다', () => {
    expect(mentionAuthors('x @kim 님', by('BBAAAABB')).get('kim')).toBe('A');
  });

  it('**같은 이름이 여러 곳이면 처음 나오는, 친 사람을 아는 것**을 쓴다', () => {
    // 첫째는 둘이 나눠 쳐서 모르고, 둘째는 B가 다 쳤다
    expect(mentionAuthors('@kim @kim', by('AABB.BBBB')).get('kim')).toBe('B');
    // 둘 다 알면 먼저 나온 쪽
    expect(mentionAuthors('@kim @kim', by('AAAA.BBBB')).get('kim')).toBe('A');
  });

  it('구분자를 뗀 후보는 **짧은 구간만** 본다 — `@kim`은 A, 끝의 `.`은 B', () => {
    const got = mentionAuthors('@kim.', by('AAAAB'));
    expect(got.get('kim')).toBe('A');
    expect(got.get('kim.')).toBeNull();
  });

  it('작성자 배열이 글자보다 짧으면 모자란 글자는 모름이다 — 터지지 않는다', () => {
    expect(mentionAuthors('@kim', by('AA')).get('kim')).toBeNull();
  });

  it('멘션이 없으면 빈 표다', () => {
    expect(mentionAuthors('그냥 글', by('AAAA')).size).toBe(0);
  });
});
