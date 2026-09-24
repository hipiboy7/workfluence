import { describe, expect, it } from 'vitest';
import { DOCUMENT_SCHEMA_VERSION } from './constants';
import {
  ALLOWED_CHILDREN,
  ALLOWED_MARKS,
  ALLOWED_NODES,
  MARKS_IN,
  documentSchemaVersion,
  emptyDocument,
  extractText,
  markProblems,
  nodeAttrProblems,
  validateDocument,
  type DocNode,
} from './document';

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
    expect(validateDocument(doc({ type: 'codeBlock', attrs: { language: { nested: true } } })).ok).toBe(false);
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

describe('프로토타입에 있는 이름 (P6 코드 리뷰 2)', () => {
  // `'constructor' in ALLOWED_NODES`가 true라 허용 노드로 통과한 뒤,
  // `ALLOWED_NODES['constructor']`가 배열이 아니라 함수여서 **검증이 오류 목록 대신
  // TypeError를 던졌다.** REST로는 400이 아니라 500이 되고, 실시간 편집에서는
  // 그 예외가 저장 경로를 타고 올라가 프로세스를 죽였다
  it('`constructor`를 노드 종류로 보내면 거부한다 — 던지지 않는다', () => {
    const r = validateDocument({ type: 'doc', attrs: { schemaVersion: DOCUMENT_SCHEMA_VERSION }, content: [{ type: 'constructor' }] });
    expect(r.ok).toBe(false);
  });

  it('`constructor`를 마크로 보내면 거부한다 — 던지지 않는다', () => {
    const r = validateDocument({
      type: 'doc',
      attrs: { schemaVersion: DOCUMENT_SCHEMA_VERSION },
      content: [{ type: 'paragraph', content: [{ type: 'text', text: '글', marks: [{ type: 'constructor', attrs: { x: 1 } }] }] }],
    });
    expect(r.ok).toBe(false);
  });

  it('`taskList`는 더 이상 허용 노드가 아니다 (P7 FR-803)', () => {
    const r = validateDocument({ type: 'doc', attrs: { schemaVersion: DOCUMENT_SCHEMA_VERSION }, content: [{ type: 'taskList' }] });
    expect(r.ok).toBe(false);
  });
});

/**
 * 자리 규칙 (P9_설계서_Gate D.2, FR-1001). **그 자리에 올 수 있는 노드와 마크.**
 *
 * 편집기(ProseMirror)는 스키마의 내용 식을 지키며 문서를 만든다. 조작한 클라이언트는 그 식을 무시할 수 있고, 받은
 * 편집기는 그런 문서를 그린 뒤 그 근처의 편집에서 깨지거나(`listItem`이 문서 맨 위에), **그 블록을 통째로 지운다**
 * (`codeBlock` 안의 굵게 — P9 B.1 실측). 순서와 개수는 보지 않는다(D.8).
 */
