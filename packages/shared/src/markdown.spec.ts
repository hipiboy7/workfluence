import { describe, expect, it } from 'vitest';
import type { DocMark, DocNode } from './document';
import { pageMarkdown, pageText, renderDocMarkdown } from './markdown';

/**
 * A등급 — **테스트 먼저** (3절, P10_설계서_Llm D.7·FR-1140~1142).
 *
 * 복사한 마크다운은 LLM 질문 칸이나 다른 편집기에 붙는다. 그래서 두 가지를 본다 — 문서의 모양이 옮겨 가는가,
 * 그리고 **문서의 글자가 붙인 곳에서 서식이 되지 않는가**(`*` 한 글자가 기울임이 되는 일).
 */

const doc = (...c: DocNode[]): DocNode => ({ type: 'doc', attrs: { schemaVersion: 2 }, content: c });
const p = (...c: DocNode[]): DocNode => ({ type: 'paragraph', content: c });
const t = (text: string, marks?: DocMark[]): DocNode => ({ type: 'text', text, ...(marks ? { marks } : {}) });
const h = (level: number, ...c: DocNode[]): DocNode => ({ type: 'heading', attrs: { level }, content: c });
const li = (...c: DocNode[]): DocNode => ({ type: 'listItem', content: c });
const ul = (...c: DocNode[]): DocNode => ({ type: 'bulletList', content: c });
const ol = (start: number | null, ...c: DocNode[]): DocNode => ({ type: 'orderedList', attrs: { start }, content: c });
const bq = (...c: DocNode[]): DocNode => ({ type: 'blockquote', content: c });
const br: DocNode = { type: 'hardBreak' };
const cell = (kind: 'tableCell' | 'tableHeader', attrs: Record<string, unknown>, ...c: DocNode[]): DocNode => ({ type: kind, attrs, content: c });
const tr = (...c: DocNode[]): DocNode => ({ type: 'tableRow', content: c });
const table = (...c: DocNode[]): DocNode => ({ type: 'table', content: c });
const bold: DocMark = { type: 'bold' };
const italic: DocMark = { type: 'italic' };
const link = (href: string): DocMark => ({ type: 'link', attrs: { href } });

const md = (...blocks: DocNode[]) => renderDocMarkdown(doc(...blocks));

describe('블록', () => {
  it('문단은 빈 줄로 나눈다', () => {
    expect(md(p(t('하나')), p(t('둘')))).toBe('하나\n\n둘');
  });

  it('**빈 문단은 건너뛴다** — 편집기의 빈 줄이 마크다운에서 빈 줄 여럿이 되지 않게', () => {
    expect(md(p(), p(t('a')), p())).toBe('a');
    expect(renderDocMarkdown(doc())).toBe('');
  });

  it('제목은 단계만큼 `#`', () => {
    expect(md(h(2, t('제목')))).toBe('## 제목');
    expect(md(h(6, t('여섯')))).toBe('###### 여섯');
  });

  it('단계가 틀린 제목은 1단계로 읽는다 — HTML 내보내기와 같다', () => {
    expect(md(h(9, t('제목')))).toBe('# 제목');
  });

  it('제목 안의 줄바꿈은 빈칸이 된다 — 마크다운 제목은 한 줄이다', () => {
    expect(md(h(1, t('a'), br, t('b')))).toBe('# a b');
  });

  it('가로줄', () => {
    expect(md(p(t('a')), { type: 'horizontalRule' }, p(t('b')))).toBe('a\n\n---\n\nb');
  });

  it('줄바꿈은 줄 끝 `\\`다', () => {
    expect(md(p(t('a'), br, t('b')))).toBe('a\\\nb');
  });
});

