import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { MAX_DOCUMENT_DEPTH, validateDocument } from '@workfluence/shared';
import { inspectUpdate, integrable, type GateVerdict } from './gate';
import { docFromYDoc } from './ydoc';

/**
 * A등급 — 실시간 편집의 관문 (P9_설계서_Gate D.2~D.4, FR-1000~1003).
 *
 * 멤버가 보낸 변경을 **적용하기 전에** 서버 문서에 대어 보고, 편집기가 만들 수 있는 모양이 아니면 받지 않는다.
 * 관문은 판정만 한다 — 서버 문서를 고치지 않는다. 받지 않은 뒤의 일(끊기·기록)은 게이트웨이가 한다.
 *
 * 시험의 변경은 **화면처럼** 만든다: 서버에서 받은 것을 든 문서에서 로컬 트랜잭션 하나를 하고, 그 트랜잭션의
 * `update` 이벤트를 보낸다(`collabLink.ts`). 조작한 변경은 Yjs API로 편집기가 하지 않는 일을 해서 만든다.
 */

const U = '00000000-0000-4000-8000-00000000000a';
const X = '00000000-0000-4000-8000-00000000000b';

/** 서버 문서 — 정본에서 만든 방처럼 서버 클라이언트가 만든 문단 하나 */
function server(): Y.Doc {
  const d = new Y.Doc();
  d.getXmlFragment('default').insert(0, [para('앞 문단')]);
  return d;
}
/** 서버에서 받은 것을 든 화면 문서 */
function screen(from: Y.Doc): Y.Doc {
  const d = new Y.Doc();
  Y.applyUpdate(d, Y.encodeStateAsUpdate(from), 'remote');
  return d;
}
/** 화면의 로컬 트랜잭션 하나가 보내는 변경 */
function change(d: Y.Doc, fn: (f: Y.XmlFragment, d: Y.Doc) => void): Uint8Array {
  let out: Uint8Array | null = null;
  const on = (u: Uint8Array, origin: unknown): void => {
    if (origin !== 'remote') out = u;
  };
  d.on('update', on);
  d.transact(() => fn(d.getXmlFragment('default'), d));
  d.off('update', on);
  if (!out) throw new Error('변경이 없다');
  return out;
}
/** 게이트웨이처럼 변경의 바이트까지 넘긴다 — 목록 항목의 첫 자식은 적용한 뒤를 흉내 내야 보인다 (P12 보안 검토 1) */
const judge = (srv: Y.Doc, update: Uint8Array, sender = U, owners = new Map<number, string>()): GateVerdict =>
  inspectUpdate(Y.decodeUpdate(update), srv, sender, owners, update);
/** 게이트웨이처럼 — 판정하고, 지나면 묶고 적용한다 */
function pass(srv: Y.Doc, update: Uint8Array, owners: Map<number, string>, sender = U): GateVerdict {
  const v = inspectUpdate(Y.decodeUpdate(update), srv, sender, owners, update);
  if (v.ok) {
    if (v.bind !== null) owners.set(v.bind, sender);
    Y.applyUpdate(srv, update);
  }
  return v;
}
function para(text: string, name = 'paragraph'): Y.XmlElement {
  const p = new Y.XmlElement(name);
  const t = new Y.XmlText();
  p.insert(0, [t]);
  if (text) t.insert(0, text);
  return p;
}
const firstText = (f: Y.XmlFragment): Y.XmlText => (f.get(0) as Y.XmlElement).get(0) as Y.XmlText;
const lastText = (f: Y.XmlFragment): Y.XmlText => (f.get(f.length - 1) as Y.XmlElement).get(0) as Y.XmlText;
const refused = (v: GateVerdict): { rule: string; reason: string } => {
  expect(v.ok).toBe(false);
  return v as { ok: false; rule: string; reason: string };
};

describe('구조 — 편집기가 만드는 모양은 지난다 (FR-1009)', () => {
  it('새 문단을 만든다 — 그 연결의 첫 조각이라 클라이언트를 보낸 사람에게 묶는다', () => {
    const srv = server();
    const s = screen(srv);
    const v = judge(srv, change(s, (f) => f.insert(f.length, [para('새 글')])));
    expect(v).toEqual({ ok: true, bind: s.clientID });
  });

  it('있는 글자 사이에 친다 · 지우기만 한다 · 한 트랜잭션에서 치고 지운다 — 차례로 적용하며', () => {
    const srv = server();
    const s = screen(srv);
    const owners = new Map<number, string>();
    expect(pass(srv, change(s, (f) => firstText(f).insert(2, '가')), owners)).toEqual({ ok: true, bind: s.clientID });
    expect(pass(srv, change(s, (f) => firstText(f).delete(0, 1)), owners)).toEqual({ ok: true, bind: null });
    const v = pass(
      srv,
      change(s, (f) => {
        firstText(f).insert(0, '잠깐');
        firstText(f).delete(0, 2);
      }),
      owners,
    );
    expect(v).toEqual({ ok: true, bind: null });
    expect(srv.getXmlFragment('default').toString()).toBe(s.getXmlFragment('default').toString());
  });

  it('제목과 단계 · 굵게 · 서식 끝 · 링크(빈 속성 포함)', () => {
    const srv = server();
    const s = screen(srv);
    const u = change(s, (f) => {
      const h = para('제목', 'heading');
      h.setAttribute('level', 2 as never);
      f.insert(f.length, [h]);
      const t = firstText(f);
      t.format(0, 2, { bold: {} });
      t.format(0, 1, { bold: null });
      t.format(1, 2, { link: { href: 'https://example.internal/a', target: '_blank', rel: 'noopener noreferrer nofollow', class: null, title: null } });
    });
    expect(judge(srv, u).ok).toBe(true);
  });

  it('목록 · 인용 · 표 · 줄바꿈 · 코드 블록', () => {
    const srv = server();
    const s = screen(srv);
    const u = change(s, (f) => {
      const li = new Y.XmlElement('listItem');
      li.insert(0, [para('항목')]);
      const ul = new Y.XmlElement('bulletList');
      ul.insert(0, [li]);
      const quote = new Y.XmlElement('blockquote');
      quote.insert(0, [para('인용')]);
      const cell = new Y.XmlElement('tableCell');
      cell.setAttribute('colspan', 1 as never);
      cell.setAttribute('colwidth', [120] as never);
      cell.setAttribute('align', 'center' as never);
      cell.insert(0, [para('칸')]);
      const row = new Y.XmlElement('tableRow');
      row.insert(0, [cell]);
      const table = new Y.XmlElement('table');
      table.insert(0, [row]);
      const withBreak = new Y.XmlElement('paragraph');
      const t1 = new Y.XmlText();
      const t2 = new Y.XmlText();
      withBreak.insert(0, [t1, new Y.XmlElement('hardBreak'), t2]);
      t1.insert(0, '줄');
      t2.insert(0, '바꿈');
      const code = para('let x = 1', 'codeBlock');
      code.setAttribute('language', 'ts' as never);
      f.insert(f.length, [ul, quote, table, withBreak, code]);
    });
    expect(judge(srv, u).ok).toBe(true);
  });

  it('이미 서버에서 치워진(GC) 문단 안으로 들어오는 글자는 보지 않는다 — Yjs가 그 글자를 버린다 (정상 동시 편집, P8 실측)', () => {
    const srv = server();
    const s = screen(srv);
    // 서버에서 누가 그 문단을 지웠다 — 문단 안의 글자는 GC된다. s는 아직 모른다
    srv.transact(() => srv.getXmlFragment('default').delete(0, 1));
    const u = change(s, (f) => firstText(f).insert(1, '늦은 글자'));
    expect(judge(srv, u).ok).toBe(true);
  });
});

