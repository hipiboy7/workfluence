import { describe, expect, it } from 'vitest';
import { diffDocs, diffWords, type BlockDiff } from './diff';
import type { DocNode } from './document';

/**
 * A등급 — **테스트 먼저** (CLAUDE.md 3절, P6_설계서_Collab FR-720~726).
 *
 * 비교가 답해야 하는 질문은 하나다: **"무엇이 바뀌었나."** 그래서 검증도 그 질문으로 한다 —
 * 내부 표현이 아니라 "추가·삭제·변경이 맞게 나오는가"를 본다.
 */

const doc = (...blocks: DocNode[]): DocNode => ({ type: 'doc', attrs: { schemaVersion: 1 }, content: blocks });
const p = (text: string): DocNode => ({ type: 'paragraph', content: text ? [{ type: 'text', text }] : [] });
const h = (level: number, text: string): DocNode => ({ type: 'heading', attrs: { level }, content: [{ type: 'text', text }] });
const kinds = (d: BlockDiff[]): string[] => d.map((b) => b.kind);
const texts = (d: BlockDiff[]): string[] => d.map((b) => b.after ?? b.before ?? '');

describe('diffDocs — 같으면 같다고 말한다 (FR-726)', () => {
  it('같은 문서는 차이가 없다', () => {
    const a = doc(p('처음'), p('둘째'));
    expect(diffDocs(a, a).changed).toBe(false);
    expect(kinds(diffDocs(a, a).blocks)).toEqual(['same', 'same']);
  });

  it('빈 문서끼리도 차이가 없다', () => {
    expect(diffDocs(doc(), doc()).changed).toBe(false);
  });

  it('**속성 순서가 달라도 같다고 본다** — 직렬화 차이를 변경으로 읽으면 매번 거짓 경보다', () => {
    const a: DocNode = { type: 'doc', attrs: { schemaVersion: 1 }, content: [{ type: 'heading', attrs: { level: 2, textAlign: 'left' }, content: [{ type: 'text', text: 'x' }] }] };
    const b: DocNode = { type: 'doc', attrs: { schemaVersion: 1 }, content: [{ type: 'heading', attrs: { textAlign: 'left', level: 2 }, content: [{ type: 'text', text: 'x' }] }] };
    expect(diffDocs(a, b).changed).toBe(false);
  });
});

describe('diffDocs — 블록 단위 추가·삭제·변경 (FR-722)', () => {
  it('뒤에 문단을 더하면 added 하나', () => {
    const r = diffDocs(doc(p('하나')), doc(p('하나'), p('둘')));
    expect(kinds(r.blocks)).toEqual(['same', 'added']);
    expect(r.added).toBe(1);
    expect(r.changed).toBe(true);
  });

  it('가운데 문단을 지우면 removed 하나', () => {
    const r = diffDocs(doc(p('하나'), p('둘'), p('셋')), doc(p('하나'), p('셋')));
    expect(kinds(r.blocks)).toEqual(['same', 'removed', 'same']);
    expect(r.removed).toBe(1);
  });

  it('문단 내용을 고치면 changed 하나 — 지우고 더한 것으로 읽지 않는다', () => {
    const r = diffDocs(doc(p('회의 내용')), doc(p('회의 결과')));
    expect(kinds(r.blocks)).toEqual(['changed']);
    expect(r.modified).toBe(1);
  });

  it('**블록 종류가 바뀌면 변경이다** — 문단이 제목이 된 것도 바뀐 것이다', () => {
    const r = diffDocs(doc(p('제목 후보')), doc(h(2, '제목 후보')));
    expect(kinds(r.blocks)).toEqual(['changed']);
  });

  it('가운데에 끼워 넣으면 앞뒤가 same으로 남는다 — 전부 바뀐 것으로 읽지 않는다', () => {
    const r = diffDocs(doc(p('A'), p('C')), doc(p('A'), p('B'), p('C')));
    expect(kinds(r.blocks)).toEqual(['same', 'added', 'same']);
  });

  it('순서를 바꾸면 이동이 아니라 추가·삭제로 나온다 — 그래도 차이는 맞게 센다', () => {
    const r = diffDocs(doc(p('A'), p('B')), doc(p('B'), p('A')));
    expect(r.changed).toBe(true);
    expect(texts(r.blocks).join('')).toContain('A');
  });
});

