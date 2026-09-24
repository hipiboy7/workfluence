import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { extractText, validateDocument, type DocNode } from '@workfluence/shared';
import { attributedText, COLLAB_FIELD, docFromYDoc, yDocFromDoc } from './ydoc';

/**
 * A등급 — 실시간 상태와 정본 JSON 사이의 변환 (P6_설계서_Collab C.1절).
 *
 * **이 변환이 틀리면 조용히 내용이 사라진다.** 저장은 성공하고 버전도 생기는데
 * 안에 든 것이 다르다. 그래서 테스트의 축은 **왕복**이다 — 넣은 것이 그대로 나오는가.
 */

const doc = (...c: DocNode[]): DocNode => ({ type: 'doc', attrs: { schemaVersion: 1 }, content: c });
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

  it('빈 문서', () => {
    expect(roundTrip(doc())).toEqual(doc());
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
  it('아무것도 없는 Y.Doc은 빈 문서다 — `null`이나 예외가 아니다', () => {
    expect(docFromYDoc(new Y.Doc())).toEqual(doc());
  });
});

describe('경계 — 변환이 조용히 틀리지 않게', () => {
  it('마크가 빈 배열이면 마크 없는 글자다', () => {
    expect(roundTrip(doc(p(t('글', []))))).toEqual(doc(p(t('글'))));
  });

  it('**속성이 `undefined`면 넣지 않는다** — Yjs가 문자열 `"undefined"`로 굳힌다', () => {
    const d: DocNode = { type: 'doc', attrs: { schemaVersion: 1 }, content: [{ type: 'heading', attrs: { level: 2, textAlign: undefined }, content: [t('제목')] }] };
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
    expect(roundTrip(noVersion).attrs).toEqual({ schemaVersion: 1 });
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
      attrs: { schemaVersion: 1 },
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
      attrs: { schemaVersion: 1 },
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
});

/**
 * `attributedText` — 글자마다 넣은 사람을 붙인 본문 (P8_설계서_Mention C.3절, FR-900).
 *
 * 축은 둘이다. ① **`extractText`와 같은 글자열**이어야 한다 — 한쪽이 찾은 멘션을 다른 쪽이
 * 못 찾으면 그 멘션은 조용히 "모름"이 된다. ② 글자의 작성자는 **그 글자를 넣은 클라이언트**다.
 */
describe('attributedText — 글자마다 넣은 사람', () => {
  /** `extractText`의 마지막 정리. 멘션 판정은 이 정리 전후로 같다 (C.3절) */
  const normalize = (s: string): string => s.replace(/\n{3,}/g, '\n\n').trim();
  const who = (ydoc: Y.Doc, names: Record<number, string>) => attributedText(ydoc, (c) => names[c] ?? null);

  /** 다른 클라이언트가 붙어 `edit`를 하고, 그 변경을 원래 문서에 적용한다 */
  function editAs(target: Y.Doc, edit: (frag: Y.XmlFragment) => void): number {
    const client = new Y.Doc();
    Y.applyUpdate(client, Y.encodeStateAsUpdate(target));
    edit(client.getXmlFragment(COLLAB_FIELD));
    Y.applyUpdate(target, Y.encodeStateAsUpdate(client, Y.encodeStateVector(target)));
    return client.clientID;
  }
  const firstText = (frag: Y.XmlFragment): Y.XmlText => (frag.get(0) as Y.XmlElement).get(0) as Y.XmlText;

  it('**`extractText`와 같은 글자열을 만든다** — 블록·줄바꿈·중첩·표·마크까지', () => {
    const samples: DocNode[] = [
      doc(p(t('안녕 @kim'))),
      doc({ type: 'heading', attrs: { level: 1 }, content: [t('제목')] }, p(t('본문')), { type: 'horizontalRule' }, p(t('끝'))),
      doc(p(t('윗줄'), { type: 'hardBreak' }, t('@lee 아랫줄'))),
      doc(p(t('굵게', [{ type: 'bold' }]), t(' @park'), t('링크', [{ type: 'link', attrs: { href: '/a' } }]))),
      doc({ type: 'bulletList', content: [{ type: 'listItem', content: [p(t('항목 @a1'))] }, { type: 'listItem', content: [p(t('둘'))] }] }),
      doc({ type: 'table', content: [{ type: 'tableRow', content: [{ type: 'tableCell', content: [p(t('칸'))] }, { type: 'tableCell', content: [p(t('@b2'))] }] }] }),
      doc({ type: 'blockquote', content: [p(t('인용'))] }, { type: 'codeBlock', content: [t('code @x')] }),
      doc(p(), p(), p(), p(t('빈 문단 뒤'))),
      doc(),
    ];
    for (const d of samples) {
      const ydoc = yDocFromDoc(d);
      const got = who(ydoc, {});
      expect(normalize(got.text)).toBe(extractText(docFromYDoc(ydoc)));
      expect(got.authors).toHaveLength(got.text.length);
    }
  });

  it('처음 문서의 글자는 방(서버)의 클라이언트가 넣은 것이다', () => {
    const ydoc = yDocFromDoc(doc(p(t('@kim'))));
    const got = who(ydoc, { [ydoc.clientID]: 'server' });
    expect(got.text).toBe('@kim\n');
    expect(got.authors).toEqual(['server', 'server', 'server', 'server', null]);
  });

  it('**다른 클라이언트가 넣은 글자는 그 클라이언트의 것이다**', () => {
    const ydoc = yDocFromDoc(doc(p(t('가나'))));
    const b = editAs(ydoc, (f) => firstText(f).insert(2, ' @lee'));
    const got = who(ydoc, { [ydoc.clientID]: 'A', [b]: 'B' });
    expect(got.text).toBe('가나 @lee\n');
    expect(got.authors.slice(0, 7)).toEqual(['A', 'A', 'B', 'B', 'B', 'B', 'B']);
  });

  it('**남이 서식을 걸어도 글자의 주인은 그대로다** — 굵게는 글자를 새로 만들지 않는다', () => {
    const ydoc = yDocFromDoc(doc(p(t('@kim 확인'))));
    editAs(ydoc, (f) => firstText(f).format(0, 4, { bold: {} }));
    const got = who(ydoc, { [ydoc.clientID]: 'A' });
    expect(got.authors.slice(0, 4)).toEqual(['A', 'A', 'A', 'A']);
  });

  it('지운 글자는 들어오지 않는다', () => {
    const ydoc = yDocFromDoc(doc(p(t('@kim 지울말'))));
    editAs(ydoc, (f) => firstText(f).delete(4, 4));
    const got = who(ydoc, { [ydoc.clientID]: 'A' });
    expect(got.text).toBe('@kim\n');
  });

  it('모르는 클라이언트의 글자는 `null`이다', () => {
    const ydoc = yDocFromDoc(doc(p(t('ab'))));
    expect(who(ydoc, {}).authors).toEqual([null, null, null]);
  });

  it('**글자가 아닌 끼워 넣기(embed)는 건너뛴다** — `docFromYDoc`도 버린다', () => {
    const ydoc = yDocFromDoc(doc(p(t('ab'))));
    firstText(ydoc.getXmlFragment(COLLAB_FIELD)).insertEmbed(1, { image: 'x' });
    const got = who(ydoc, {});
    expect(got.text).toBe('ab\n');
    expect(normalize(got.text)).toBe(extractText(docFromYDoc(ydoc)));
  });
});
