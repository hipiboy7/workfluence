import { getSchema } from '@tiptap/core';
import type { ContentMatch, NodeType } from '@tiptap/pm/model';
import { ALLOWED_CHILDREN, ALLOWED_MARKS, ALLOWED_NODES, FIRST_CHILD, MARKS_IN, NON_EMPTY_NODES } from '@workfluence/shared';
import { describe, expect, it } from 'vitest';
import { Fragment, Slice, type Node as PMNode } from '@tiptap/pm/model';
import { editorExtensions, linkAllowed, relWithoutOpener, sliceWithoutOpener } from './extensions';

/**
 * **편집기 스키마 = 서버 허용 목록** (P9_설계서_Gate D.7, FR-1007).
 *
 * 서버의 관문은 허용 목록 밖을 받지 않고 연결을 끊는다(쟁점 1). 그래서 **편집기가 만들 수 있는 것은 전부 허용 목록
 * 안이어야 하고**(아니면 정상 편집이 끊긴다), **허용 목록에만 있는 것은 없어야 한다**(편집기가 만들 수 없는 것은
 * 조작한 클라이언트만 넣는다 — 보류 22의 "보이지 않는 속성"). 편집기에 확장을 더하는 날 이 시험이 먼저 깨진다.
 *
 * 스키마는 화면이 쓰는 확장 목록(`editorExtensions`)에서 뽑는다 — 목록을 여기 옮겨 적으면 둘이 따로 바뀐다.
 */

const schema = getSchema(editorExtensions());

/** 내용 식에서 나올 수 있는 자식 종류 — 순서와 개수는 보지 않는다 (D.8) */
function childTypes(type: NodeType): string[] {
  const seen = new Set<ContentMatch>();
  const out = new Set<string>();
  const stack: ContentMatch[] = [type.contentMatch];
  while (stack.length) {
    const m = stack.pop()!;
    if (seen.has(m)) continue;
    seen.add(m);
    for (let i = 0; i < m.edgeCount; i++) {
      const e = m.edge(i);
      out.add(e.type.name);
      stack.push(e.next);
    }
  }
  return [...out].sort();
}
const sorted = (xs: readonly string[]): string[] => [...xs].sort();

/** 한 상태에서 나가는 자식 종류 */
const edgeTypes = (m: ContentMatch): string[] => sorted(Array.from({ length: m.edgeCount }, (_, i) => m.edge(i).type.name));

/**
 * **내용 식을 "첫 자식 · 그 뒤 허용 자식의 되풀이 · 비어도 되는가"로 읽는다** (P12 FR-1311, 보류 25). 첫 걸음 뒤의 모든 상태가 "끝나도 되고,
 * 허용 자식 전부로 나가고, 나간 곳도 같은 상태"여야 한다 — 아니면 두 번째 자식의 규칙 같은 다른 모양이라 `'other'`다.
 */
function orderRules(type: NodeType): { nonEmpty: boolean; first: string[] | null } | 'other' {
  const kids = childTypes(type);
  const loops = new Map<ContentMatch, boolean>();
  const isLoop = (m: ContentMatch): boolean => {
    if (loops.has(m)) return loops.get(m)!;
    loops.set(m, true); // 되돌아오는 상태는 지금 보는 중이다
    const ok = m.validEnd && edgeTypes(m).join() === kids.join() && Array.from({ length: m.edgeCount }, (_, i) => m.edge(i).next).every(isLoop);
    loops.set(m, ok);
    return ok;
  };
  const start = type.contentMatch;
  if (start.edgeCount === 0) return start.validEnd ? { nonEmpty: false, first: null } : 'other';
  const nexts = Array.from({ length: start.edgeCount }, (_, i) => start.edge(i).next);
  if (!nexts.every(isLoop)) return 'other';
  const firsts = edgeTypes(start);
  if (start.validEnd && firsts.join() !== kids.join()) return 'other';
  return { nonEmpty: !start.validEnd, first: firsts.join() === kids.join() ? null : firsts };
}

