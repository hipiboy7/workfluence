import { describe, expect, it } from 'vitest';
import { DOCUMENT_SCHEMA_VERSION } from './constants';
import { documentSchemaVersion, emptyDocument, extractText, validateDocument, type DocNode } from './document';

const text = (t: string, marks?: DocNode['marks']): DocNode => ({ type: 'text', text: t, ...(marks ? { marks } : {}) });
const para = (...content: DocNode[]): DocNode => ({ type: 'paragraph', content });
const doc = (...content: DocNode[]): DocNode => ({ type: 'doc', content });

describe('validateDocument', () => {
  it('빈 문서와 기본 블록을 허용한다', () => {
    expect(validateDocument(emptyDocument())).toEqual({ ok: true });
    const d = doc(
      { type: 'heading', attrs: { level: 2 }, content: [text('제목')] },
      para(text('본문 '), text('강조', [{ type: 'bold' }]), { type: 'hardBreak' }),
      { type: 'bulletList', content: [{ type: 'listItem', content: [para(text('항목'))] }] },
      { type: 'codeBlock', attrs: { language: null }, content: [text('code')] },
      {
        type: 'table',
        content: [
          {
            type: 'tableRow',
            content: [
              { type: 'tableHeader', attrs: { colspan: 1, rowspan: 1, colwidth: null }, content: [para(text('h'))] },
              { type: 'tableCell', attrs: { colspan: 1, rowspan: 1, colwidth: [120] }, content: [para(text('c'))] },
            ],
          },
        ],
      },
      { type: 'horizontalRule' },
    );
    expect(validateDocument(d)).toEqual({ ok: true });
  });

  it('최상위가 doc이 아니면 거부한다', () => {
    expect(validateDocument(para(text('x')))).toEqual({ ok: false, errors: ['최상위 노드는 type: "doc"이어야 한다'] });
    expect(validateDocument(null).ok).toBe(false);
    expect(validateDocument('문자열').ok).toBe(false);
  });

  it('허용 목록 밖의 노드·마크·속성을 거부한다', () => {
    const r1 = validateDocument(doc({ type: 'iframe', attrs: { src: 'https://x' } }));
    expect(r1.ok).toBe(false);
    expect((r1 as { errors: string[] }).errors[0]).toContain("허용되지 않는 노드 'iframe'");

    const r2 = validateDocument(doc(para(text('x', [{ type: 'highlight' }]))));
    expect((r2 as { errors: string[] }).errors[0]).toContain("허용되지 않는 마크 'highlight'");

    const r3 = validateDocument(doc({ type: 'paragraph', attrs: { onclick: 'alert(1)' } }));
    expect((r3 as { errors: string[] }).errors[0]).toContain("허용되지 않는 속성 'onclick'");
  });

  it('위험한 링크 주소를 거부하고 안전한 주소는 허용한다', () => {
    const link = (href: string) => doc(para(text('l', [{ type: 'link', attrs: { href, target: null, rel: null, class: null } }])));
    expect(validateDocument(link('https://example.internal/a')).ok).toBe(true);
    expect(validateDocument(link('/pages/abc')).ok).toBe(true);
    expect(validateDocument(link('#section')).ok).toBe(true);
    expect(validateDocument(link('javascript:alert(1)')).ok).toBe(false);
    expect(validateDocument(link('data:text/html,x')).ok).toBe(false);
    expect(validateDocument(link('//evil.example/')).ok).toBe(false);
    expect(validateDocument(doc(para(text('l', [{ type: 'link' }])))).ok).toBe(false);
  });

  it('heading level, text 노드 형태, attrs·marks·content 타입을 검사한다', () => {
    expect(validateDocument(doc({ type: 'heading', attrs: { level: 9 }, content: [text('x')] })).ok).toBe(false);
    expect(validateDocument(doc(para({ type: 'text', text: '' }))).ok).toBe(false);
    expect(validateDocument(doc(para({ type: 'text', text: 'a', content: [] }))).ok).toBe(false);
    expect(validateDocument(doc({ type: 'paragraph', text: 'no' })).ok).toBe(false);
    expect(validateDocument(doc({ type: 'paragraph', attrs: 'bad' as unknown as Record<string, unknown> })).ok).toBe(false);
    expect(validateDocument(doc({ type: 'paragraph', attrs: { textAlign: { nested: true } } })).ok).toBe(false);
    expect(validateDocument(doc(para({ type: 'text', text: 'a', marks: 'bad' as unknown as DocNode['marks'] }))).ok).toBe(false);
    expect(validateDocument(doc({ type: 'paragraph', content: 'bad' as unknown as DocNode[] })).ok).toBe(false);
    expect(validateDocument(doc(para(42 as unknown as DocNode))).ok).toBe(false);
    expect(validateDocument(doc(para(text('a', [null as unknown as DocMarkLike])))).ok).toBe(false);
  });

  it('과도한 중첩과 노드 수를 거부하고 오류 수집을 20건에서 멈춘다', () => {
    let deep: DocNode = para(text('x'));
    for (let i = 0; i < 70; i++) deep = { type: 'blockquote', content: [deep] };
    const rDeep = validateDocument(doc(deep));
    expect(rDeep.ok).toBe(false);
    expect((rDeep as { errors: string[] }).errors.some((e) => e.includes('중첩 깊이'))).toBe(true);

    const many = doc(...Array.from({ length: 30 }, () => ({ type: 'bogus' })));
    const rMany = validateDocument(many);
    expect((rMany as { errors: string[] }).errors.length).toBe(20);
  });
});

type DocMarkLike = { type: string };

describe('문서 스키마 버전 (CLAUDE.md 6절)', () => {
  it('빈 문서에 스키마 버전이 박히고 검증을 통과한다', () => {
    const d = emptyDocument();
    expect(documentSchemaVersion(d)).toBe(DOCUMENT_SCHEMA_VERSION);
    expect(validateDocument(d)).toEqual({ ok: true });
  });

  it('버전 표기가 없는 문서도 허용한다 (표기 이전 문서)', () => {
    const d: DocNode = { type: 'doc', content: [{ type: 'paragraph' }] };
    expect(documentSchemaVersion(d)).toBeNull();
    expect(validateDocument(d)).toEqual({ ok: true });
  });

  it('doc에 다른 속성은 여전히 거부한다', () => {
    const r = validateDocument({ type: 'doc', attrs: { schemaVersion: 1, onload: 'x' }, content: [] });
    expect(r.ok).toBe(false);
    expect((r as { errors: string[] }).errors[0]).toContain("허용되지 않는 속성 'onload'");
  });
});

describe('extractText', () => {
  it('블록 경계에 줄바꿈을 넣고 인라인은 이어 붙인다', () => {
    const d = doc(
      { type: 'heading', attrs: { level: 1 }, content: [text('제목')] },
      para(text('첫 '), text('문장'), { type: 'hardBreak' }, text('둘째')),
      { type: 'bulletList', content: [{ type: 'listItem', content: [para(text('항목1'))] }, { type: 'listItem', content: [para(text('항목2'))] }] },
    );
    expect(extractText(d)).toBe('제목\n첫 문장\n둘째\n항목1\n\n항목2');
  });

  it('빈 문서는 빈 문자열', () => {
    expect(extractText(emptyDocument())).toBe('');
  });
});
