import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { validateDocument, type DocNode, DOCUMENT_SCHEMA_VERSION } from '@workfluence/shared';
import { extractMentions, scanMentions } from '../../notifications/domain/mention';
import { COLLAB_FIELD, docFromYDoc, mentionSites, yDocFromDoc } from './ydoc';

/**
 * A등급 — 실시간 상태와 정본 JSON 사이의 변환 (P6_설계서_Collab C.1절).
 *
 * **이 변환이 틀리면 조용히 내용이 사라진다.** 저장은 성공하고 버전도 생기는데
 * 안에 든 것이 다르다. 그래서 테스트의 축은 **왕복**이다 — 넣은 것이 그대로 나오는가.
 */

const doc = (...c: DocNode[]): DocNode => ({ type: 'doc', attrs: { schemaVersion: DOCUMENT_SCHEMA_VERSION }, content: c });
// **빈 문단에는 `content` 키를 넣지 않는다.** `emptyDocument()`가 그렇게 만들고
// 편집기도 그렇게 낸다 — 왕복이 `content: []`를 만들어 내면 정본의 모양이 달라진다
const p = (...c: DocNode[]): DocNode => (c.length ? { type: 'paragraph', content: c } : { type: 'paragraph' });
const tx = (text: string, marks?: { type: string; attrs?: Record<string, unknown> }[]): DocNode =>
  marks ? { type: 'text', text, marks } : { type: 'text', text };

const t = tx;
const roundTrip = (d: DocNode): DocNode => docFromYDoc(yDocFromDoc(d));

describe('왕복 — 넣은 것이 그대로 나온다', () => {
  it('문단 하나', () => {
    expect(roundTrip(doc(p(t('안녕'))))).toEqual(doc(p(t('안녕'))));
  });

  it('여러 블록과 속성', () => {
    const d = doc({ type: 'heading', attrs: { level: 2 }, content: [t('제목')] }, p(t('본문')), { type: 'horizontalRule' });
    expect(roundTrip(d)).toEqual(d);
  });

  it('마크가 붙은 글자', () => {
    const d = doc(p(t('굵게', [{ type: 'bold' }]), t(' 보통 '), t('링크', [{ type: 'link', attrs: { href: '/a' } }])));
    expect(roundTrip(d)).toEqual(d);
  });

  it('중첩된 목록과 표', () => {
    const d = doc(
      { type: 'bulletList', content: [{ type: 'listItem', content: [p(t('항목'))] }] },
      { type: 'table', content: [{ type: 'tableRow', content: [{ type: 'tableCell', attrs: { colspan: 2 }, content: [p(t('칸'))] }] }] },
    );
    expect(roundTrip(d)).toEqual(d);
  });

  it('빈 문단', () => {
    expect(roundTrip(doc(p()))).toEqual(doc(p()));
  });

  it('빈 문서는 빈 문단 하나로 읽는다 — 편집기가 그렇게 그린다 (P12 FR-1313)', () => {
    expect(roundTrip(doc())).toEqual(doc(p()));
  });

  it('**한글과 이모지가 깨지지 않는다** — 문자 단위 오프셋이 틀리면 여기서 드러난다', () => {
    const d = doc(p(t('회의록 📄 초안')));
    expect(roundTrip(d)).toEqual(d);
  });
});