describe('구조 — 편집기가 만들지 않는 Yjs 타입·내용·자리는 받지 않는다 (보류 23, FR-1000)', () => {
  it.each<[string, (f: Y.XmlFragment, d: Y.Doc) => void, string]>([
    ['문서 맨 위의 Y.XmlHook', (f) => f.insert(f.length, [new Y.XmlHook('evil') as never]), "편집기가 만들지 않는 타입 'XmlHook'"],
    [
      '문서 맨 위의 Y.XmlText',
      (f) => {
        const t = new Y.XmlText();
        f.insert(f.length, [t]);
        t.insert(0, '맨 위 글자');
      },
      "'doc' 안에 올 수 없는 'text'",
    ],
    ['문단 안의 Y.Map', (f) => (f.get(0) as Y.XmlElement).insert(0, [new Y.Map() as never]), "편집기가 만들지 않는 타입 'Map'"],
    ['문단 안의 Y.Text', (f) => (f.get(0) as Y.XmlElement).insert(0, [new Y.Text() as never]), "편집기가 만들지 않는 타입 'Text'"],
    ['문단 안의 Y.Array', (f) => (f.get(0) as Y.XmlElement).insert(0, [new Y.Array() as never]), "편집기가 만들지 않는 타입 'Array'"],
    ['글자 조각에 끼워 넣은 객체', (f) => firstText(f).insertEmbed(1, { evil: 1 }), "편집기가 만들지 않는 내용 'Embed'"],
    ['글자 조각에 끼워 넣은 요소', (f) => firstText(f).insertEmbed(1, new Y.XmlElement('paragraph')), "'text' 안에 올 수 없는 'paragraph'"],
    ['이진 값 속성', (f) => (f.get(0) as Y.XmlElement).setAttribute('x', new Uint8Array([1]) as never), "편집기가 만들지 않는 내용 'Binary'"],
    ['하위 문서 속성', (f) => (f.get(0) as Y.XmlElement).setAttribute('x', new Y.Doc() as never), "편집기가 만들지 않는 내용 'Doc'"],
    ['글자 조각의 속성', (f) => firstText(f).setAttribute('x', 'y'), '글자 조각에 속성'],
    ['다른 이름의 최상위 타입', (_f, d) => d.getText('evil').insert(0, 'x'), "최상위 타입 'evil'"],
  ])('%s', (_label, fn, reason) => {
    const srv = server();
    const v = refused(judge(srv, change(screen(srv), fn)));
    expect(v.rule).toBe('structure');
    expect(v.reason).toContain(reason);
  });
});

describe('구조 — 허용 목록 밖은 받지 않는다 (보류 22, FR-1001)', () => {
  it.each<[string, (f: Y.XmlFragment) => void, string]>([
    ['모르는 요소', (f) => f.insert(f.length, [para('x', 'script')]), "'doc' 안에 올 수 없는 'script'"],
    ['요소 이름 text', (f) => f.insert(f.length, [new Y.XmlElement('text')]), "'doc' 안에 올 수 없는 'text'"],
    ['요소 이름 doc', (f) => f.insert(f.length, [new Y.XmlElement('doc')]), "'doc' 안에 올 수 없는 'doc'"],
    ['문서 맨 위의 목록 항목', (f) => f.insert(f.length, [new Y.XmlElement('listItem')]), "'doc' 안에 올 수 없는 'listItem'"],
    ['문단 안의 문단', (f) => (f.get(0) as Y.XmlElement).insert(0, [para('안')]), "'paragraph' 안에 올 수 없는 'paragraph'"],
    ['표 줄 밖의 칸', (f) => f.insert(f.length, [new Y.XmlElement('tableCell')]), "'doc' 안에 올 수 없는 'tableCell'"],
    ['모르는 속성', (f) => (f.get(0) as Y.XmlElement).setAttribute('onclick', 'x()'), "허용되지 않는 속성 'onclick' (paragraph)"],
    ['편집기가 만들지 않는 textAlign', (f) => (f.get(0) as Y.XmlElement).setAttribute('textAlign', 'center'), "허용되지 않는 속성 'textAlign' (paragraph)"],
    ['문단의 schemaVersion', (f) => (f.get(0) as Y.XmlElement).setAttribute('schemaVersion', 1 as never), "허용되지 않는 속성 'schemaVersion' (paragraph)"],
    [
      '제목 단계 9',
      (f) => {
        const h = para('제목', 'heading');
        h.setAttribute('level', 9 as never);
        f.insert(f.length, [h]);
      },
      'heading.level은 1~6',
    ],
    ['객체 속성값', (f) => (f.get(0) as Y.XmlElement).setAttribute('onclick', { a: 1 } as never), "허용되지 않는 속성 'onclick'"],
    ['모르는 서식', (f) => firstText(f).format(0, 2, { evil: {} }), "허용되지 않는 마크 'evil'"],
    ['해시가 붙은 서식 키', (f) => firstText(f).format(0, 2, { 'bold--abcdefgh': {} }), "허용되지 않는 마크 'bold--abcdefgh'"],
    ['링크 javascript:', (f) => firstText(f).format(0, 2, { link: { href: 'javascript:alert(1)' } }), '허용되지 않는 링크 주소'],
    ['링크 mailto: (7절)', (f) => firstText(f).format(0, 2, { link: { href: 'mailto:a@example.internal' } }), '허용되지 않는 링크 주소'],
    ['서식 값이 객체가 아님', (f) => firstText(f).format(0, 2, { bold: 'x' as never }), "마크 'bold'의 속성은 객체"],
    [
      '코드 블록 안의 굵게',
      (f) => {
        f.insert(f.length, [para('let x', 'codeBlock')]);
        lastText(f).format(0, 3, { bold: {} });
      },
      "'codeBlock' 안의 글자는 마크 'bold'를 받지 않는다",
    ],
  ])('%s', (_label, fn, reason) => {
    const srv = server();
    const v = refused(judge(srv, change(screen(srv), fn)));
    expect(v.rule).toBe('structure');
    expect(v.reason).toContain(reason);
  });

  it('까닭에는 이름을 40자까지만 적는다 — 조작한 클라이언트가 이름에 무엇을 넣든 기록이 불어나지 않는다', () => {
    const srv = server();
    const v = refused(judge(srv, change(screen(srv), (f) => f.insert(f.length, [new Y.XmlElement('x'.repeat(500))]))));
    expect(v.reason.length).toBeLessThan(120);
  });
});

