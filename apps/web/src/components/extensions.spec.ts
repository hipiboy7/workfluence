import { getSchema } from '@tiptap/core';
import type { ContentMatch, NodeType } from '@tiptap/pm/model';
import { ALLOWED_CHILDREN, ALLOWED_MARKS, ALLOWED_NODES, MARKS_IN } from '@workfluence/shared';
import { describe, expect, it } from 'vitest';
import { editorExtensions, linkAllowed } from './extensions';

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