describe('실시간 상태로서 동작한다', () => {
  it('**다른 Y.Doc에 변경을 적용해도 같은 문서가 된다** — 중계가 하는 일이 이것이다', () => {
    const a = yDocFromDoc(doc(p(t('처음'))));
    const b = new Y.Doc();
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
    expect(docFromYDoc(b)).toEqual(doc(p(t('처음'))));
  });

  it('두 쪽에서 각각 고친 것이 **둘 다 남는다** — 이것이 실시간 편집의 전부다', () => {
    const a = yDocFromDoc(doc(p(t('공통'))));
    const b = new Y.Doc();
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));

    a.getXmlFragment(COLLAB_FIELD).push([new Y.XmlElement('paragraph')]);
    b.getXmlFragment(COLLAB_FIELD).push([new Y.XmlElement('horizontalRule')]);

    Y.applyUpdate(a, Y.encodeStateAsUpdate(b));
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));

    const types = (docFromYDoc(a).content ?? []).map((n) => n.type);
    expect(types).toContain('paragraph');
    expect(types).toContain('horizontalRule');
    expect(docFromYDoc(a)).toEqual(docFromYDoc(b));
  });

  it('상태를 이진으로 저장했다 되살려도 같다 — DB에 넣는 것이 이 바이트다', () => {
    const a = yDocFromDoc(doc(p(t('저장'))));
    const bytes = Buffer.from(Y.encodeStateAsUpdate(a));
    const b = new Y.Doc();
    Y.applyUpdate(b, bytes);
    expect(docFromYDoc(b)).toEqual(doc(p(t('저장'))));
  });
});

describe('빈 상태에서 읽기', () => {
  it('아무것도 없는 Y.Doc은 빈 문단 하나다 — `null`이나 예외가 아니다. 편집기가 그리는 모양이고 정본 검증을 지난다', () => {
    expect(docFromYDoc(new Y.Doc())).toEqual(doc(p()));
    expect(validateDocument(docFromYDoc(new Y.Doc()))).toEqual({ ok: true });
  });
});

/**
 * **편집기처럼 읽는다** (P12 FR-1313, 보류 25). 열린 편집기(y-tiptap)는 순서·개수를 어긴 요소를 노드로 만들지 못해 공유 문서에서 지우고,
 * 이웃은 남긴다(설계서 C.2 실측). 정본은 편집기가 보는 모양을 적는다 — 어긴 요소는 떨어뜨리고, 비게 된 부모도 떨어뜨린다
 */
describe('편집기처럼 읽는다 — 순서·개수를 어긴 요소 (P12 FR-1313)', () => {
  const li = (...c: DocNode[]): DocNode => ({ type: 'listItem', content: c });
  const list = (...c: DocNode[]): DocNode => ({ type: 'bulletList', content: c });
  const quote = (...c: DocNode[]): DocNode => ({ type: 'blockquote', content: c });
  const cell = (...c: DocNode[]): DocNode => ({ type: 'tableCell', attrs: { colspan: 1, rowspan: 1 }, content: c });
  const table = (...cells: DocNode[]): DocNode => ({ type: 'table', content: [{ type: 'tableRow', content: cells }] });

  it('**인용으로 시작하는 목록 항목은 떨어뜨린다** — 같은 목록의 다른 항목은 남는다', () => {
    const read = roundTrip(doc(list(li(p(t('남의 글 1'))), li(quote(p(t('조작')))), li(p(t('남의 글 2'))))));
    expect(read).toEqual(doc(list(li(p(t('남의 글 1'))), li(p(t('남의 글 2'))))));
  });

  it('빈 인용·빈 목록 항목·빈 표 칸은 떨어뜨린다 — **비게 된 부모도** (목록 → 떨어뜨림, 줄은 칸이 없어도 된다)', () => {
    expect(roundTrip(doc(quote(), p(t('끝'))))).toEqual(doc(p(t('끝'))));
    expect(roundTrip(doc(list(li()), p(t('끝'))))).toEqual(doc(p(t('끝'))));
    expect(roundTrip(doc(quote(p(t('남의 인용')), quote())))).toEqual(doc(quote(p(t('남의 인용')))));
    expect(roundTrip(doc(table(cell(p(t('남의 칸'))), cell()), p(t('끝'))))).toEqual(doc(table(cell(p(t('남의 칸')))), p(t('끝'))));
    expect(roundTrip(doc(table(cell()), p(t('끝'))))).toEqual(doc({ type: 'table', content: [{ type: 'tableRow' }] }, p(t('끝'))));
  });

  it('**모두 떨어뜨려 비면 빈 문단 하나** — 읽은 문서는 늘 정본 검증을 지난다', () => {
    const read = roundTrip(doc(list(li(quote(p(t('조작')))))));
    expect(read).toEqual(doc(p()));
    for (const d of [read, roundTrip(doc(table(cell()))), roundTrip(doc(quote(quote())))]) expect(validateDocument(d)).toEqual({ ok: true });
  });
});