describe('서식', () => {
  it('굵게·기울임·취소선·코드', () => {
    expect(md(p(t('굵게', [bold])))).toBe('**굵게**');
    expect(md(p(t('기울임', [italic])))).toBe('*기울임*');
    expect(md(p(t('취소', [{ type: 'strike' }])))).toBe('~~취소~~');
    expect(md(p(t('코드', [{ type: 'code' }])))).toBe('`코드`');
  });

  it('겹친 서식은 적힌 차례로 감싼다', () => {
    expect(md(p(t('x', [bold, italic])))).toBe('***x***');
  });

  it('**서식 안의 앞뒤 빈칸은 밖으로 뺀다** — `** 굵게 **`는 마크다운에서 굵게가 아니다', () => {
    expect(md(p(t('앞 '), t(' 굵게 ', [bold]), t(' 뒤')))).toBe('앞  **굵게**  뒤');
    expect(md(p(t('a'), t('  ', [bold]), t('b')))).toBe('a  b');
  });

  it('코드 안은 이스케이프하지 않고, 안에 백틱이 있으면 더 긴 백틱으로 감싼다', () => {
    expect(md(p(t('a*b', [{ type: 'code' }])))).toBe('`a*b`');
    expect(md(p(t('a`b', [{ type: 'code' }])))).toBe('``a`b``');
    // 백틱으로 시작하거나 끝나면 빈칸을 둔다 (CommonMark)
    expect(md(p(t('`x', [{ type: 'code' }])))).toBe('`` `x ``');
  });

  it('코드와 다른 서식이 함께면 코드 밖을 감싼다', () => {
    expect(md(p(t('x', [bold, { type: 'code' }])))).toBe('**`x`**');
  });

  it('**밑줄은 표기가 없어 글자만 남긴다**', () => {
    expect(md(p(t('밑줄', [{ type: 'underline' }])))).toBe('밑줄');
  });

  it('허용 목록 밖의 마크는 무시하되 글자는 남긴다', () => {
    expect(md(p(t('x', [{ type: 'highlight' }])))).toBe('x');
  });
});

describe('링크 (FR-1142)', () => {
  it('허용 주소는 링크가 된다', () => {
    expect(md(p(t('여기', [link('https://wiki.example.internal/x')])))).toBe('[여기](https://wiki.example.internal/x)');
    expect(md(p(t('내부', [link('/pages/1')])))).toBe('[내부](/pages/1)');
  });

  it('**허용되지 않은 주소는 링크로 만들지 않는다** — 글자는 남는다', () => {
    expect(md(p(t('여기', [link('javascript:alert(1)')])))).toBe('여기');
    expect(md(p(t('여기', [{ type: 'link', attrs: {} }])))).toBe('여기');
  });

  it('주소의 빈칸·괄호는 링크를 끊지 않게 바꾼다', () => {
    expect(md(p(t('x', [link('/pages/(1) a')])))).toBe('[x](/pages/%281%29%20a)');
  });

  it('링크 글자도 이스케이프한다', () => {
    expect(md(p(t('a*b', [link('/p')])))).toBe('[a\\*b](/p)');
  });
});

describe('이스케이프 — 문서의 글자가 붙인 곳에서 서식이 되지 않게 (D.7)', () => {
  it('어디서나 이스케이프하는 기호', () => {
    expect(md(p(t('a*b_c`d[e]f~g<h\\i')))).toBe('a\\*b\\_c\\`d\\[e\\]f\\~g\\<h\\\\i');
  });

  it.each([
    ['# 제목아님', '\\# 제목아님'],
    ['> 인용아님', '\\> 인용아님'],
    ['- 목록아님', '\\- 목록아님'],
    ['+ 목록아님', '\\+ 목록아님'],
    ['= 아님', '\\= 아님'],
    ['1. 번호아님', '1\\. 번호아님'],
    ['12) 번호아님', '12\\) 번호아님'],
    ['  - 들여 쓴 목록아님', '  \\- 들여 쓴 목록아님'],
  ])('줄 머리의 %s', (text, out) => {
    expect(md(p(t(text)))).toBe(out);
  });

  it('줄 가운데의 같은 기호는 그대로 둔다', () => {
    expect(md(p(t('a # b > c - d 1. e')))).toBe('a # b > c - d 1. e');
  });

  it('줄바꿈 뒤도 줄 머리다', () => {
    expect(md(p(t('a'), br, t('# b')))).toBe('a\\\n\\# b');
  });
});

describe('목록', () => {
  it('글머리 목록', () => {
    expect(md(ul(li(p(t('하나'))), li(p(t('둘')))))).toBe('- 하나\n- 둘');
  });

  it('번호 목록은 시작 번호를 지킨다', () => {
    expect(md(ol(3, li(p(t('셋'))), li(p(t('넷')))))).toBe('3. 셋\n4. 넷');
    expect(md(ol(null, li(p(t('a')))))).toBe('1. a');
  });

  it('안쪽 목록은 표지 너비만큼 들여 쓴다', () => {
    expect(md(ul(li(p(t('a')), ul(li(p(t('b')))))))).toBe('- a\n  - b');
    expect(md(ol(1, li(p(t('a')), ul(li(p(t('b')))))))).toBe('1. a\n   - b');
    expect(md(ol(10, li(p(t('a')), ul(li(p(t('b')))))))).toBe('10. a\n    - b');
  });

  it('한 항목 안의 문단 둘은 빈 줄로 나누고 들여 쓴다', () => {
    expect(md(ul(li(p(t('a')), p(t('b')))))).toBe('- a\n\n  b');
  });

  it('빈 항목은 표지만 남는다', () => {
    expect(md(ul(li(), li(p(t('b')))))).toBe('-\n- b');
  });
});

