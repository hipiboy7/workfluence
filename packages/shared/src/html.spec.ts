import { describe, expect, it } from 'vitest';
import { renderDocHtml, renderExportDocument } from './html';
import type { DocNode } from './document';

/**
 * A등급 — **테스트 먼저** (3절, P6_설계서_Collab FR-730~737).
 *
 * 이 함수가 만든 문자열은 **앱 밖에서 열린다.** 브라우저가 우리 CSP 아래에 있지 않다는
 * 뜻이다. 그래서 테스트의 절반이 "무엇을 내보내지 않는가"다.
 */

const doc = (...c: DocNode[]): DocNode => ({ type: 'doc', attrs: { schemaVersion: 1 }, content: c });
const p = (...c: DocNode[]): DocNode => ({ type: 'paragraph', content: c });
const t = (text: string, marks?: { type: string; attrs?: Record<string, unknown> }[]): DocNode => ({ type: 'text', text, marks });

describe('renderDocHtml — 이스케이프 (FR-733)', () => {
  it('**본문의 꺾쇠를 태그로 만들지 않는다**', () => {
    const out = renderDocHtml(doc(p(t('<script>alert(1)</script>'))));
    expect(out).not.toContain('<script>');
    expect(out).toContain('&lt;script&gt;');
  });

  it('따옴표와 앰퍼샌드도 이스케이프한다', () => {
    expect(renderDocHtml(doc(p(t(`a & b " c ' d`))))).toContain('&amp;');
    expect(renderDocHtml(doc(p(t(`"`))))).toContain('&quot;');
  });

  it('속성값도 이스케이프한다 — 속성에서 빠져나오지 못한다', () => {
    const out = renderDocHtml(doc(p(t('링크', [{ type: 'link', attrs: { href: '/a"onmouseover="x' } }]))));
    expect(out).not.toContain('onmouseover="x"');
    expect(out).toContain('&quot;');
  });
});

describe('renderDocHtml — 허용 목록 (FR-732)', () => {
  it('허용된 노드는 제 태그로 나온다', () => {
    const out = renderDocHtml(
      doc(
        { type: 'heading', attrs: { level: 2 }, content: [t('제목')] },
        p(t('본문')),
        { type: 'bulletList', content: [{ type: 'listItem', content: [p(t('항목'))] }] },
        { type: 'horizontalRule' },
      ),
    );
    expect(out).toContain('<h2>제목</h2>');
    expect(out).toContain('<p>본문</p>');
    expect(out).toContain('<ul><li><p>항목</p></li></ul>');
    expect(out).toContain('<hr />');
  });

  it('**허용 목록 밖의 노드는 통째로 빠진다** — 글자도 남기지 않는다', () => {
    const out = renderDocHtml(doc({ type: 'iframe', attrs: { src: 'http://evil' }, content: [t('안쪽')] }));
    expect(out).not.toContain('iframe');
    expect(out).not.toContain('evil');
    expect(out).not.toContain('안쪽');
  });

  it('허용 목록 밖의 마크는 무시하되 **글자는 남긴다**', () => {
    const out = renderDocHtml(doc(p(t('중요', [{ type: 'blink' }]))));
    expect(out).not.toContain('blink');
    expect(out).toContain('중요');
  });

  it('허용된 마크는 겹쳐서 나온다', () => {
    const out = renderDocHtml(doc(p(t('굵고 기울인', [{ type: 'bold' }, { type: 'italic' }]))));
    expect(out).toMatch(/<strong><em>굵고 기울인<\/em><\/strong>|<em><strong>굵고 기울인<\/strong><\/em>/);
  });

  it('표를 그린다', () => {
    const out = renderDocHtml(
      doc({
        type: 'table',
        content: [{ type: 'tableRow', content: [{ type: 'tableHeader', content: [p(t('머리'))] }, { type: 'tableCell', content: [p(t('값'))] }] }],
      }),
    );
    expect(out).toContain('<table>');
    expect(out).toContain('<th>');
    expect(out).toContain('<td>');
  });
});

describe('renderDocHtml — 링크 (FR-734)', () => {
  it('허용된 링크만 남는다', () => {
    expect(renderDocHtml(doc(p(t('안', [{ type: 'link', attrs: { href: 'https://x.example.internal/a' } }]))))).toContain('href="https://x.example.internal/a"');
    expect(renderDocHtml(doc(p(t('안', [{ type: 'link', attrs: { href: '/pages/1' } }]))))).toContain('href="/pages/1"');
  });

  it('**`javascript:`·`data:`는 링크로 만들지 않는다.** 글자는 남는다', () => {
    for (const href of ['javascript:alert(1)', 'data:text/html,<script>', 'vbscript:x', '//evil.example']) {
      const out = renderDocHtml(doc(p(t('눌러', [{ type: 'link', attrs: { href } }]))));
      expect(out).not.toContain('<a ');
      expect(out).toContain('눌러');
    }
  });

  it('링크에 `rel`을 강제로 붙인다 — 내보낸 파일은 우리 CSP 밖에서 열린다', () => {
    const out = renderDocHtml(doc(p(t('밖', [{ type: 'link', attrs: { href: 'https://x.example.internal' } }]))));
    expect(out).toContain('rel="noopener noreferrer"');
  });
});