describe('경계 — 변환이 조용히 틀리지 않게', () => {
  it('마크가 빈 배열이면 마크 없는 글자다', () => {
    expect(roundTrip(doc(p(t('글', []))))).toEqual(doc(p(t('글'))));
  });

  it('**속성이 `undefined`면 넣지 않는다** — Yjs가 문자열 `"undefined"`로 굳힌다', () => {
    const d: DocNode = { type: 'doc', attrs: { schemaVersion: DOCUMENT_SCHEMA_VERSION }, content: [{ type: 'heading', attrs: { level: 2, textAlign: undefined }, content: [t('제목')] }] };
    const back = roundTrip(d);
    expect(back.content![0].attrs).toEqual({ level: 2 });
  });

  it('빈 글자 노드는 사라진다 — 넣을 것이 없다', () => {
    expect(roundTrip(doc(p(t(''))))).toEqual(doc(p()));
  });

  it('속성이 없는 블록은 `attrs` 키가 생기지 않는다', () => {
    const back = roundTrip(doc(p(t('가'))));
    expect(back.content![0]).not.toHaveProperty('attrs');
  });

  it('**`schemaVersion`을 다시 찍는다** — 실시간 상태에는 그것이 없다', () => {
    const noVersion: DocNode = { type: 'doc', content: [p(t('가'))] };
    expect(roundTrip(noVersion).attrs).toEqual({ schemaVersion: DOCUMENT_SCHEMA_VERSION });
  });
});

describe('경계 — 서식 값이 이상할 때', () => {
  it('서식 값이 `null`인 것은 마크로 만들지 않는다 — 다른 편집기가 그렇게 보낼 수 있다', () => {
    const ydoc = new Y.Doc();
    const el = new Y.XmlElement('paragraph');
    const text = new Y.XmlText();
    text.insert(0, '글자', { bold: {}, italic: null as never });
    el.push([text]);
    ydoc.getXmlFragment(COLLAB_FIELD).push([el]);
    expect(docFromYDoc(ydoc)).toEqual(doc(p(t('글자', [{ type: 'bold' }]))));
  });
});

describe('**편집기가 만들지 않는 노드**가 들어와도 던지지 않는다 (P8 세 번째 검토 2)', () => {
  /**
   * 조작한 클라이언트는 문서에 `Y.XmlHook`·`Y.Text`·`Y.Map`을 자식으로 넣을 수 있다. 예전에는 여기서 던져
   * **그 페이지의 자동 저장이 영영 실패했고**(P6부터), 멘션 자리를 훑는 관찰자가 던져 **방의 중계가 멈췄다**(P8).
   * 그런 노드는 정본 JSON에 뜻이 없다 — 버린다.
   */
  const withForeign = (make: () => unknown): Y.Doc => {
    const ydoc = yDocFromDoc(doc(p(t('앞 @kim'))));
    const frag = ydoc.getXmlFragment(COLLAB_FIELD);
    frag.insert(1, [make() as never]);
    const para = frag.get(0) as Y.XmlElement;
    para.insert(para.length, [make() as never]);
    return ydoc;
  };

  for (const [label, make] of [
    ['XmlHook', () => new Y.XmlHook('hook')],
    ['Text', () => new Y.Text('글')],
    ['Map', () => new Y.Map()],
  ] as const) {
    it(`${label} — 정본에서는 빠지고, 멘션 자리는 그대로 찾는다`, () => {
      const ydoc = withForeign(make);
      expect(docFromYDoc(ydoc)).toEqual(doc(p(t('앞 @kim'))));
      expect(mentionSites(ydoc, scanMentions).map((s) => s.name)).toEqual(['kim']);
    });
  }
});