describe('diffDocs — 낱말 단위 (FR-723)', () => {
  it('바뀐 블록 안에서 **어느 낱말이** 달라졌는지 표시한다', () => {
    const r = diffDocs(doc(p('오늘 회의 내용을 적는다')), doc(p('오늘 회의 결과를 적는다')));
    const [b] = r.blocks;
    expect(b.kind).toBe('changed');
    const removed = b.words!.filter((w) => w.kind === 'removed').map((w) => w.text);
    const added = b.words!.filter((w) => w.kind === 'added').map((w) => w.text);
    expect(removed).toContain('내용을');
    expect(added).toContain('결과를');
    // 안 바뀐 낱말은 same으로 남아야 한다 — 전부 바뀐 것으로 칠하면 읽을 수 없다
    expect(b.words!.filter((w) => w.kind === 'same').map((w) => w.text)).toEqual(['오늘', '회의', '적는다']);
  });

  it('낱말을 하나 더하면 그것만 added', () => {
    const r = diffDocs(doc(p('가 나')), doc(p('가 다 나')));
    const w = r.blocks[0].words!;
    expect(w.filter((x) => x.kind === 'added').map((x) => x.text)).toEqual(['다']);
  });

  it('same·added·removed가 아닌 종류는 나오지 않는다', () => {
    const r = diffDocs(doc(p('가 나 다')), doc(p('가 라 다')));
    for (const w of r.blocks[0].words!) expect(['same', 'added', 'removed']).toContain(w.kind);
  });
});

describe('diffDocs — 자식이 있는 블록 (FR-724)', () => {
  const table = (cell: string): DocNode => ({
    type: 'table',
    content: [{ type: 'tableRow', content: [{ type: 'tableCell', content: [p(cell)] }] }],
  });

  it('표 안의 글자가 바뀌면 변경으로 잡는다', () => {
    const r = diffDocs(doc(table('10만원')), doc(table('12만원')));
    expect(kinds(r.blocks)).toEqual(['changed']);
    expect(r.blocks[0].words!.some((w) => w.kind === 'added' && w.text === '12만원')).toBe(true);
  });

  it('목록 항목이 늘면 변경으로 잡는다', () => {
    const list = (...items: string[]): DocNode => ({
      type: 'bulletList',
      content: items.map((t) => ({ type: 'listItem', content: [p(t)] })),
    });
    expect(diffDocs(doc(list('하나')), doc(list('하나', '둘'))).changed).toBe(true);
  });
});

describe('diffDocs — HTML을 만들지 않는다 (FR-725)', () => {
  it('결과에 태그 문자열이 없다 — 화면이 그린다', () => {
    const r = diffDocs(doc(p('<b>굵게</b>')), doc(p('<i>기울임</i>')));
    const json = JSON.stringify(r);
    expect(json).not.toContain('<span');
    expect(json).not.toContain('<ins');
    // 사용자가 적은 꺾쇠는 **그대로** 남는다. 이스케이프는 그리는 쪽의 일이다
    expect(json).toContain('굵게');
  });
});

describe('diffDocs — 이상한 입력', () => {
  it('content가 없는 문서도 다룬다', () => {
    expect(diffDocs({ type: 'doc' }, doc(p('새 글'))).added).toBe(1);
  });

  it('텍스트가 없는 블록끼리는 같다', () => {
    expect(diffDocs(doc({ type: 'horizontalRule' }), doc({ type: 'horizontalRule' })).changed).toBe(false);
  });

  it('빈 문서에서 시작하면 전부 추가다', () => {
    const r = diffDocs(doc(), doc(p('가'), p('나')));
    expect(kinds(r.blocks)).toEqual(['added', 'added']);
    expect(r.added).toBe(2);
  });

  it('전부 지우면 전부 삭제다', () => {
    const r = diffDocs(doc(p('가'), p('나')), doc());
    expect(kinds(r.blocks)).toEqual(['removed', 'removed']);
    expect(r.removed).toBe(2);
  });
});

describe('diffWords 를 직접 쓰는 경우', () => {
  it('한쪽이 비면 전부 한 종류다', () => {
    expect(diffWords('', '가 나').every((w) => w.kind === 'added')).toBe(true);
    expect(diffWords('가 나', '').every((w) => w.kind === 'removed')).toBe(true);
    expect(diffWords('', '')).toEqual([]);
  });

  it('공백만 다른 것은 차이가 아니다 — 사람이 묻는 차이가 아니다', () => {
    expect(diffWords('가  나', '가 나').every((w) => w.kind === 'same')).toBe(true);
  });
});

describe('블록 텍스트는 블록 하나의 것이다', () => {
  it('같은 문서의 문단 둘이 한 덩어리로 합쳐지지 않는다', () => {
    const r = diffDocs(doc(p('가'), p('나')), doc(p('가'), p('나')));
    // same 블록의 텍스트는 블록 하나의 것이어야 한다 — 문서 전체가 아니다
    expect(r.blocks.map((b) => b.after)).toEqual(['가', '나']);
  });

  it('**`after.content`가 없어도** 다룬다 — 삭제만 있는 비교', () => {
    const r = diffDocs(doc(p('가')), { type: 'doc' });
    expect(kinds(r.blocks)).toEqual(['removed']);
  });
});