describe('인용·코드 블록', () => {
  it('인용은 줄마다 `> `, 빈 줄은 `>`', () => {
    expect(md(bq(p(t('a')), p(t('b'))))).toBe('> a\n>\n> b');
    expect(md(bq(ul(li(p(t('a'))))))).toBe('> - a');
  });

  it('코드 블록은 언어를 지키고 안을 건드리지 않는다', () => {
    const code: DocNode = { type: 'codeBlock', attrs: { language: 'ts' }, content: [t('const a = 1 * 2;\nconst b = [a];')] };
    expect(md(code)).toBe('```ts\nconst a = 1 * 2;\nconst b = [a];\n```');
  });

  it('**안에 백틱 셋이 있으면 울타리를 더 길게** — 코드가 울타리를 닫지 않게', () => {
    const code: DocNode = { type: 'codeBlock', attrs: {}, content: [t('x\n```\ny')] };
    expect(md(code)).toBe('````\nx\n```\ny\n````');
  });

  it('언어 이름이 이상하면 뺀다 — 울타리 줄은 그대로 코드 밖이다', () => {
    const code: DocNode = { type: 'codeBlock', attrs: { language: 'ts"><x' }, content: [t('a')] };
    expect(md(code)).toBe('```\na\n```');
  });

  it('빈 코드 블록', () => {
    expect(md({ type: 'codeBlock', attrs: { language: null } })).toBe('```\n```');
  });
});

describe('표', () => {
  it('첫 줄이 머리이고 칸의 `|`는 이스케이프한다', () => {
    const out = md(
      table(
        tr(cell('tableHeader', {}, p(t('이름'))), cell('tableHeader', {}, p(t('값')))),
        tr(cell('tableCell', {}, p(t('a|b'))), cell('tableCell', {}, p(t('1')))),
      ),
    );
    expect(out).toBe('| 이름 | 값 |\n| --- | --- |\n| a\\|b | 1 |');
  });

  it('머리 칸의 정렬을 옮긴다', () => {
    const out = md(
      table(
        tr(cell('tableHeader', { align: 'center' }, p(t('a'))), cell('tableHeader', { align: 'right' }, p(t('b'))), cell('tableHeader', { align: 'left' }, p(t('c')))),
      ),
    );
    expect(out).toBe('| a | b | c |\n| :---: | ---: | :--- |');
  });

  it('**칸 합치기는 표기가 없어 첫 칸에 두고 나머지를 비운다** — 열 수가 줄마다 같아야 표가 된다', () => {
    const out = md(
      table(
        tr(cell('tableCell', { colspan: 2 }, p(t('합침')))),
        tr(cell('tableCell', {}, p(t('a'))), cell('tableCell', {}, p(t('b')))),
      ),
    );
    expect(out).toBe('| 합침 |  |\n| --- | --- |\n| a | b |');
  });

  it('칸 안의 블록 여럿과 줄바꿈은 빈칸으로 잇는다', () => {
    const out = md(table(tr(cell('tableCell', {}, p(t('a')), p(t('b'), br, t('c'))))));
    expect(out).toBe('| a b c |\n| --- |');
  });
});

describe('허용 목록 (FR-1142)', () => {
  it('**목록 밖 노드는 자식까지 통째로 뺀다** — HTML 내보내기와 같다', () => {
    expect(md(p(t('a')), { type: 'script', content: [t('b')] })).toBe('a');
  });
});

describe('pageMarkdown · pageText (FR-1141)', () => {
  it('마크다운은 제목을 1단계 제목으로 얹는다', () => {
    expect(pageMarkdown('제목 *별*', doc(p(t('본문'))))).toBe('# 제목 \\*별\\*\n\n본문');
    expect(pageMarkdown('제목', doc(p()))).toBe('# 제목');
  });

  it('텍스트는 제목 + 빈 줄 + 검색 인덱스와 같은 평문', () => {
    expect(pageText('제목', doc(p(t('a')), p(t('b', [bold]))))).toBe('제목\n\na\nb');
    expect(pageText('제목', doc(p()))).toBe('제목');
  });
});