describe('경계 — 값이 아예 없을 때', () => {
  it('`text` 키가 없는 글자 노드도 터지지 않는다', () => {
    expect(roundTrip(doc(p({ type: 'text' })))).toEqual(doc(p()));
  });

  it('속성이 `undefined`인 마크는 버린다', () => {
    const ydoc = new Y.Doc();
    const el = new Y.XmlElement('paragraph');
    const text = new Y.XmlText();
    text.insert(0, '가', { bold: undefined as never });
    el.push([text]);
    ydoc.getXmlFragment(COLLAB_FIELD).push([el]);
    expect(docFromYDoc(ydoc)).toEqual(doc(p(t('가'))));
  });
});

/**
 * **편집기가 실제로 만드는 모양** (P6 자체 점검 1·2·18).
 *
 * 이 셋은 왕복 테스트를 전부 통과하면서도 운영에서 편집을 통째로 잃게 하던 것들이다.
 * 서버끼리의 왕복만 보면 안 보인다 — **편집기가 붙이는 것**을 넣어 봐야 한다.
 */
describe('편집기가 붙이는 것들', () => {
  it('**링크의 `title: null`이 검증을 막지 않는다** — 이것 때문에 링크 있는 문서는 버전이 안 생겼다', () => {
    const withLink: DocNode = {
      type: 'doc',
      attrs: { schemaVersion: DOCUMENT_SCHEMA_VERSION },
      content: [{ type: 'paragraph', content: [{ type: 'text', text: '보기', marks: [{ type: 'link', attrs: { href: '/a', title: null, target: null } }] }] }],
    };
    const back = roundTrip(withLink);
    expect(validateDocument(back).ok).toBe(true);
    // 빈 값은 떨어뜨린다 — 남기면 REST 저장본과 협업 저장본이 "글자는 같은데 다른" 문서가 된다
    expect(back.content![0].content![0].marks![0].attrs).toEqual({ href: '/a' });
  });

  it('표 칸의 `align: null`도 마찬가지다', () => {
    const t: DocNode = {
      type: 'doc',
      attrs: { schemaVersion: DOCUMENT_SCHEMA_VERSION },
      content: [{ type: 'table', content: [{ type: 'tableRow', content: [{ type: 'tableCell', attrs: { colspan: 1, align: null }, content: [p(tx('칸'))] }] }] }],
    };
    expect(validateDocument(roundTrip(t)).ok).toBe(true);
  });

  it('**연속된 글자는 `Y.XmlText` 하나로 묶인다** — 나뉘어 있으면 동시 편집에서 글자가 복제된다', () => {
    const d = doc(p(tx('앞'), tx('뒤')));
    const y = yDocFromDoc(d);
    const kids = y.getXmlFragment(COLLAB_FIELD).toArray()[0] as Y.XmlElement;
    expect(kids.toArray().length).toBe(1);
    expect(docFromYDoc(y).content![0].content).toEqual([{ type: 'text', text: '앞뒤' }]);
  });

  it('서식이 다른 글자는 묶여도 **서식이 번지지 않는다**', () => {
    const d = doc(p(tx('굵게', [{ type: 'bold' }]), tx('보통')));
    const back = roundTrip(d);
    expect(back.content![0].content).toEqual([
      { type: 'text', text: '굵게', marks: [{ type: 'bold' }] },
      { type: 'text', text: '보통' },
    ]);
  });

  it('**단계가 없는 제목은 편집기처럼 1단계로 읽는다** — 조작한 클라이언트가 `level`만 지우면 화면은 1단계를 보이는데 저장은 "단계 없음"으로 멈췄다 (P9 D.2, 보류 22)', () => {
    const y = new Y.Doc();
    const h = new Y.XmlElement('heading');
    const text = new Y.XmlText();
    h.insert(0, [text]);
    text.insert(0, '단계 없는 제목');
    y.getXmlFragment(COLLAB_FIELD).insert(0, [h]);
    const back = docFromYDoc(y);
    expect(back.content).toEqual([{ type: 'heading', attrs: { level: 1 }, content: [tx('단계 없는 제목')] }]);
    expect(validateDocument(back).ok).toBe(true);
  });
});