describe('구조 — 이미 아는 조각은 다시 보지 않는다', () => {
  it('서버에 이미 있는 조각을 다시 보내면(접속 직후의 전체 상태) 지난다 — 그 조각이 지금 규칙에 어긋나도', () => {
    const srv = server();
    // Phase 9 이전에 들어온 것처럼 서버 문서에 이미 있는 이상한 속성
    srv.transact(() => (srv.getXmlFragment('default').get(0) as Y.XmlElement).setAttribute('textAlign', 'center'));
    const s = screen(srv);
    expect(judge(srv, Y.encodeStateAsUpdate(s))).toEqual({ ok: true, bind: null });
  });
});

describe('완결 — 서버에서 보류될 것은 받지 않는다 (보류 24, FR-1002)', () => {
  it('앞 시계를 숨긴 조각 — 먼저 친 것을 빼고 뒤의 것만 보내면 받지 않는다', () => {
    const srv = server();
    const s = screen(srv);
    change(s, (f) => firstText(f).insert(0, '먼저'));
    const later = change(s, (f) => firstText(f).insert(0, '나중'));
    const v = refused(judge(srv, later));
    expect(v.rule).toBe('complete');
    expect(v.reason).toContain('서버에서 보류될 조각');
  });

  it('서버에 없는 이웃 — 서버를 거치지 않고 받은 남의 글자 옆에 치면 받지 않는다', () => {
    const srv = server();
    const other = screen(srv);
    const hidden = change(other, (f) => firstText(f).insert(0, '숨은 글'));
    const s = screen(srv);
    Y.applyUpdate(s, hidden, 'remote');
    const v = refused(judge(srv, change(s, (f) => firstText(f).insert(2, '옆'))));
    expect(v.rule).toBe('complete');
  });

  it('아직 없는 글자를 지우는 삭제 — 보류된 삭제로 남의 글자를 지우는 길이다 (P8 자체 점검)', () => {
    const srv = server();
    const other = screen(srv);
    const hidden = change(other, (f) => firstText(f).insert(0, '숨은 글'));
    const s = screen(srv);
    Y.applyUpdate(s, hidden, 'remote');
    const v = refused(judge(srv, change(s, (f) => firstText(f).delete(0, 2))));
    expect(v.rule).toBe('complete');
    expect(v.reason).toContain('아직 없는 글자를 지우는 삭제');
  });

  it('일부를 이미 아는 조각 — 앞부분이 서버에 있고 뒷부분만 새것이면 지난다', () => {
    const srv = server();
    const s = screen(srv);
    const first = change(s, (f) => firstText(f).insert(0, '앞'));
    const second = change(s, (f) => firstText(f).insert(1, '뒤'));
    Y.applyUpdate(srv, first);
    expect(judge(srv, Y.mergeUpdates([first, second]), U, new Map([[s.clientID, U]])).ok).toBe(true);
  });

  it('같은 변경 안에서 서로를 이웃으로 삼는 조각은 순서와 상관없이 지난다 — 새 문단과 그 글자', () => {
    const srv = server();
    const s = screen(srv);
    expect(judge(srv, change(s, (f) => f.insert(0, [para('맨 앞 새 문단')]))).ok).toBe(true);
  });
});

describe('완결 — 들이는 순서를 흉내 낸다 (integrable)', () => {
  const id = (client: number, clock: number) => ({ client, clock });
  it('이웃이 뒤에 나와도 들인다 — Yjs도 기다렸다가 들인다', () => {
    const left = integrable(
      [
        { client: 2, clock: 0, length: 1, deps: [id(1, 0)] },
        { client: 1, clock: 0, length: 1, deps: [] },
      ],
      new Map(),
    );
    expect(left).toEqual([]);
  });

  it('서로를 기다리는 조각은 남는다 — 순환', () => {
    const left = integrable(
      [
        { client: 1, clock: 0, length: 1, deps: [id(2, 0)] },
        { client: 2, clock: 0, length: 1, deps: [id(1, 0)] },
      ],
      new Map(),
    );
    expect(left).toHaveLength(2);
  });

  it('시계가 비면 그 뒤는 남는다 · 서버가 이미 아는 시계에서 이어지면 들인다', () => {
    expect(integrable([{ client: 1, clock: 3, length: 1, deps: [] }], new Map())).toHaveLength(1);
    expect(integrable([{ client: 1, clock: 3, length: 1, deps: [] }], new Map([[1, 3]]))).toEqual([]);
    expect(integrable([{ client: 1, clock: 2, length: 3, deps: [] }], new Map([[1, 3]]))).toEqual([]);
  });
});