describe('편집기 스키마 = 서버 허용 목록 (FR-1007)', () => {
  it('노드 이름이 같다', () => {
    expect(sorted(Object.keys(schema.nodes))).toEqual(sorted(Object.keys(ALLOWED_NODES)));
  });

  it('노드마다 속성 키가 같다 — `doc.schemaVersion`만 예외다(서버가 저장 직전에 찍는다)', () => {
    for (const [name, type] of Object.entries(schema.nodes)) {
      const allowed = ALLOWED_NODES[name].filter((k) => !(name === 'doc' && k === 'schemaVersion'));
      expect([name, sorted(Object.keys(type.spec.attrs ?? {}))]).toEqual([name, sorted(allowed)]);
    }
  });

  it('마크 이름과 속성 키가 같다', () => {
    expect(sorted(Object.keys(schema.marks))).toEqual(sorted(Object.keys(ALLOWED_MARKS)));
    for (const [name, type] of Object.entries(schema.marks)) {
      expect([name, sorted(Object.keys(type.spec.attrs ?? {}))]).toEqual([name, sorted(ALLOWED_MARKS[name])]);
    }
  });

  it('자식 종류가 같다 — 편집기의 내용 식에서 나올 수 있는 것', () => {
    for (const [name, type] of Object.entries(schema.nodes)) {
      expect([name, childTypes(type)]).toEqual([name, sorted(ALLOWED_CHILDREN[name])]);
    }
  });

  it('**순서와 개수가 같다** — 첫 자식(`FIRST_CHILD`)·비어 있을 수 없음(`NON_EMPTY_NODES`), 그 밖의 순서 규칙은 없다 (P12 FR-1311, 보류 25)', () => {
    for (const [name, type] of Object.entries(schema.nodes)) {
      const expected = { nonEmpty: NON_EMPTY_NODES.includes(name), first: Object.hasOwn(FIRST_CHILD, name) ? sorted(FIRST_CHILD[name]) : null };
      expect([name, orderRules(type)]).toEqual([name, expected]);
    }
  });

  it('글자를 담는 노드가 받는 마크가 같다 — `codeBlock`은 아무 마크도 받지 않는다', () => {
    for (const [name, type] of Object.entries(schema.nodes)) {
      if (!type.inlineContent) continue;
      const marks = type.markSet === null ? Object.keys(schema.marks) : type.markSet.map((m) => m.name);
      expect([name, sorted(marks)]).toEqual([name, sorted(MARKS_IN[name])]);
    }
  });

  it('모든 마크가 스스로를 배제한다 — 아니면 화면의 동기화(y-tiptap)가 `이름--해시` 서식 키를 만들어 관문이 받지 않는다', () => {
    for (const m of Object.values(schema.marks)) expect([m.name, m.excludes(m)]).toEqual([m.name, true]);
  });
});

describe('링크 규칙 — 7절: http(s)·내부 경로·앵커만 (FR-1008)', () => {
  it.each(['https://example.internal/a', 'http://example.internal', '/pages/abc', '#section'])('%s → 링크가 된다', (url) => {
    expect(linkAllowed(url)).toBe(true);
  });

  it.each(['mailto:user@example.internal', 'tel:0200000000', 'javascript:alert(1)', 'data:text/html,x', '//evil.example/'])('%s → 링크가 되지 않는다', (url) => {
    expect(linkAllowed(url)).toBe(false);
  });
});

describe("붙여 넣은 링크의 rel에서 'opener' 낱말을 뺀다 — 편집기가 만든 것을 서버가 받게 (P9 세 번째 묶음 · FR-1007)", () => {
  it.each<[string | null, string | null]>([
    ['opener', null],
    ['opener nofollow', 'nofollow'],
    ['  Opener   noreferrer ', 'noreferrer'],
    ['noopener noreferrer nofollow', 'noopener noreferrer nofollow'],
    [null, null],
  ])('%j → %j', (rel, out) => {
    expect(relWithoutOpener(rel)).toBe(out);
  });

  it('두 편집기의 확장 목록에 들어 있다 — 빠지면 붙여 넣은 링크가 그대로 들어가 그 사람이 끊긴다', () => {
    for (const collab of [false, true]) expect(editorExtensions({ collab }).map((e) => e.name)).toContain('pastedLinkRel');
  });

  it('붙여 넣는 조각 안의 링크마다 — 표 칸 안의 링크도', () => {
    const link = (rel: string | null) => schema.marks.link.create({ href: 'https://example.internal', rel });
    const para = (rel: string | null) => schema.nodes.paragraph.create(null, schema.text('링크', [link(rel)]));
    const cell = schema.nodes.tableCell.create(null, para('opener nofollow'));
    const table = schema.nodes.table.create(null, schema.nodes.tableRow.create(null, cell));
    const slice = new Slice(Fragment.fromArray([para('OPENER'), table, para('nofollow')]), 0, 0);
    const rels: unknown[] = [];
    sliceWithoutOpener(slice).content.descendants((n: PMNode) => {
      for (const m of n.marks) if (m.type.name === 'link') rels.push(m.attrs.rel);
    });
    expect(rels).toEqual([null, 'nofollow', 'nofollow']);
  });
});