/**
 * `mentionSites` — 문서의 멘션 자리 (P8_설계서_Mention C.2절).
 *
 * 멘션 하나를 **`@` 글자의 ID + 이름**으로 가린다. 축은 둘이다. ① **`extractMentions`와 같은 이름을**
 * 찾아야 한다 — 한쪽이 찾은 멘션을 다른 쪽이 못 찾으면 그 멘션은 조용히 "모름"이 된다. ② 자리는
 * **글자의 ID**다 — 위치(몇 번째 글자)는 앞에 누가 치기만 해도 바뀐다.
 */
describe('mentionSites — 멘션 자리', () => {
  const sites = (ydoc: Y.Doc) => mentionSites(ydoc, scanMentions);
  const firstText = (ydoc: Y.Doc): Y.XmlText => (ydoc.getXmlFragment(COLLAB_FIELD).get(0) as Y.XmlElement).get(0) as Y.XmlText;

  it('**`extractMentions`와 같은 이름을 같은 순서로 찾는다** — 블록·줄바꿈·중첩·표·마크까지', () => {
    const samples: DocNode[] = [
      doc(p(t('안녕 @kim'))),
      doc(p(t('윗줄'), { type: 'hardBreak' }, t('@lee 아랫줄'))),
      doc(p(t('굵게', [{ type: 'bold' }]), t(' @park'), t('링크', [{ type: 'link', attrs: { href: '/a' } }]))),
      doc({ type: 'bulletList', content: [{ type: 'listItem', content: [p(t('항목 @a1'))] }, { type: 'listItem', content: [p(t('@b2.'))] }] }),
      doc({ type: 'table', content: [{ type: 'tableRow', content: [{ type: 'tableCell', content: [p(t('칸'))] }, { type: 'tableCell', content: [p(t('@c3'))] }] }] }),
      doc({ type: 'blockquote', content: [p(t('인용 kim@example.internal'))] }, { type: 'codeBlock', content: [t('code @x1')] }),
      doc(p(), p(), p(), p(t('빈 문단 뒤 @kim @kim'))),
      doc(),
    ];
    for (const d of samples) {
      const ydoc = yDocFromDoc(d);
      expect([...new Set(sites(ydoc).map((s) => s.name))]).toEqual(extractMentions(docFromYDoc(ydoc)));
    }
  });

  it('**자리는 `@` 글자의 ID다** — 앞에 글자를 넣어도 바뀌지 않는다', () => {
    const ydoc = yDocFromDoc(doc(p(t('hi @kim'))));
    const [before] = sites(ydoc);
    expect(before.name).toBe('kim');
    expect(before.key).toMatch(new RegExp(`^${ydoc.clientID}:\\d+$`));
    // 자리의 글자들 — `@`부터 이름 끝까지. 첫 글자가 곧 자리다
    expect(before.span).toHaveLength(4);
    expect(`${before.span[0][0]}:${before.span[0][1]}`).toBe(before.key);
    firstText(ydoc).insert(0, '앞에 넣은 글 ');
    expect(sites(ydoc)).toEqual([before]);
  });

  it('같은 이름이 여러 곳이면 **곳마다** 낸다. 뒤쪽 구분자를 뗀 후보도 같은 자리다', () => {
    const ydoc = yDocFromDoc(doc(p(t('@kim. 그리고 @kim'))));
    expect(sites(ydoc).map((s) => s.name)).toEqual(['kim.', 'kim', 'kim']);
    expect(sites(ydoc)[0].key).toBe(sites(ydoc)[1].key);
  });

  it('지운 글자·서식·끼워 넣기(embed)는 글자가 아니다', () => {
    const ydoc = yDocFromDoc(doc(p(t('x@kim 확인'))));
    expect(sites(ydoc)).toEqual([]);
    firstText(ydoc).delete(0, 1); // `x`를 지우면 멘션이 된다
    firstText(ydoc).format(0, 4, { bold: {} });
    firstText(ydoc).insertEmbed(4, { image: 'x' });
    expect(sites(ydoc).map((s) => s.name)).toEqual(['kim']);
  });

  it('빈 문서는 빈 목록이다', () => {
    expect(sites(new Y.Doc())).toEqual([]);
  });
});