describe('주인 — 남의 클라이언트 ID로 쓰지 못한다 (보류 24, FR-1003)', () => {
  it('주인이 다른 사람인 클라이언트로 쓰면 받지 않는다', () => {
    const srv = server();
    const s = screen(srv);
    const v = refused(judge(srv, change(s, (f) => f.insert(f.length, [para('남의 이름으로')])), X, new Map([[s.clientID, U]])));
    expect(v.rule).toBe('owner');
    expect(v.reason).toContain('남의 클라이언트 ID로 쓴 조각');
  });

  it('자기 클라이언트를 이어 쓰면 지난다 — 새로 묶을 것은 없다', () => {
    const srv = server();
    const s = screen(srv);
    expect(judge(srv, change(s, (f) => firstText(f).insert(0, '내 글')), U, new Map([[s.clientID, U]]))).toEqual({ ok: true, bind: null });
  });

  it('새 조각이 든 클라이언트가 여럿이면 아무에게도 묶지 않는다 — 옛 문서를 통째로 다시 보낸 것이다', () => {
    const srv = server();
    const a = screen(srv);
    const b = screen(srv);
    const ua = change(a, (f) => f.insert(f.length, [para('가')]));
    const ub = change(b, (f) => f.insert(f.length, [para('나')]));
    expect(judge(srv, Y.mergeUpdates([ua, ub]))).toEqual({ ok: true, bind: null });
  });

  it('주인 없는 클라이언트를 혼자 이어 쓰면 그 사람에게 묶는다 — 정본에서 만든 서버 클라이언트처럼', () => {
    const srv = server();
    const s = screen(srv);
    s.clientID = srv.clientID;
    expect(judge(srv, change(s, (f) => firstText(f).insert(0, '가')))).toEqual({ ok: true, bind: srv.clientID });
  });
});

describe('지워진 부모 — Yjs가 버리는 조각은 보지 않는다 (P9 코드 리뷰 1)', () => {
  it('지워져 치워진 **빈 문단 안에 새 글자 조각**을 만든다 — 부모가 적힌 조각이다. 정상 동시 편집이다', () => {
    const srv = new Y.Doc();
    srv.getXmlFragment('default').insert(0, [new Y.XmlElement('paragraph')]);
    const s = screen(srv);
    srv.transact(() => srv.getXmlFragment('default').delete(0, 1)); // 서버에서 누가 그 빈 문단을 지웠다
    const u = change(s, (f) => {
      const t = new Y.XmlText();
      (f.get(0) as Y.XmlElement).insert(0, [t]);
      t.insert(0, '늦은 글');
    });
    expect(judge(srv, u).ok).toBe(true);
  });

  it('**지워진 제목의 단계**를 바꾼다 — 속성의 부모가 지워졌다', () => {
    const srv = new Y.Doc();
    const h = para('제목', 'heading');
    h.setAttribute('level', 1 as never);
    srv.getXmlFragment('default').insert(0, [h]);
    const s = screen(srv);
    srv.transact(() => srv.getXmlFragment('default').delete(0, 1));
    expect(judge(srv, change(s, (f) => (f.get(0) as Y.XmlElement).setAttribute('level', 2 as never))).ok).toBe(true);
  });
});

describe('깊이 — 정본 검증의 한도를 문 앞에서 본다 (P9 코드 리뷰 3·자체 점검 1)', () => {
  /** `n`겹 인용 안의 문단 하나와 그 글자 */
  const nested = (n: number): Y.XmlElement => {
    let inner: Y.XmlElement = para('깊은 곳');
    for (let i = 0; i < n; i++) {
      const q = new Y.XmlElement('blockquote');
      q.insert(0, [inner]);
      inner = q;
    }
    return inner;
  };

  it.each([MAX_DOCUMENT_DEPTH - 2, MAX_DOCUMENT_DEPTH - 1])('인용 %i겹 — 관문의 판정이 정본 검증과 같다', (n) => {
    const srv = server();
    const s = screen(srv);
    const v = judge(srv, change(s, (f) => f.insert(f.length, [nested(n)])));
    const saved = validateDocument(docFromYDoc(s));
    expect(v.ok).toBe(saved.ok);
    if (!v.ok) expect(v.reason).toContain(`중첩 깊이 ${MAX_DOCUMENT_DEPTH} 초과`);
  });

  it('한도에 닿은 곳에 한 겹을 더 넣는 작은 변경도 본다 — 서버에 있는 조상까지 센다', () => {
    const srv = server();
    srv.transact(() => srv.getXmlFragment('default').insert(1, [nested(MAX_DOCUMENT_DEPTH - 3)]));
    const s = screen(srv);
    let deepest = s.getXmlFragment('default').get(1) as Y.XmlElement;
    while (deepest.get(0) instanceof Y.XmlElement && (deepest.get(0) as Y.XmlElement).nodeName === 'blockquote') deepest = deepest.get(0) as Y.XmlElement;
    // 가장 깊은 인용(깊이 61) 안에 인용 두 겹 + 문단 + 글자 → 글자의 깊이 65
    const u = change(s, () => deepest.insert(0, [nested(2)]));
    expect(validateDocument(docFromYDoc(s)).ok).toBe(false);
    expect(refused(judge(srv, u)).reason).toContain('중첩 깊이');
  });
});