describe('자리 규칙 — 그 자리에 올 수 있는 노드와 마크 (P9 FR-1001)', () => {
  it('편집기가 만들 수 있는 중첩은 허용한다', () => {
    const d = doc(
      { type: 'bulletList', content: [{ type: 'listItem', content: [para(text('항목')), { type: 'bulletList', content: [{ type: 'listItem', content: [para(text('안'))] }] }] }] },
      { type: 'blockquote', content: [{ type: 'heading', attrs: { level: 3 }, content: [text('인용 제목')] }] },
      { type: 'table', content: [{ type: 'tableRow', content: [{ type: 'tableCell', content: [{ type: 'orderedList', content: [{ type: 'listItem', content: [para(text('칸 안 목록'))] }] }] }] }] },
      para(text('줄'), { type: 'hardBreak' }, text('바꿈')),
    );
    expect(validateDocument(d)).toEqual({ ok: true });
  });

  it.each([
    ['문서 맨 위의 목록 항목', doc({ type: 'listItem', content: [para(text('x'))] }), "'doc' 안에 올 수 없는 'listItem'"],
    ['문단 안의 문단', doc(para(para(text('x')))), "'paragraph' 안에 올 수 없는 'paragraph'"],
    ['문서 맨 위의 글자', doc(text('x')), "'doc' 안에 올 수 없는 'text'"],
    ['표 줄 밖의 칸', doc({ type: 'tableCell', content: [para(text('c'))] }), "'doc' 안에 올 수 없는 'tableCell'"],
    ['목록 안의 문단(항목 없이)', doc({ type: 'bulletList', content: [para(text('x'))] }), "'bulletList' 안에 올 수 없는 'paragraph'"],
    ['줄바꿈 안의 글자', doc(para({ type: 'hardBreak', content: [text('x')] })), "'hardBreak' 안에 올 수 없는 'text'"],
  ])('그 자리에 올 수 없는 노드를 거부한다 — %s', (_label, d, message) => {
    const r = validateDocument(d);
    expect(r.ok).toBe(false);
    expect((r as { errors: string[] }).errors.some((e) => e.includes(message))).toBe(true);
  });

  it('모르는 노드는 "허용되지 않는 노드" 하나로만 짚는다 — 자리 오류를 겹쳐 내지 않는다', () => {
    const r = validateDocument(doc({ type: 'iframe' }));
    expect((r as { errors: string[] }).errors).toEqual(["doc.content[0]: 허용되지 않는 노드 'iframe'"]);
  });

  it('코드 블록의 글자는 마크를 받지 않는다 — 받은 편집기가 블록을 통째로 지운다 (P9 B.1)', () => {
    const r = validateDocument(doc({ type: 'codeBlock', content: [text('코드', [{ type: 'bold' }])] }));
    expect(r.ok).toBe(false);
    expect((r as { errors: string[] }).errors[0]).toContain("'codeBlock' 안의 글자는 마크 'bold'를 받지 않는다");
    expect(validateDocument(doc({ type: 'codeBlock', content: [text('코드')] }))).toEqual({ ok: true });
  });

  it('자리 규칙의 표는 허용 노드·허용 마크만 가리킨다 — 표끼리 어긋나지 않는다', () => {
    for (const [parent, kids] of Object.entries(ALLOWED_CHILDREN)) {
      expect(Object.hasOwn(ALLOWED_NODES, parent)).toBe(true);
      for (const k of kids) expect(Object.hasOwn(ALLOWED_NODES, k)).toBe(true);
    }
    for (const n of Object.keys(ALLOWED_NODES)) expect(Object.hasOwn(ALLOWED_CHILDREN, n)).toBe(true);
    for (const [holder, marks] of Object.entries(MARKS_IN)) {
      expect(ALLOWED_CHILDREN[holder]).toContain('text');
      for (const m of marks) expect(Object.hasOwn(ALLOWED_MARKS, m)).toBe(true);
    }
    // 글자를 담는 노드는 모두 마크 규칙을 가진다 — 빠진 노드는 "아무 마크나"가 아니라 규칙이 없는 것이다
    for (const [n, kids] of Object.entries(ALLOWED_CHILDREN)) if (kids.includes('text')) expect(Object.hasOwn(MARKS_IN, n)).toBe(true);
  });
});

describe('편집기와 맞춘 속성 (P9 D.7)', () => {
  it('링크의 `title`, 표 칸·표 머리의 `align`을 허용한다 — 편집기가 붙여 넣은 HTML에서 만든다', () => {
    const d = doc(
      para(text('링크', [{ type: 'link', attrs: { href: 'https://example.internal/', title: '설명' } }])),
      {
        type: 'table',
        content: [{ type: 'tableRow', content: [{ type: 'tableHeader', attrs: { align: 'center' }, content: [para(text('h'))] }, { type: 'tableCell', attrs: { align: 'right' }, content: [para(text('c'))] }] }],
      },
    );
    expect(validateDocument(d)).toEqual({ ok: true });
  });

  it('편집기가 만들 수 없는 `textAlign`은 거부한다 — 조작한 클라이언트만 넣는 보이지 않는 속성이다 (보류 22)', () => {
    const r = validateDocument(doc({ type: 'paragraph', attrs: { textAlign: 'center' }, content: [text('x')] }));
    expect((r as { errors: string[] }).errors[0]).toContain("허용되지 않는 속성 'textAlign'");
  });
});

