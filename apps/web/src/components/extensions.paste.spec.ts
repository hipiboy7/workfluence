// @vitest-environment happy-dom
import { generateJSON } from '@tiptap/core';
import { TABLE_LIMITS, validateDocument, type DocNode } from '@workfluence/shared';
import { describe, expect, it } from 'vitest';
import { clampColwidth, clampSpan, editorExtensions } from './extensions';

/**
 * **붙여 넣은 표 칸의 값을 서버가 받는 범위로** (P12_설계서_Limits D.4, FR-1323, 보류 27). 편집기가 만든 것은 서버가 받아야 한다(P9 D.7) —
 * 줄이지 않으면 큰 `colspan`을 붙여 넣은 정상 사용자가 관문에 끊긴다. 붙여 넣기는 HTML을 편집기 스키마로 읽는 것이다(`generateJSON`)
 */
const cellsOf = (d: DocNode): Record<string, unknown>[] => {
  const out: Record<string, unknown>[] = [];
  const walk = (n: DocNode) => {
    if (n.type === 'tableCell' || n.type === 'tableHeader') out.push(n.attrs ?? {});
    n.content?.forEach(walk);
  };
  walk(d);
  return out;
};

describe('붙여 넣은 표 칸의 값 (FR-1323)', () => {
  it('**합치는 수는 1~1000으로, 열 너비는 숫자만·10000까지** — 읽은 문서를 서버가 받는다', () => {
    const html =
      '<table><tr><th colspan="5000" rowspan="0">머리</th><td colspan="abc" rowspan="70000" colwidth="99999,abc,120">칸</td><td colspan="3" colwidth="80">보통</td></tr></table>';
    const json = generateJSON(html, editorExtensions()) as DocNode;
    expect(cellsOf(json).map((a) => [a.colspan, a.rowspan, a.colwidth])).toEqual([
      [TABLE_LIMITS.maxSpan, 1, null],
      [1, TABLE_LIMITS.maxSpan, [TABLE_LIMITS.maxColWidthPx, null, 120]],
      [3, 1, [80]],
    ]);
    expect(validateDocument(json)).toEqual({ ok: true });
  });

  it('줄이는 규칙', () => {
    expect([clampSpan('2'), clampSpan(7), clampSpan('0'), clampSpan('-3'), clampSpan('1.9'), clampSpan(null), clampSpan('1e9')]).toEqual([2, 7, 1, 1, 1, 1, 1]);
    expect(clampSpan('100000')).toBe(TABLE_LIMITS.maxSpan);
    expect(clampColwidth([Number.NaN, 0, 50.7])).toEqual([null, null, 50]);
    expect(clampColwidth([Number.NaN])).toBeNull();
    expect(clampColwidth(null)).toBeNull();
    expect(clampColwidth(Array.from({ length: 2000 }, () => 10))).toHaveLength(TABLE_LIMITS.maxSpan);
  });
});