describe('같은 클라이언트가 되풀이된 변경 — 관문이 보는 것과 Yjs가 들이는 것이 달라진다 (P9 보안 검토 2)', () => {
  it('한 클라이언트의 조각이 두 덩어리로 나뉘어 오면 받지 않는다 — 정상 인코더는 클라이언트마다 한 덩어리로 쓴다', () => {
    const srv = server();
    const s = screen(srv);
    const other = screen(srv);
    const first = Y.decodeUpdate(change(s, (f) => firstText(f).insert(0, '가')));
    const middle = Y.decodeUpdate(change(other, (f) => firstText(f).insert(0, '나')));
    const second = Y.decodeUpdate(change(s, (f) => firstText(f).insert(1, '다')));
    const v = inspectUpdate({ structs: [...first.structs, ...middle.structs, ...second.structs], ds: first.ds }, srv, U, new Map());
    expect(v.ok).toBe(false);
    expect((v as { reason: string }).reason).toContain('같은 클라이언트가 두 번');
  });

  it('**붙어 되풀이된** 덩어리도 받지 않는다 — 풀면 한 덩어리처럼 보여 인코딩의 덩어리 수로 안다. Yjs는 앞 덩어리를 버려 뒤의 것이 보류된다', () => {
    const srv = server();
    const s = screen(srv);
    const u1 = change(s, (f) => firstText(f).insert(0, '가'));
    const u2 = change(s, (f) => firstText(f).insert(1, '나'));
    // 1판 인코딩: [덩어리 수, 덩어리…, 삭제 집합]. 둘 다 덩어리 하나에 빈 삭제 집합(0)이다 — 덩어리 둘로 이어 붙인다
    for (const u of [u1, u2]) expect([u[0], u[u.length - 1]]).toEqual([1, 0]);
    const joined = Uint8Array.from([2, ...u1.slice(1, -1), ...u2.slice(1, -1), 0]);
    const decoded = Y.decodeUpdate(joined);
    expect(decoded.structs.map((x) => x.id.clock)).toEqual([0, 1]);
    const copy = new Y.Doc();
    Y.applyUpdate(copy, Y.encodeStateAsUpdate(srv));
    Y.applyUpdate(copy, joined);
    expect(copy.store.pendingStructs).not.toBeNull();
    // 바이트 없이 풀어 낸 조각만으로는 가릴 수 없다 — 게이트웨이는 늘 바이트를 넘긴다
    expect(inspectUpdate(decoded, srv, U, new Map()).ok).toBe(true);
    expect(refused(inspectUpdate(decoded, srv, U, new Map(), joined)).reason).toContain('같은 클라이언트가 두 번');
  });
});

describe('들이는 순서의 흉내는 클라이언트가 많아도 빠르다 (P9 코드 리뷰 2)', () => {
  it('서로를 거꾸로 기다리는 2만 개의 클라이언트를 1초 안에 들인다 — 전에는 도는 수가 제곱으로 늘었다', () => {
    const n = 20_000;
    const structs = Array.from({ length: n }, (_, i) => ({ client: i + 1, clock: 0, length: 1, deps: i + 1 < n ? [{ client: i + 2, clock: 0 }] : [] }));
    const started = performance.now();
    expect(integrable(structs, new Map())).toEqual([]);
    expect(performance.now() - started).toBeLessThan(1000);
  });
});

describe('들이는 순서 — 여럿이 한 클라이언트의 서로 다른 시계를 기다린다 (D.3)', () => {
  it('시계가 작은 것부터 풀리고, 끝내 모자란 것은 남긴다', () => {
    // 기다리는 쪽이 먼저 줄을 선다 — 클라이언트 1의 조각(시계 0~9)은 맨 나중에 들인다
    const waits = [7, 2, 9, 4, 0, 5, 12, 3];
    const structs = [
      ...Array.from({ length: 10 }, (_, i) => ({ client: 1, clock: i, length: 1, deps: [] })),
      ...waits.map((c, i) => ({ client: 100 + i, clock: 0, length: 1, deps: [{ client: 1, clock: c }] })),
    ];
    const known = new Map<number, number>();
    const left = integrable(structs, known);
    expect(left.map((s) => s.client)).toEqual([106]); // 시계 12를 기다렸다 — 클라이언트 1은 10까지뿐이다
    expect(known.get(1)).toBe(10);
    expect(waits.map((_, i) => known.get(100 + i) ?? 0)).toEqual(waits.map((c) => (c < 10 ? 1 : 0)));
  });
});

/**
 * 드문 모양 — **어떤 순서로 와도**, **Phase 9 전에 남은 상태 위에서도** 편집기가 만들지 않는 것은 받지 않는다 (D.2, D.8).
 *
 * 합친 변경은 클라이언트 번호가 큰 쪽부터 적힌다(`Y.mergeUpdates`). 그래서 번호가 큰 클라이언트가 번호가 작은 클라이언트의
 * 이상한 타입 **안에** 쓰면, 관문은 그 타입보다 안의 조각을 먼저 본다 — 자리를 그 타입으로 찾아야 한다.
 */
