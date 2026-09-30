// @vitest-environment happy-dom
import { Editor, type Content } from '@tiptap/core';
import Collaboration from '@tiptap/extension-collaboration';
import { TextSelection } from '@tiptap/pm/state';
import { TABLE_LIMITS, nodeAttrProblems, validateDocument, type DocNode } from '@workfluence/shared';
import { afterEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { editorExtensions } from './extensions';
import {
  COMPACT_TOOLBAR,
  FORMAT_ACTIONS,
  FULL_TOOLBAR,
  LINK_NOT_ALLOWED,
  TABLE_TOOLBAR,
  applyLink,
  currentBlock,
  linkHrefAt,
  removeLink,
  setBlock,
  type FormatActionId,
} from './formatActions';

/**
 * 서식 단추의 **판정과 실행** (P19_설계서_Recovery D.1~D.3, FR-2020~2026). 실제 편집기(TipTap — 화면과 같은 확장 목록)를 만들어 단추마다 누르고,
 * **만든 문서가 정본 검증을 지나는지**(`validateDocument` — 서버의 저장·관문과 같은 판정) 본다. 표 명령은 표 한계(`TABLE_LIMITS`)도 본다
 */

let editors: Editor[] = [];
afterEach(() => {
  for (const e of editors) e.destroy();
  editors = [];
});

const para = (text: string) => ({ type: 'paragraph', content: [{ type: 'text', text }] });
function open(content: Content = { type: 'doc', content: [para('안녕 위키')] }, collab = false): Editor {
  const ydoc = new Y.Doc();
  const e = new Editor({
    element: document.createElement('div'),
    extensions: collab ? [...editorExtensions({ collab: true }), Collaboration.configure({ document: ydoc })] : editorExtensions(),
    ...(collab ? {} : { content }),
  });
  editors.push(e);
  return e;
}
/** 첫 문단의 글자 [from, to)를 고른다 — 문서 맨 앞이 1이다 */
const select = (e: Editor, from: number, to: number) => e.view.dispatch(e.state.tr.setSelection(TextSelection.create(e.state.doc, from, to)));
const valid = (e: Editor) => expect(validateDocument(e.getJSON() as DocNode)).toEqual({ ok: true });
const json = (e: Editor) => e.getJSON() as DocNode;

describe('줄의 구성 (FR-2020·2021, 착수 쟁점 3·4)', () => {
  it('**전체 줄** — 문단 형식, 글자 다섯, 목록 둘, 블록 셋, 링크·표 넣기, 되돌리기·다시', () => {
    expect(FULL_TOOLBAR.flat()).toEqual(['block-type', 'bold', 'italic', 'underline', 'strike', 'code', 'bulletList', 'orderedList', 'blockquote', 'codeBlock', 'horizontalRule', 'link', 'insertTable', 'undo', 'redo']);
  });

  it('**짧은 줄**(댓글) — 굵게·기울임·코드·목록 둘·링크', () => {
    expect(COMPACT_TOOLBAR.flat()).toEqual(['bold', 'italic', 'code', 'bulletList', 'orderedList', 'link']);
  });

  it('**표 무리** — 행·열 더하기/지우기, 표 지우기. 칸 합치기·나누기는 없다(착수 쟁점 4)', () => {
    expect(TABLE_TOOLBAR).toEqual(['addRowBefore', 'addRowAfter', 'addColumnBefore', 'addColumnAfter', 'deleteRow', 'deleteColumn', 'deleteTable']);
    expect(Object.keys(FORMAT_ACTIONS)).not.toContain('mergeCells');
  });

  it('단추마다 한국어 이름이 있고, 단축키는 편집기가 가진 것이다(링크의 Ctrl+K만 줄이 둔다)', () => {
    for (const a of Object.values(FORMAT_ACTIONS)) expect(a.label, a.id).toMatch(/[가-힣]/);
    expect(FORMAT_ACTIONS.bold.shortcut).toBe('Ctrl+B');
    expect(FORMAT_ACTIONS.orderedList.shortcut).toBe('Ctrl+Shift+7');
    expect(FORMAT_ACTIONS.link.shortcut).toBe('Ctrl+K');
  });
});

describe('글자 서식 · 목록 · 블록 — 누르면 켜지고 다시 누르면 꺼진다, 문서는 정본 검증을 지난다', () => {
  const marks: FormatActionId[] = ['bold', 'italic', 'underline', 'strike', 'code'];

  it.each(marks)('%s', (id) => {
    const e = open();
    select(e, 1, 3);
    const a = FORMAT_ACTIONS[id];
    expect(a.can(e)).toBe(true);
    expect(a.active!(e)).toBe(false);
    a.run(e);
    expect(a.active!(e)).toBe(true);
    const text = json(e).content![0].content![0];
    expect(text.marks?.map((m) => m.type)).toEqual([id]);
    valid(e);
    a.run(e);
    expect(a.active!(e)).toBe(false);
  });

  it.each(['bulletList', 'orderedList', 'blockquote', 'codeBlock'] as FormatActionId[])('%s', (id) => {
    const e = open();
    select(e, 2, 2);
    FORMAT_ACTIONS[id].run(e);
    expect(FORMAT_ACTIONS[id].active!(e)).toBe(true);
    expect(json(e).content![0].type).toBe(id);
    valid(e);
  });

  it('구분선을 넣는다', () => {
    const e = open();
    select(e, 6, 6);
    FORMAT_ACTIONS.horizontalRule.run(e);
    expect(json(e).content!.map((n) => n.type)).toContain('horizontalRule');
    valid(e);
  });

  it('**코드 블록 안에서는 글자 서식을 쓸 수 없다** — 스키마가 막는다(P9 — 받은 편집기가 블록째 지웠다)', () => {
    const e = open({ type: 'doc', content: [{ type: 'codeBlock', content: [{ type: 'text', text: 'let a = 1' }] }] });
    select(e, 1, 4);
    expect(FORMAT_ACTIONS.bold.can(e)).toBe(false);
    expect(FORMAT_ACTIONS.link.can(e)).toBe(false);
  });
});

describe('문단 형식 (D.1)', () => {
  it('본문 ↔ 제목 1~3 — 지금 형식을 읽는다', () => {
    const e = open();
    select(e, 2, 2);
    expect(currentBlock(e)).toBe('paragraph');
    expect(setBlock(e, 'h2')).toBe(true);
    expect(currentBlock(e)).toBe('h2');
    expect(json(e).content![0]).toMatchObject({ type: 'heading', attrs: { level: 2 } });
    valid(e);
    expect(setBlock(e, 'paragraph')).toBe(true);
    expect(currentBlock(e)).toBe('paragraph');
  });

  it('`####`로 친 제목은 그 단계로 읽는다 · 코드 블록 안은 `other`', () => {
    expect(currentBlock(open({ type: 'doc', content: [{ type: 'heading', attrs: { level: 4 }, content: [{ type: 'text', text: '넷' }] }] }))).toBe('h4');
    const code = open({ type: 'doc', content: [{ type: 'codeBlock', content: [{ type: 'text', text: 'x' }] }] });
    expect(currentBlock(code)).toBe('other');
    expect(setBlock(code, 'other')).toBe(false);
  });

  it('**목록 항목 안에서 제목으로 바꾸면 목록 밖으로 꺼낸다** — 목록 항목의 첫 자식은 문단이다(P12 FR-1320). 편집기가 스키마대로 한다', () => {
    const e = open({ type: 'doc', content: [{ type: 'bulletList', content: [{ type: 'listItem', content: [para('항목')] }] }] });
    select(e, 3, 3);
    setBlock(e, 'h1');
    const firsts: string[] = [];
    e.state.doc.descendants((n) => {
      if (n.type.name === 'listItem') firsts.push(n.firstChild!.type.name);
    });
    expect(firsts.every((t) => t === 'paragraph')).toBe(true);
    expect(json(e).content![0]).toMatchObject({ type: 'heading', attrs: { level: 1 } });
    valid(e);
  });
});

describe('링크 (D.2, FR-2023)', () => {
  it('**고른 글에 건다** — http(s)·위키 안 주소만, 앞뒤 빈칸은 뗀다', () => {
    const e = open();
    select(e, 1, 3);
    expect(applyLink(e, '  https://example.internal/문서  ')).toBeNull();
    const text = json(e).content![0].content![0];
    expect(text).toMatchObject({ text: '안녕', marks: [{ type: 'link', attrs: { href: 'https://example.internal/문서' } }] });
    expect(linkHrefAt(e)).toBe('https://example.internal/문서');
    valid(e);
  });

  it('**링크가 되지 않는 주소는 하지 않고 까닭** — `mailto:`·`javascript:`·스킴 없는 주소(P9 B.2 — 저장이 멈췄던 길)', () => {
    const e = open();
    select(e, 1, 3);
    // `/\\…`·`/<탭>/…`는 브라우저에서 `//…` — 바깥 주소를 위키 안 주소로 꾸민 것이다(P19 보안 검토 3)
    for (const bad of ['mailto:a@example.internal', 'javascript:alert(1)', 'www.example.internal', '//evil.example', '/\\evil.example', '/\t/evil.example', '']) {
      expect(applyLink(e, bad), bad).toBe(LINK_NOT_ALLOWED);
    }
    expect(json(e).content![0].content![0].marks).toBeUndefined();
  });

  it('**고른 글이 없으면 주소를 글로 넣는다** · 위키 안 주소도 된다', () => {
    const e = open();
    select(e, 6, 6);
    expect(applyLink(e, '/pages/11111111-1111-4111-8111-111111111111')).toBeNull();
    const texts = json(e).content![0].content!;
    expect(texts.at(-1)).toMatchObject({ text: '/pages/11111111-1111-4111-8111-111111111111', marks: [{ type: 'link' }] });
    valid(e);
  });

  it('**링크 위에서는 주소를 바꾸고 뺀다** — 그 링크 전체', () => {
    const e = open({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: '위키', marks: [{ type: 'link', attrs: { href: 'https://a.example.internal' } }] }] }] });
    select(e, 2, 2);
    expect(FORMAT_ACTIONS.link.active!(e)).toBe(true);
    expect(applyLink(e, 'https://b.example.internal')).toBeNull();
    expect(json(e).content![0].content).toHaveLength(1);
    expect(linkHrefAt(e)).toBe('https://b.example.internal');
    removeLink(e);
    expect(json(e).content![0].content![0].marks).toBeUndefined();
    expect(linkHrefAt(e)).toBeNull();
  });
});