/** 드문 모양 — 검증을 거치지 않은 JSON이 와도 던지지 않고, 글자를 잃지 않는다 (A등급 분기) */
describe('드문 모양', () => {
  it('제자리가 아닌 노드도 안의 글자를 잃지 않는다', () => {
    expect(md(p({ type: 'heading', attrs: { level: 1 }, content: [t('안쪽')] }))).toBe('안쪽');
    expect(md(t('# 글자만'))).toBe('\\# 글자만');
    expect(md(br, p(t('a')))).toBe('a');
    expect(md(li(p(t('항목만'))))).toBe('항목만');
    expect(md(tr(cell('tableCell', {}, p(t('칸만')))))).toBe('칸만');
  });

  it('빈 것들은 건너뛴다', () => {
    expect(md(p(br, br), h(2), bq(p()), ul(li(p())), p(t('끝')))).toBe('-\n\n끝');
    expect(md(p({ type: 'text', text: '' }), p(t('a')))).toBe('a');
    expect(md(p(t('a'), br))).toBe('a');
    expect(md(p(br, t('a')))).toBe('a');
  });

  it('목록 밖 노드·마크는 어디서든 뺀다', () => {
    expect(md(ul(li(p(t('a'))), { type: 'widget' }))).toBe('- a');
    expect(md(ul(li(p(t('a')), { type: 'widget' }, p())))).toBe('- a');
    expect(md(p(t('a'), { type: 'widget', content: [t('b')] }))).toBe('a');
    expect(md(p({ type: 'text', text: 'x' }))).toBe('x');
    expect(md(p(t('x', [{ type: 'link', attrs: { href: 3 } }])))).toBe('x');
  });

  it('번호 목록의 시작 번호가 이상하면 1부터', () => {
    expect(md(ol(-1, li(p(t('a')))))).toBe('1. a');
    expect(md(ol(1.5, li(p(t('a')))))).toBe('1. a');
    expect(md({ type: 'orderedList', content: [li(p(t('a')))] })).toBe('1. a');
    expect(md(ol(0, li(p(t('a')))))).toBe('0. a');
  });

  it('코드 블록은 글자 노드만 모은다', () => {
    expect(md({ type: 'codeBlock', attrs: {}, content: [t('a'), br, t('b')] })).toBe('```\nab\n```');
    expect(md({ type: 'codeBlock', attrs: { language: 'c++' }, content: [t('x')] })).toBe('```c++\nx\n```');
  });

  it('칸 합치기 값이 이상하면 1칸, 너무 크면 상한까지', () => {
    const one = (colspan: unknown) => md(table(tr(cell('tableCell', { colspan }, p(t('a'))))));
    expect(one(0)).toBe('| a |\n| --- |');
    expect(one(1.5)).toBe('| a |\n| --- |');
    expect(one('2')).toBe('| a |\n| --- |');
    expect(one(1_000_000).split('\n')[1].split('---').length - 1).toBe(100);
  });

  it('줄마다 칸 수가 달라도 가장 긴 줄에 맞춘다 — 정렬이 없는 칸은 `---`', () => {
    const out = md(
      table(
        tr(cell('tableHeader', { align: 'center' }, p(t('a')))),
        tr(cell('tableCell', {}, p(t('b'))), cell('tableCell', {}, p(t('c')))),
      ),
    );
    expect(out).toBe('| a |  |\n| :---: | --- |\n| b | c |');
  });

  it('칸 안의 목록·빈 블록·목록 밖 노드', () => {
    const out = md(table(tr(cell('tableCell', {}, ul(li(p(t('x'))), li(p(t('y')))), p(), { type: 'widget' }))));
    expect(out).toBe('| - x - y |\n| --- |');
  });

  it('표 줄·칸이 아닌 것은 건너뛰고, 칸이 하나도 없으면 표가 없다', () => {
    expect(md(table(p(t('줄 아님'))))).toBe('');
    expect(md(table(tr(p(t('칸 아님')))))).toBe('');
    expect(md(table())).toBe('');
  });

  it('marks가 없는 글자, 제목의 단계가 없는 것', () => {
    expect(md(p({ type: 'text', text: 'plain' }))).toBe('plain');
    expect(md({ type: 'heading', content: [t('무단계')] })).toBe('# 무단계');
  });
});
