// @vitest-environment happy-dom
import { Editor, generateJSON } from '@tiptap/core';
import { CellSelection } from '@tiptap/pm/tables';
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
    expect(clampColwidth([Number.NaN, 0, 50.7])).toEqual([null, 0, 50]);
    expect(clampColwidth([Number.NaN])).toBeNull();
    expect(clampColwidth(null)).toBeNull();
    expect(clampColwidth(Array.from({ length: 2000 }, () => 10))).toHaveLength(TABLE_LIMITS.maxSpan);
  });
});

/**
 * **표 명령이 만드는 값** (P12 보안 검토 2 · 코드 리뷰 1·2). 칸 합치기·열 넣기는 붙여 넣기를 거치지 않는다 — 있는 값을 더하고, 너비 없는 열에
 * 0을 쓴다(prosemirror-tables). 서버가 0을 받고, 범위를 넘게 만드는 명령은 편집기가 하지 않는다
 */
describe('표 명령이 만드는 값 (FR-1322·1323)', () => {
  const cell = (text: string, attrs: Record<string, unknown> = {}) => ({ type: 'tableCell', attrs: { colspan: 1, rowspan: 1, ...attrs }, content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] });
  const tableDoc = (...cells: ReturnType<typeof cell>[]) => ({ type: 'doc', content: [{ type: 'table', content: [{ type: 'tableRow', content: cells }] }] });
  const open = (content: ReturnType<typeof tableDoc>) => new Editor({ element: document.createElement('div'), extensions: editorExtensions(), content });
  /** 표의 칸 둘을 고른다 */
  const selectCells = (editor: Editor) => {
    const at: number[] = [];
    editor.state.doc.descendants((n, pos) => {
      if (n.type.name === 'tableCell') at.push(pos);
    });
    editor.view.dispatch(editor.state.tr.setSelection(CellSelection.create(editor.state.doc, at[0], at[at.length - 1])));
  };
  const spans = (editor: Editor) => cellsOf(editor.getJSON() as DocNode).map((a) => a.colspan);

  it('**합쳐 1000을 넘게 되면 합치지 않는다** — 누가 999를 심어 둔 표에서 동료가 끊기던 길', () => {
    const editor = open(tableDoc(cell('심은 칸', { colspan: 999 }), cell('옆 칸', { colspan: 2 })));
    selectCells(editor);
    editor.commands.mergeCells();
    expect(spans(editor)).toEqual([999, 2]);
    expect(validateDocument(editor.getJSON() as DocNode)).toEqual({ ok: true });
    editor.destroy();
  });

  it('정상 — 칸 둘을 합친다, 합친 칸 안에 열을 넣으면 너비 없는 열은 0이고 서버가 받는다', () => {
    const editor = open(tableDoc(cell('가', { colwidth: [100] }), cell('나', { colwidth: [120] })));
    selectCells(editor);
    expect(editor.commands.mergeCells()).toBe(true);
    expect(spans(editor)).toEqual([2]);
    editor.commands.setTextSelection(4);
    editor.commands.addColumnAfter();
    const json = editor.getJSON() as DocNode;
    expect(cellsOf(json).some((a) => Array.isArray(a.colwidth) && (a.colwidth as unknown[]).includes(0))).toBe(true);
    expect(validateDocument(json)).toEqual({ ok: true });
    editor.destroy();
  });
});