describe('드문 모양 — 순서가 뒤집혀도, 옛 상태 위에서도', () => {
  /** 클라이언트 번호를 정한 화면 */
  const screenAs = (from: Y.Doc, clientID: number): Y.Doc => {
    const d = screen(from);
    d.clientID = clientID;
    return d;
  };
  /** 두 화면의 변경을 하나로 — 번호가 큰 쪽이 앞에 적힌다 */
  const twoClients = (srv: Y.Doc, outer: (f: Y.XmlFragment) => void, inner: (f: Y.XmlFragment) => void): Uint8Array => {
    const a = screenAs(srv, 5);
    const ua = change(a, outer);
    const b = screenAs(a, 9);
    const ub = change(b, inner);
    return Y.mergeUpdates([ua, ub]);
  };
  /** 편집기로는 만들 수 없는 내용을 조각에 끼운다 — 인코더는 조각의 내용을 그대로 쓴다 */
  const forged = (make: (d: Y.Doc) => Y.Item, content: Y.Item['content']): { srv: Y.Doc; update: Uint8Array } => {
    const srv = server();
    const s = screen(srv);
    const sv = Y.encodeStateVector(s);
    let item: Y.Item | null = null;
    s.transact(() => {
      item = make(s);
    });
    item!.content = content;
    return { srv, update: Y.encodeStateAsUpdate(s, sv) };
  };
  /** 문단에 목록 자식으로 값 하나를 넣고 그 조각을 돌려준다 */
  const valueInParagraph = (d: Y.Doc): Y.Item => {
    const p = d.getXmlFragment('default').get(0) as Y.XmlElement;
    p.insert(0, ['x' as never]);
    return p._start!;
  };

  it.each<[string, () => unknown, string]>([
    ['Y.Array', () => new Y.Array(), 'Array'],
    ['Y.XmlFragment', () => new Y.XmlFragment(), 'XmlFragment'],
  ])('문단 안의 %s는 받지 않는다', (_label, make, name) => {
    const srv = server();
    const s = screen(srv);
    expect(refused(judge(srv, change(s, (f) => (f.get(0) as Y.XmlElement).insert(0, [make() as never])))).reason).toBe(`편집기가 만들지 않는 타입 '${name}'`);
  });

  it('남의 이상한 타입 **안에** 쓴 것이 먼저 와도 받지 않는다 — Map에 속성, XmlHook에 속성', () => {
    const srv = server();
    const map = twoClients(
      srv,
      (f) => (f.get(0) as Y.XmlElement).insert(0, [new Y.Map() as never]),
      (f) => ((f.get(0) as Y.XmlElement).get(0) as unknown as Y.Map<number>).set('k', 1),
    );
    expect(refused(judge(srv, map)).reason).toBe("'Map'에 속성");
    const hook = twoClients(
      srv,
      (f) => f.insert(0, [new Y.XmlHook('h') as never]),
      (f) => (f.get(0) as unknown as Y.XmlHook).set('k', 1 as never),
    );
    expect(refused(judge(srv, hook)).reason).toBe("'XmlHook'에 속성");
  });

  it('맨 위에 놓인 남의 글자 조각 안에 서식을 먼저 보내도 받지 않는다 — 글자를 담은 노드가 없다', () => {
    const srv = server();
    const u = twoClients(
      srv,
      (f) => f.insert(0, [new Y.XmlText()]),
      (f) => (f.get(0) as unknown as Y.XmlText).insert(0, '굵게', { bold: {} }),
    );
    expect(refused(judge(srv, u)).reason).toBe("'' 안의 글자는 마크 'bold'를 받지 않는다");
  });

  it.each<[string, (d: Y.Doc) => void, string]>([
    [
      '맨 위의 XmlHook에 속성',
      (d) => d.getXmlFragment('default').insert(0, [new Y.XmlHook('h') as never]),
      "'XmlHook'에 속성",
    ],
    [
      '문단 안의 Y.Map에 속성',
      (d) => (d.getXmlFragment('default').get(0) as Y.XmlElement).insert(0, [new Y.Map() as never]),
      "'Map'에 속성",
    ],
  ])('Phase 9 전에 들어간 %s을 이어 쓰는 것은 받지 않는다', (_label, legacy, reason) => {
    const srv = server();
    legacy(srv);
    const s = screen(srv);
    const u = change(s, (f) => {
      // 옛 XmlHook은 맨 위 첫 자리에, 옛 Map은 첫 문단의 첫 자식에 있다
      const holder = reason.includes('XmlHook') ? f.get(0) : (f.get(0) as Y.XmlElement).get(0);
      (holder as unknown as Y.Map<number>).set('k', 1);
    });
    expect(refused(judge(srv, u)).reason).toBe(reason);
  });

  it('Phase 9 전에 맨 위에 들어간 글자 조각에 서식을 쳐도 받지 않는다', () => {
    const srv = server();
    srv.getXmlFragment('default').insert(0, [new Y.XmlText()]);
    const s = screen(srv);
    const u = change(s, (f) => (f.get(0) as unknown as Y.XmlText).insert(0, '굵게', { bold: {} }));
    expect(refused(judge(srv, u)).reason).toBe("'' 안의 글자는 마크 'bold'를 받지 않는다");
  });

  it('속성 자리에 타입을 두면 받지 않는다', () => {
    const srv = server();
    const s = screen(srv);
    const u = change(s, (f) => (f.get(0) as Y.XmlElement).setAttribute('k', new Y.XmlText() as never));
    expect(refused(judge(srv, u)).reason).toBe("'paragraph'의 속성 자리에 올 수 없는 내용");
  });

  it('글자 조각 안에 요소를 끼워 넣으면 받지 않는다', () => {
    const srv = server();
    const s = screen(srv);
    const u = change(s, (f) => firstText(f).insertEmbed(0, new Y.XmlElement('paragraph') as never));
    expect(refused(judge(srv, u)).reason).toBe("'text' 안에 올 수 없는 'paragraph'");
  });

  it.each<[string, Y.Item['content'], string]>([
    ['값', new Y.ContentAny(['x']), "'paragraph' 안에 올 수 없는 값"],
    ['글자', new Y.ContentString('x'), "'paragraph' 안에 올 수 없는 글자"],
    ['서식', new Y.ContentFormat('bold', {}), "'paragraph' 안에 올 수 없는 서식"],
    ['옛 JSON 내용', new Y.ContentJSON(['x']), "편집기가 만들지 않는 내용 'JSON'"],
  ])('문단의 목록 자식으로 %s을 두면 받지 않는다', (_label, content, reason) => {
    const { srv, update } = forged(valueInParagraph, content);
    expect(refused(judge(srv, update)).reason).toBe(reason);
  });

  it('글자 조각 안에 값(`ContentAny`)을 두면 받지 않는다', () => {
    const { srv, update } = forged((d) => {
      const t = firstText(d.getXmlFragment('default'));
      t.insert(t.length, '끝');
      let last = t._start!;
      while (last.right) last = last.right;
      return last;
    }, new Y.ContentAny(['x']));
    expect(refused(judge(srv, update)).reason).toBe("'text' 안에 올 수 없는 값");
  });

  it('서버가 치워 버린(GC) 요소 안에 친 첫 글자는 보지 않는다 — Yjs가 버린다', () => {
    const srv = new Y.Doc();
    const list = new Y.XmlElement('bulletList');
    const item = new Y.XmlElement('listItem');
    item.insert(0, [new Y.XmlElement('paragraph')]);
    list.insert(0, [item]);
    srv.getXmlFragment('default').insert(0, [list]);
    const s = screen(srv);
    // 동료가 목록을 지웠다 — 서버는 목록 안의 조각을 치운다(GC). 화면은 아직 모른다
    srv.transact(() => srv.getXmlFragment('default').delete(0, 1));
    const u = change(s, (f) => (((f.get(0) as Y.XmlElement).get(0) as Y.XmlElement).get(0) as Y.XmlElement).insert(0, [new Y.XmlText('늦은 글')]));
    expect(judge(srv, u).ok).toBe(true);
  });

  it('지운 채 보낸 조각(치운 조각 GC 포함)은 구조를 보지 않는다', () => {
    const srv = server();
    const s = screen(srv);
    const sv = Y.encodeStateVector(s);
    s.transact(() => s.getXmlFragment('default').insert(1, [para('곧 지울 글')]));
    s.transact(() => s.getXmlFragment('default').delete(1, 1));
    const update = Y.encodeStateAsUpdate(s, sv);
    expect(Y.decodeUpdate(update).structs.some((x) => x instanceof Y.GC)).toBe(true);
    expect(judge(srv, update).ok).toBe(true);
  });

  it('클라이언트 덩어리가 128개를 넘어도(덩어리 수가 두 바이트) 되풀이로 보지 않는다', () => {
    const srv = server();
    const updates = Array.from({ length: 130 }, (_, i) => change(screenAs(srv, 1000 + i), (f) => firstText(f).insert(0, '가')));
    const merged = Y.mergeUpdates(updates);
    expect([...merged.subarray(0, 2)]).toEqual([0x82, 0x01]); // 130
    expect(inspectUpdate(Y.decodeUpdate(merged), srv, U, new Map(), merged)).toEqual({ ok: true, bind: null });
  });
});