describe('renderExportDocument — 한 파일로 (FR-730·735)', () => {
  const html = renderExportDocument({ title: '회의록', doc: doc(p(t('내용'))), exportedAt: '2026-09-22T00:00:00.000Z' });

  it('스스로 완결된 HTML 문서다', () => {
    expect(html).toMatch(/^<!doctype html>/i);
    expect(html).toContain('<html lang="ko">');
    expect(html).toContain('</html>');
  });

  it('**외부 자원을 하나도 참조하지 않는다** (7절)', () => {
    expect(html).not.toMatch(/<link[^>]+href="https?:/i);
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/@import/i);
    expect(html).not.toMatch(/url\(\s*https?:/i);
  });

  it('인쇄 CSS가 들어 있다 — PDF 대신 쓰는 길이다 (쟁점 2)', () => {
    expect(html).toContain('@media print');
  });

  it('제목도 이스케이프한다', () => {
    const evil = renderExportDocument({ title: '<img src=x onerror=1>', doc: doc(), exportedAt: '2026-09-22T00:00:00.000Z' });
    expect(evil).not.toContain('<img');
    expect(evil).toContain('&lt;img');
  });

  it('언제 내보냈는지 적는다 — 종이로 나가면 그것 말고 시점을 알 길이 없다', () => {
    expect(html).toContain('2026-09-22');
  });
});

describe('renderDocHtml — 속성 (FR-732·733)', () => {
  it('허용된 속성만 나온다. `textAlign`은 나오고 모르는 키는 빠진다', () => {
    const out = renderDocHtml(doc({ type: 'paragraph', attrs: { textAlign: 'center', onclick: 'x()' }, content: [t('가운데')] }));
    expect(out).toContain('textAlign="center"');
    expect(out).not.toContain('onclick');
  });

  it('**`schemaVersion`과 `colwidth`는 내보내지 않는다** — 편집기 내부 상태이지 문서가 아니다', () => {
    const out = renderDocHtml(
      doc({ type: 'table', content: [{ type: 'tableRow', content: [{ type: 'tableCell', attrs: { colwidth: [120], colspan: 2 }, content: [p(t('칸'))] }] }] }),
    );
    expect(out).not.toContain('colwidth');
    expect(out).toContain('colspan="2"');
  });

  it('속성이 `null`이면 적지 않는다 — `x="null"`이 나가면 안 된다', () => {
    const out = renderDocHtml(doc({ type: 'paragraph', attrs: { textAlign: null }, content: [t('가')] }));
    expect(out).toBe('<p>가</p>');
  });

  it('속성값의 따옴표를 이스케이프한다', () => {
    const out = renderDocHtml(doc({ type: 'codeBlock', attrs: { language: 'ts" onload="x' }, content: [t('코드')] }));
    expect(out).not.toContain('onload="x"');
    expect(out).toContain('&quot;');
  });

  it('제목 수준이 범위 밖이면 h1로 떨어뜨린다 — `<h9>`는 없는 태그다', () => {
    expect(renderDocHtml(doc({ type: 'heading', attrs: { level: 9 }, content: [t('가')] }))).toContain('<h1>');
    expect(renderDocHtml(doc({ type: 'heading', attrs: { level: 0 }, content: [t('가')] }))).toContain('<h1>');
    expect(renderDocHtml(doc({ type: 'heading', content: [t('가')] }))).toContain('<h1>');
  });

  it('줄바꿈 노드는 `<br />`', () => {
    expect(renderDocHtml(doc(p(t('위'), { type: 'hardBreak' }, t('아래'))))).toContain('<br />');
  });

  it('`text`에 글자가 없어도 터지지 않는다', () => {
    expect(renderDocHtml(doc(p({ type: 'text' })))).toBe('<p></p>');
  });

  it('허용됐지만 태그가 없는 노드는 **자식만 그린다**', () => {
    // `taskItem`은 li로 매핑돼 있으므로, 매핑이 없는 경우를 직접 만든다
    const out = renderDocHtml(doc({ type: 'taskList', content: [{ type: 'taskItem', attrs: { checked: true }, content: [p(t('할 일'))] }] }));
    expect(out).toContain('할 일');
    expect(out).toContain('checked="true"');
  });
});

describe('renderExportDocument — 머리말', () => {
  it('공간 이름과 버전을 주면 적는다', () => {
    const html = renderExportDocument({ title: 'T', doc: doc(), exportedAt: '2026-09-22', spaceName: '팀 공간', versionNo: 3 });
    expect(html).toContain('공간: 팀 공간');
    expect(html).toContain('버전 3');
  });

  it('**공간 이름도 이스케이프한다**', () => {
    const html = renderExportDocument({ title: 'T', doc: doc(), exportedAt: '2026-09-22', spaceName: '<b>x</b>' });
    expect(html).not.toContain('<b>x</b>');
  });

  it('없으면 그 줄을 적지 않는다', () => {
    const html = renderExportDocument({ title: 'T', doc: doc(), exportedAt: '2026-09-22' });
    expect(html).not.toContain('공간:');
    expect(html).not.toContain('버전 ');
  });
});
