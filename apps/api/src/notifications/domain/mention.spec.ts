import type { DocNode } from '@workfluence/shared';
import { describe, expect, it } from 'vitest';
import { extractMentions } from './mention';

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

  it('뒤에 붙은 문장부호는 아이디에 넣지 않는다', () => {
    expect(extractMentions(doc('@kim, @lee. @park?'))).toEqual(['kim', 'lee', 'park']);
    expect(extractMentions(doc('@kim...'))).toEqual(['kim']);
  });

  it('한글 바로 뒤에 붙은 것도 멘션이다 — 한국어는 조사가 붙는다', () => {
    expect(extractMentions(doc('담당자는 @kim님입니다'))).toEqual(['kim']);
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