/**
 * 속성·마크 판정 함수 — **정본 검증과 관문이 같이 쓴다** (P9 FR-1001). 둘이 따로 판정하면 "관문은 통과했는데
 * 저장은 실패한다"가 생긴다 — 보류 22가 바로 그것이었다. 까닭에는 **값을 적지 않는다** — 이 글이 경고 로그와
 * 감사로그로 간다(7절: 문서 내용을 기록에 남기지 않는다).
 */
describe('속성·마크 판정 함수 (P9 FR-1001)', () => {
  it('nodeAttrProblems — 허용된 키와 원시값은 문제가 없다', () => {
    expect(nodeAttrProblems('heading', { level: 2 })).toEqual([]);
    expect(nodeAttrProblems('tableCell', { colspan: 2, rowspan: 1, colwidth: [120, 80], align: 'left' })).toEqual([]);
    expect(nodeAttrProblems('paragraph', undefined)).toEqual([]);
  });

  it('nodeAttrProblems — 빈 값(null)은 없는 속성과 같다 (P6 자체 점검 1)', () => {
    expect(nodeAttrProblems('codeBlock', { language: null })).toEqual([]);
    expect(nodeAttrProblems('paragraph', { onclick: null })).toEqual([]);
  });

  it('nodeAttrProblems — 모르는 키, 원시값이 아닌 값, 제목 단계를 짚는다', () => {
    expect(nodeAttrProblems('paragraph', { onclick: 'x()' })).toEqual(["허용되지 않는 속성 'onclick'"]);
    expect(nodeAttrProblems('codeBlock', { language: { a: 1 } })).toEqual(["속성 'language' 값은 원시값 또는 원시값 배열"]);
    expect(nodeAttrProblems('heading', { level: 9 })).toEqual(['heading.level은 1~6']);
    expect(nodeAttrProblems('heading', { level: '2' })).toEqual(['heading.level은 1~6']);
    expect(nodeAttrProblems('paragraph', 'bad')).toEqual(['attrs는 객체']);
  });

  it('nodeAttrProblems — 모르는 노드 종류면 그것을 짚는다. `constructor`도 던지지 않는다', () => {
    expect(nodeAttrProblems('iframe', {})).toEqual(["허용되지 않는 노드 'iframe'"]);
    expect(nodeAttrProblems('constructor', { x: 1 })).toEqual(["허용되지 않는 노드 'constructor'"]);
  });

  it('nodeAttrProblems — 제목은 단계가 있어야 한다. 속성 하나만 볼 때는 `level`이 없어도 된다(관문은 속성을 하나씩 본다)', () => {
    expect(nodeAttrProblems('heading', {})).toEqual(['heading.level은 1~6']);
    expect(nodeAttrProblems('heading', { level: 3 }, { partial: true })).toEqual([]);
    expect(nodeAttrProblems('heading', {}, { partial: true })).toEqual([]);
    // 있는 값은 그래도 본다
    expect(nodeAttrProblems('heading', { level: 9 }, { partial: true })).toEqual(['heading.level은 1~6']);
  });

  it('markProblems — 링크 주소 규칙과 모르는 마크·속성을 짚고, 값은 적지 않는다', () => {
    expect(markProblems('bold', {})).toEqual([]);
    expect(markProblems('link', { href: '/pages/a', target: '_blank', rel: null, class: null, title: null })).toEqual([]);
    expect(markProblems('link', { href: 'javascript:alert(1)' })).toEqual(['허용되지 않는 링크 주소']);
    expect(markProblems('link', { href: 'mailto:a@example.internal' })).toEqual(['허용되지 않는 링크 주소']);
    expect(markProblems('link', {})).toEqual(['허용되지 않는 링크 주소']);
    expect(markProblems('link', { href: '/a', onmouseover: 'x' })).toEqual(["허용되지 않는 속성 'onmouseover'"]);
    expect(markProblems('highlight', {})).toEqual(["허용되지 않는 마크 'highlight'"]);
    expect(markProblems('constructor', {})).toEqual(["허용되지 않는 마크 'constructor'"]);
  });

  it('정본 검증의 링크 오류에도 주소를 적지 않는다 — 그 글이 저장 실패 로그로 간다', () => {
    const r = validateDocument(doc(para(text('l', [{ type: 'link', attrs: { href: 'javascript:secret' } }]))));
    expect((r as { errors: string[] }).errors[0]).not.toContain('secret');
  });
});