/**
 * Yjs는 **이미 아는 조각도** 들이기 전에 이웃을 찾고(`getMissing`), **일부만 아는 조각**은 아는 앞부분을 잘라 내고 나머지를 그
 * 클라이언트의 앞 조각 바로 뒤에 둔다(`Item.integrate`의 `offset`). 관문이 이 둘을 따로 보지 않으면 관문이 본 것과 들어가는 것이
 * 달라진다 (P9 두 번째 보안 검토 2).
 */
describe('아는 조각·일부만 아는 조각 — Yjs가 들이는 대로 (두 번째 보안 검토 2)', () => {
  const X = 4242;
  /** 서버가 X를 알기 전 상태에서 X의 번호로 만든 화면 */
  const forgedFrom = (before: Uint8Array): Y.Doc => {
    const d = new Y.Doc();
    Y.applyUpdate(d, before);
    d.clientID = X;
    return d;
  };
  const copyOf = (srv: Y.Doc): Y.Doc => {
    const d = new Y.Doc();
    Y.applyUpdate(d, Y.encodeStateAsUpdate(srv));
    return d;
  };

  it('이미 아는 조각에 **없는 이웃**을 적어 보내면 받지 않는다 — Yjs는 그 클라이언트의 뒤 조각까지 보류한다', () => {
    const srv = server();
    const before = Y.encodeStateAsUpdate(srv);
    const owners = new Map<number, string>();
    const s = screen(srv);
    s.clientID = X;
    expect(pass(srv, change(s, (f) => firstText(f).insert(0, '가')), owners).ok).toBe(true);
    // 꾸민 화면: 서버에 없는 클라이언트 777의 글자 뒤에 X의 '가'(시계 0)를 두고, 떨어진 곳에 X의 '나'(시계 1)를 친다
    const forged = forgedFrom(before);
    forged.clientID = 777;
    forged.transact(() => firstText(forged.getXmlFragment('default')).insert(0, 'z'));
    forged.clientID = X;
    forged.transact(() => firstText(forged.getXmlFragment('default')).insert(1, '가'));
    forged.transact(() => {
      const t = firstText(forged.getXmlFragment('default'));
      t.insert(t.length, '나');
    });
    // 777의 글자는 빼고 X의 두 조각만 보낸다 — 시계 0은 서버가 아는 조각이다
    const known = new Map(Y.decodeStateVector(Y.encodeStateVector(srv)));
    known.delete(X);
    known.set(777, 1);
    const update = Y.encodeStateAsUpdate(forged, Y.encodeStateVector(known));
    expect(Y.decodeUpdate(update).structs.map((x) => [x.id.client, x.id.clock])).toEqual([[X, 0], [X, 1]]);
    const copy = copyOf(srv);
    Y.applyUpdate(copy, update);
    expect(copy.store.pendingStructs).not.toBeNull(); // 그대로 들이면 '나'가 서버에 보류된다
    expect(refused(judge(srv, update, U, owners))).toEqual({ ok: false, rule: 'complete', reason: '서버에서 보류될 조각' });
  });

  it('일부만 아는 조각을 **다른 자리**에 이어 쓴 것으로 꾸미면 받지 않는다 — Yjs가 나머지를 앞 조각 옆에 끼우면서 부모는 꾸민 자리로 잡아 문서가 어긋난다', () => {
    const srv = new Y.Doc();
    srv.getXmlFragment('default').insert(0, [para('첫 문단'), para('둘째 문단')]);
    const before = Y.encodeStateAsUpdate(srv);
    const owners = new Map<number, string>();
    const s = screen(srv);
    s.clientID = X;
    expect(pass(srv, change(s, (f) => firstText(f).insert(0, '가')), owners).ok).toBe(true);
    // 꾸민 화면: X의 번호로 **둘째 문단**에 '가나'를 한 번에 친다 — 조각 하나(시계 0~1). 서버는 시계 0을 첫 문단에 두었다
    const forged = forgedFrom(before);
    const sv = Y.encodeStateVector(forged);
    forged.transact(() => lastText(forged.getXmlFragment('default')).insert(0, '가나'));
    const update = Y.encodeStateAsUpdate(forged, sv);
    expect(Y.decodeUpdate(update).structs.map((x) => [x.id.clock, x.length])).toEqual([[0, 2]]);
    const copy = copyOf(srv);
    Y.applyUpdate(copy, update);
    const second = lastText(copy.getXmlFragment('default'));
    expect(second.length).not.toBe(second.toString().length); // 그대로 들이면 둘째 문단이 세는 길이와 실제 글자가 어긋난다
    expect(refused(judge(srv, update, U, owners))).toEqual({ ok: false, rule: 'structure', reason: '앞 조각과 다른 자리에 이어 쓴 조각' });
  });

  it('일부만 아는 **지운** 조각도 다른 자리에 이어 쓴 것으로 꾸미면 받지 않는다 — 지운 조각도 Yjs가 앞 조각 옆에 끼워 목록과 부모가 어긋난다 (P9 세 번째 코드 리뷰 1)', () => {
    const srv = new Y.Doc();
    srv.getXmlFragment('default').insert(0, [para('첫 문단'), para('둘째 문단')]);
    const before = Y.encodeStateAsUpdate(srv);
    const owners = new Map<number, string>();
    const s = screen(srv);
    s.clientID = X;
    expect(pass(srv, change(s, (f) => firstText(f).insert(0, '가')), owners).ok).toBe(true);
    // 꾸민 화면: X의 번호로 **둘째 문단**에 '가나'를 치고 같은 트랜잭션에서 지운다 — 지운 조각 하나(시계 0~1)
    const forged = forgedFrom(before);
    const sv = Y.encodeStateVector(forged);
    forged.transact(() => {
      const t = lastText(forged.getXmlFragment('default'));
      t.insert(0, '가나');
      t.delete(0, 2);
    });
    const update = Y.encodeStateAsUpdate(forged, sv);
    const [struct] = Y.decodeUpdate(update).structs.filter((x) => x.id.client === X);
    expect([struct.id.clock, struct.length, (struct as Y.Item).content instanceof Y.ContentDeleted]).toEqual([0, 2, true]);
    const copy = copyOf(srv);
    Y.applyUpdate(copy, update);
    const tail = Y.getItem(copy.store, Y.createID(X, 1)) as Y.Item;
    expect(tail.parent).not.toBe(tail.left?.parent); // 그대로 들이면 첫 문단의 목록에 둘째 문단을 부모로 둔 조각이 낀다
    expect(refused(judge(srv, update, U, owners))).toEqual({ ok: false, rule: 'structure', reason: '앞 조각과 다른 자리에 이어 쓴 조각' });
  });

  it('일부만 아는 조각을 **같은 자리**에 이어 쓴 것은 받는다 — 같은 Y.Doc으로 다시 붙은 화면이 보내는 전체 상태다', () => {
    const srv = server();
    const owners = new Map<number, string>();
    const s = screen(srv);
    s.clientID = X;
    expect(pass(srv, change(s, (f) => firstText(f).insert(0, '가')), owners).ok).toBe(true);
    // 끊긴 사이 '가' 뒤에 '나다'를 이어 친다 — 전체 상태에서는 조각 하나(시계 0~2)로 합쳐진다
    s.transact(() => firstText(s.getXmlFragment('default')).insert(1, '나다'));
    const full = Y.encodeStateAsUpdate(s);
    expect(Y.decodeUpdate(full).structs.filter((x) => x.id.client === X).map((x) => [x.id.clock, x.length])).toEqual([[0, 3]]);
    expect(pass(srv, full, owners).ok).toBe(true);
    expect(firstText(srv.getXmlFragment('default')).toString()).toBe('가나다앞 문단');
    expect(srv.store.pendingStructs).toBeNull();
  });
});