describe('표 (FR-2024)', () => {
  const tableOf = (e: Editor) => json(e).content!.find((n) => n.type === 'table')!;
  const shape = (e: Editor) => tableOf(e).content!.map((row) => row.content!.map((c) => c.type[5]).join(''));
  /** 줄 수 × 칸 수 */
  const size = (e: Editor) => [tableOf(e).content!.length, tableOf(e).content![0].content!.length];
  const cellsIn = (e: Editor) => tableOf(e).content!.flatMap((row) => row.content!);

  it('**3×3, 첫 줄은 머리 칸** — 표 안에서는 넣기를 누를 수 없다', () => {
    const e = open();
    select(e, 6, 6);
    expect(FORMAT_ACTIONS.insertTable.can(e)).toBe(true);
    FORMAT_ACTIONS.insertTable.run(e);
    expect(shape(e)).toEqual(['HHH', 'CCC', 'CCC']);
    expect(e.isActive('table')).toBe(true);
    expect(FORMAT_ACTIONS.insertTable.can(e)).toBe(false);
    valid(e);
  });

  it('**행·열 더하기와 지우기, 표 지우기** — 명령마다 정본 검증을 지나고 칸 값이 표 한계 안이다', () => {
    const e = open();
    select(e, 6, 6);
    FORMAT_ACTIONS.insertTable.run(e);
    const steps: [FormatActionId, number[]][] = [
      ['addRowAfter', [4, 3]],
      ['addColumnAfter', [4, 4]],
      ['addRowBefore', [5, 4]],
      ['addColumnBefore', [5, 5]],
      ['deleteRow', [4, 5]],
      ['deleteColumn', [4, 4]],
    ];
    for (const [id, want] of steps) {
      expect(FORMAT_ACTIONS[id].can(e), id).toBe(true);
      FORMAT_ACTIONS[id].run(e);
      expect(size(e), id).toEqual(want);
      valid(e);
      for (const c of cellsIn(e)) expect(nodeAttrProblems(c.type, c.attrs), id).toEqual([]);
    }
    for (const c of cellsIn(e)) expect((c.attrs as { colspan: number }).colspan).toBeLessThanOrEqual(TABLE_LIMITS.maxSpan);
    FORMAT_ACTIONS.deleteTable.run(e);
    expect(json(e).content!.some((n) => n.type === 'table')).toBe(false);
    valid(e);
  });

  it('**표 밖에서는 표 무리를 누를 수 없다**', () => {
    const e = open();
    select(e, 2, 2);
    for (const id of TABLE_TOOLBAR) expect(FORMAT_ACTIONS[id].can(e), id).toBe(false);
  });
});

describe('되돌리기 · 다시 (A.1-20)', () => {
  it('혼자 쓸 때는 편집기의 이력 — 처음에는 누를 수 없고, 고치면 되돌리고 다시 한다', () => {
    const e = open();
    expect(FORMAT_ACTIONS.undo.can(e)).toBe(false);
    select(e, 1, 3);
    FORMAT_ACTIONS.bold.run(e);
    expect(FORMAT_ACTIONS.undo.can(e)).toBe(true);
    FORMAT_ACTIONS.undo.run(e);
    expect(json(e).content![0].content![0].marks).toBeUndefined();
    expect(FORMAT_ACTIONS.redo.can(e)).toBe(true);
    FORMAT_ACTIONS.redo.run(e);
    expect(json(e).content![0].content![0].marks?.map((m) => m.type)).toEqual(['bold']);
  });

  it('**실시간 편집이면 Yjs의 되돌리기** — 같은 이름의 명령을 협업 확장이 준다', () => {
    const e = open(undefined, true);
    e.commands.insertContent('함께 쓴 글');
    expect(FORMAT_ACTIONS.undo.can(e)).toBe(true);
    FORMAT_ACTIONS.undo.run(e);
    expect(e.getText()).toBe('');
  });
});