/**
 * **목록 항목의 첫 자식** (P12 보안 검토 1). 받는 편집기(y-tiptap)는 첫 자식이 문단이 아닌 목록 항목을 **통째로** 공유 문서에서 지운다 —
 * 그 안의 남의 글(중첩 목록까지)과 함께, 그리고 그 삭제는 받은 사람의 연결에서 나가 그 사람 이름으로 저장된다. 조작한 연결은 남의 항목
 * 앞에 인용 하나를 끼우거나 첫 문단만 지워 그렇게 만들 수 있었다. 관문이 **적용한 뒤의 첫 자식**을 본다. 편집기는 이 모양을 만들지 않는다
 */
describe('목록 항목의 첫 자식 — 적용한 뒤를 본다 (P12 보안 검토 1)', () => {
  const li = (...c: Y.XmlElement[]): Y.XmlElement => {
    const e = new Y.XmlElement('listItem');
    e.insert(0, c);
    return e;
  };
  const list = (...items: Y.XmlElement[]): Y.XmlElement => {
    const e = new Y.XmlElement('bulletList');
    e.insert(0, items);
    return e;
  };
  /** 서버 문서 — 남의 목록: 항목 하나에 문단과 중첩 목록 */
  function withList(): Y.Doc {
    const d = new Y.Doc();
    d.getXmlFragment('default').insert(0, [list(li(para('남의 글'), list(li(para('남의 중첩'))))), para('끝')]);
    return d;
  }
  const item = (f: Y.XmlFragment): Y.XmlElement => (f.get(0) as Y.XmlElement).get(0) as Y.XmlElement;

  it('**남의 목록 항목 앞에 인용을 끼우면 받지 않는다**', () => {
    const srv = withList();
    const quote = new Y.XmlElement('blockquote');
    quote.insert(0, [para('조작')]);
    const v = judge(srv, change(screen(srv), (f) => item(f).insert(0, [quote])));
    expect(refused(v)).toEqual({ ok: false, rule: 'structure', reason: '목록 항목의 첫 자식이 문단이 아니게 되는 변경' });
  });

  it('**첫 문단만 지우면 받지 않는다** — 남의 중첩 목록이 첫 자식이 된다', () => {
    const srv = withList();
    const v = judge(srv, change(screen(srv), (f) => item(f).delete(0, 1)));
    expect(refused(v).reason).toBe('목록 항목의 첫 자식이 문단이 아니게 되는 변경');
  });

  it('정상 — 새 항목 더하기·항목 통째로 지우기·첫 문단 고치기·첫 문단을 새 문단으로 바꾸기', () => {
    const owners = new Map<number, string>();
    const srv = withList();
    const a = screen(srv);
    expect(pass(srv, change(a, (f) => (f.get(0) as Y.XmlElement).insert(1, [li(para('새 항목'))])), owners).ok).toBe(true);
    expect(pass(srv, change(a, (f) => (item(f).get(0) as Y.XmlElement).get(0) instanceof Y.XmlText && ((item(f).get(0) as Y.XmlElement).get(0) as Y.XmlText).insert(0, '고친 ')), owners).ok).toBe(true);
    expect(pass(srv, change(a, (f) => { item(f).delete(0, 1); item(f).insert(0, [para('바꾼 첫 문단')]); }), owners).ok).toBe(true);
    expect(pass(srv, change(a, (f) => (f.get(0) as Y.XmlElement).delete(0, 1)), owners).ok).toBe(true);
    expect(validateDocument(docFromYDoc(srv))).toEqual({ ok: true });
  });

  it('옛 상태에 이미 어긴 항목이 있어도 **다른 곳을 고치는 변경은 지난다** — 새로 어기게 만드는 것만 본다', () => {
    const d = new Y.Doc();
    const quote = new Y.XmlElement('blockquote');
    quote.insert(0, [para('옛 인용')]);
    d.getXmlFragment('default').insert(0, [list(li(quote), li(para('둘째'))), para('끝')]);
    const v = judge(d, change(screen(d), (f) => ((f.get(0) as Y.XmlElement).get(1) as Y.XmlElement).insert(1, [para('둘째에 더한 문단')])));
    expect(v.ok).toBe(true);
  });
});

