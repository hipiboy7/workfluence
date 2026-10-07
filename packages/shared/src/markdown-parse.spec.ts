import { describe, expect, it } from 'vitest';
import { DOCUMENT_SCHEMA_VERSION, MARKDOWN_LIMITS } from './constants';
import { validateDocument, type DocMark, type DocNode } from './document';
import { renderDocMarkdown } from './markdown';
import { parseMarkdown } from './markdown-parse';

/**
 * A등급 — **테스트 먼저** (3절, docs/spinoff/public-api 설계서 3.4절·FR-2215).
 *
 * 공개 API가 에이전트의 마크다운을 문서 JSON으로 바꾼다. 지키는 것 셋 — ① 지원하는 문법이 문서의 모양으로 옮겨 가는가 ② **허용 목록 밖은 만들지 않고
 * 거절하는가**(원시 HTML·그림·스크립트 링크) ③ 어떤 입력에도 던지지 않고, 성공하면 **정본 검증(`validateDocument`)을 통과하는가**
 */

const ok = (md: string): DocNode => {
  const r = parseMarkdown(md);
  if (!r.ok) throw new Error(`변환 실패: ${r.errors.join(' / ')}`);
  return r.doc;
};
const fail = (md: string): string[] => {
  const r = parseMarkdown(md);
  if (r.ok) throw new Error(`거절되어야 한다: ${JSON.stringify(md.slice(0, 60))}`);
  return r.errors;
};
const body = (md: string): DocNode[] => ok(md).content ?? [];

const t = (text: string, marks?: DocMark[]): DocNode => ({ type: 'text', text, ...(marks ? { marks } : {}) });
const p = (...c: DocNode[]): DocNode => ({ type: 'paragraph', ...(c.length ? { content: c } : {}) });
const bold: DocMark = { type: 'bold' };
const italic: DocMark = { type: 'italic' };
const strike: DocMark = { type: 'strike' };
const code: DocMark = { type: 'code' };
const link = (href: string): DocMark => ({ type: 'link', attrs: { href } });

describe('문서 틀', () => {
  it('최상위는 doc이고 스키마 버전을 단다', () => {
    expect(ok('안녕')).toEqual({ type: 'doc', attrs: { schemaVersion: DOCUMENT_SCHEMA_VERSION }, content: [p(t('안녕'))] });
  });

  it('빈 입력·빈 줄뿐인 입력은 빈 문단 하나다 — 문서는 비어 있을 수 없다', () => {
    expect(body('')).toEqual([p()]);
    expect(body('\n\n  \n')).toEqual([p()]);
  });

  it('줄 끝은 CRLF·CR도 받는다', () => {
    expect(body('가\r\n\r\n나\r\r다')).toEqual([p(t('가')), p(t('나')), p(t('다'))]);
  });
});

describe('문단', () => {
  it('빈 줄로 문단을 나누고, 그냥 줄바꿈은 빈칸 하나로 잇는다', () => {
    expect(body('하나\n둘\n\n셋')).toEqual([p(t('하나 둘')), p(t('셋'))]);
  });

  it('줄 끝 `\\`와 빈칸 둘은 줄바꿈(hardBreak)이다', () => {
    expect(body('가\\\n나')).toEqual([p(t('가'), { type: 'hardBreak' }, t('나'))]);
    expect(body('가  \n나')).toEqual([p(t('가'), { type: 'hardBreak' }, t('나'))]);
  });

  it('문단 끝의 `\\`와 빈칸 둘은 줄바꿈이 아니다', () => {
    expect(body('끝\\')).toEqual([p(t('끝\\'))]);
    expect(body('끝  ')).toEqual([p(t('끝'))]);
  });

  it('들여쓰기 4칸 이상도 코드가 아니라 문단이다 (들여 쓴 코드 블록은 지원하지 않는다)', () => {
    expect(body('    들여씀')).toEqual([p(t('들여씀'))]);
  });
});

describe('제목', () => {
  it('# 한 개~여섯 개가 1~6단계', () => {
    for (let n = 1; n <= 6; n++) {
      expect(body(`${'#'.repeat(n)} 제목`)).toEqual([{ type: 'heading', attrs: { level: n }, content: [t('제목')] }]);
    }
  });

  it('일곱 개이거나 `#` 뒤에 빈칸이 없으면 제목이 아니라 글자다', () => {
    expect(body('####### 일곱')).toEqual([p(t('####### 일곱'))]);
    expect(body('#태그')).toEqual([p(t('#태그'))]);
  });

  it('끝의 `#`들은 닫는 표지로 떼고, 안의 서식은 그대로 읽는다', () => {
    expect(body('## 제목 ##')).toEqual([{ type: 'heading', attrs: { level: 2 }, content: [t('제목')] }]);
    expect(body('# **굵게** 제목')).toEqual([{ type: 'heading', attrs: { level: 1 }, content: [t('굵게', [bold]), t(' 제목')] }]);
  });

  it('빈 제목은 빈 제목 노드다', () => {
    expect(body('#')).toEqual([{ type: 'heading', attrs: { level: 1 } }]);
  });

  it('문단 바로 뒤에 붙여 써도 제목이 문단을 끊는다', () => {
    expect(body('문단\n# 제목')).toEqual([p(t('문단')), { type: 'heading', attrs: { level: 1 }, content: [t('제목')] }]);
  });
});

describe('가로줄·인용', () => {
  it('---, ***, ___ (세 개 이상, 사이 빈칸 허용)는 가로줄이다', () => {
    for (const hr of ['---', '***', '___', '- - -', '*****']) expect(body(hr)).toEqual([{ type: 'horizontalRule' }]);
  });

  it('인용은 `>`로 시작하고 안의 블록을 읽는다', () => {
    expect(body('> 인용\n> 둘째')).toEqual([{ type: 'blockquote', content: [p(t('인용 둘째'))] }]);
    expect(body('> # 제목\n>\n> 글')).toEqual([
      { type: 'blockquote', content: [{ type: 'heading', attrs: { level: 1 }, content: [t('제목')] }, p(t('글'))] },
    ]);
  });

  it('인용 안의 인용', () => {
    expect(body('> > 안쪽')).toEqual([{ type: 'blockquote', content: [{ type: 'blockquote', content: [p(t('안쪽'))] }] }]);
  });

  it('빈 인용은 빈 문단 하나를 담는다 — 인용은 비어 있을 수 없다', () => {
    expect(body('>')).toEqual([{ type: 'blockquote', content: [p()] }]);
  });
});

describe('코드 블록', () => {
  it('울타리 사이를 글자 그대로 담고, 안의 서식 기호를 읽지 않는다', () => {
    expect(body('```\n**a** # b\n```')).toEqual([{ type: 'codeBlock', content: [t('**a** # b')] }]);
  });

  it('언어 이름은 첫 낱말, 허용 글자만', () => {
    expect(body('```ts\nx\n```')).toEqual([{ type: 'codeBlock', attrs: { language: 'ts' }, content: [t('x')] }]);
    expect(body('```c++ extra\nx\n```')[0]).toMatchObject({ attrs: { language: 'c++' } });
    expect(body('```<b>\nx\n```')[0]).toEqual({ type: 'codeBlock', content: [t('x')] });
  });

  it('~~~ 울타리도 받고, 닫는 울타리는 여는 것보다 길거나 같아야 한다', () => {
    expect(body('~~~\na\n~~~')).toEqual([{ type: 'codeBlock', content: [t('a')] }]);
    expect(body('````\n```\n````')).toEqual([{ type: 'codeBlock', content: [t('```')] }]);
  });

  it('닫지 않은 울타리는 끝까지가 코드다', () => {
    expect(body('```\n가\n나')).toEqual([{ type: 'codeBlock', content: [t('가\n나')] }]);
  });

  it('빈 코드 블록은 글자 없는 노드다', () => {
    expect(body('```\n```')).toEqual([{ type: 'codeBlock' }]);
  });

  it('코드 블록의 글자는 마크를 받지 않는다 (P9 D.2)', () => {
    expect(ok('```\n**x**\n```')).toSatisfy((d: DocNode) => validateDocument(d).ok);
  });
});

describe('목록', () => {
  it('글머리 기호는 -, *, +', () => {
    for (const m of ['-', '*', '+']) {
      expect(body(`${m} 하나\n${m} 둘`)).toEqual([
        { type: 'bulletList', content: [{ type: 'listItem', content: [p(t('하나'))] }, { type: 'listItem', content: [p(t('둘'))] }] },
      ]);
    }
  });

  it('번호 목록은 시작 번호를 start에 담는다 (`1.`·`1)` 둘 다)', () => {
    expect(body('1. 가\n2. 나')[0]).toMatchObject({ type: 'orderedList', attrs: { start: 1 } });
    expect(body('5) 가\n6) 나')[0]).toMatchObject({ type: 'orderedList', attrs: { start: 5 } });
  });

  it('**시작 번호는 9자리까지만** — 그 이상은 목록이 아니라 글자다 (CommonMark)', () => {
    expect(body('1234567890. 길다')).toEqual([p(t('1234567890. 길다'))]);
  });

  it('들여 쓴 줄은 안쪽 목록이다', () => {
    expect(body('- 가\n  - 나\n  - 다\n- 라')).toEqual([
      {
        type: 'bulletList',
        content: [
          {
            type: 'listItem',
            content: [p(t('가')), { type: 'bulletList', content: [{ type: 'listItem', content: [p(t('나'))] }, { type: 'listItem', content: [p(t('다'))] }] }],
          },
          { type: 'listItem', content: [p(t('라'))] },
        ],
      },
    ]);
  });

  it('항목 안에 빈 줄을 두고 들여 쓰면 문단이 둘이다', () => {
    expect(body('- 가\n\n  나')).toEqual([{ type: 'bulletList', content: [{ type: 'listItem', content: [p(t('가')), p(t('나'))] }] }]);
  });

  it('들여 쓰지 않은 이어지는 줄(게으른 이음)은 같은 문단이다', () => {
    expect(body('- 가\n나')).toEqual([{ type: 'bulletList', content: [{ type: 'listItem', content: [p(t('가 나'))] }] }]);
  });

  it('빈 항목은 빈 문단을 담는다', () => {
    expect(body('-\n- 둘')).toEqual([
      { type: 'bulletList', content: [{ type: 'listItem', content: [p()] }, { type: 'listItem', content: [p(t('둘'))] }] },
    ]);
  });

  it('**항목의 첫 자식은 문단이어야 한다** — 제목·코드로 시작하면 빈 문단을 앞에 둔다 (FIRST_CHILD)', () => {
    const item = (body('- # 제목')[0].content as DocNode[])[0];
    expect(item.content?.[0]).toEqual(p());
    expect(validateDocument(ok('- # 제목')).ok).toBe(true);
    expect(validateDocument(ok('- ```\n  x\n  ```')).ok).toBe(true);
  });

  it('항목 안에 인용·코드·표', () => {
    expect(validateDocument(ok('- 가\n  > 인용\n  ```\n  코드\n  ```')).ok).toBe(true);
  });

  it('번호 목록 뒤의 글머리 목록은 다른 목록이다', () => {
    expect(body('1. 가\n- 나').map((n) => n.type)).toEqual(['orderedList', 'bulletList']);
  });

  it('문단 바로 뒤의 `1.`이 아닌 번호는 문단을 끊지 못한다 (CommonMark)', () => {
    expect(body('문단\n2. 둘')).toEqual([p(t('문단 2. 둘'))]);
    expect(body('문단\n1. 하나')[1]).toMatchObject({ type: 'orderedList' });
  });
});

describe('표 (GFM)', () => {
  const cellP = (s: string, kind: 'tableCell' | 'tableHeader' = 'tableCell', align?: string): DocNode => ({
    type: kind,
    ...(align ? { attrs: { align } } : {}),
    content: [s ? p(t(s)) : p()],
  });

  it('머리 줄 + 구분 줄 + 본문 줄', () => {
    expect(body('| 이름 | 값 |\n| --- | --- |\n| a | 1 |\n| b | 2 |')).toEqual([
      {
        type: 'table',
        content: [
          { type: 'tableRow', content: [cellP('이름', 'tableHeader'), cellP('값', 'tableHeader')] },
          { type: 'tableRow', content: [cellP('a'), cellP('1')] },
          { type: 'tableRow', content: [cellP('b'), cellP('2')] },
        ],
      },
    ]);
  });

  it('구분 줄의 `:`가 열 정렬이고 머리·본문 칸 모두에 붙는다', () => {
    const rows = (body('| a | b | c |\n|:--|:-:|--:|\n| 1 | 2 | 3 |')[0].content ?? []) as DocNode[];
    for (const row of rows) {
      const kind = row === rows[0] ? 'tableHeader' : 'tableCell';
      expect(row.content).toEqual([cellP(kind === 'tableHeader' ? 'a' : '1', kind, 'left'), cellP(kind === 'tableHeader' ? 'b' : '2', kind, 'center'), cellP(kind === 'tableHeader' ? 'c' : '3', kind, 'right')]);
    }
  });

  it('바깥 `|`가 없어도 된다', () => {
    expect(body('a | b\n--|--\n1 | 2')[0].type).toBe('table');
  });

  it('칸 수는 머리 줄에 맞춘다 — 모자란 줄은 빈 칸으로 채우고 넘치는 칸은 버린다', () => {
    const rows = (body('| a | b |\n|---|---|\n| 1 |\n| 1 | 2 | 3 |')[0].content ?? []) as DocNode[];
    expect(rows.map((r) => r.content?.length)).toEqual([2, 2, 2]);
    expect(rows[1].content?.[1]).toEqual(cellP(''));
  });

  it('칸 안의 `\\|`는 글자 `|`이고, 칸 안에서 서식을 읽는다', () => {
    const rows = (body('| a\\|b | **c** |\n|---|---|')[0].content ?? []) as DocNode[];
    expect(rows[0].content?.[0]).toEqual({ type: 'tableHeader', content: [p(t('a|b'))] });
    expect(rows[0].content?.[1]).toEqual({ type: 'tableHeader', content: [p(t('c', [bold]))] });
  });

  it('코드 조각 안의 `|`도 칸을 나눈다 (GFM) — `\\|`로 쓴다', () => {
    const rows = (body('| `a\\|b` |\n|---|')[0].content ?? []) as DocNode[];
    expect(rows[0].content?.[0]).toEqual({ type: 'tableHeader', content: [p(t('a|b', [code]))] });
  });

  it('구분 줄이 없으면 표가 아니라 문단이다', () => {
    expect(body('| a | b |\n| 1 | 2 |')[0].type).toBe('paragraph');
  });

  it('머리 줄과 구분 줄의 칸 수가 다르면 표가 아니다 (GFM)', () => {
    expect(body('| a | b |\n|---|')[0].type).toBe('paragraph');
  });

  it('표는 빈 줄이나 다른 블록에서 끝난다', () => {
    expect(body('| a |\n|---|\n| 1 |\n\n뒤').map((n) => n.type)).toEqual(['table', 'paragraph']);
    expect(body('| a |\n|---|\n| 1 |\n# 제목').map((n) => n.type)).toEqual(['table', 'heading']);
  });
});

describe('글 안의 서식', () => {
  it('굵게·기울임·취소선·코드', () => {
    expect(body('**굵게** *기울임* ~~취소~~ `코드`')).toEqual([
      p(t('굵게', [bold]), t(' '), t('기울임', [italic]), t(' '), t('취소', [strike]), t(' '), t('코드', [code])),
    ]);
  });

  it('밑줄 표기(`__`·`_`)도 굵게·기울임이다', () => {
    expect(body('__굵게__ _기울임_')).toEqual([p(t('굵게', [bold]), t(' '), t('기울임', [italic]))]);
  });

  it('겹쳐 쓴 서식은 마크가 함께 붙는다', () => {
    expect(body('***둘다***')).toEqual([p(t('둘다', [bold, italic]))]);
    expect(body('**굵게 *기울임* 굵게**')).toEqual([p(t('굵게 ', [bold]), t('기울임', [bold, italic]), t(' 굵게', [bold]))]);
  });

  it('코드 조각 안은 서식을 읽지 않고, 백틱 덩어리 길이가 같아야 닫는다', () => {
    expect(body('`**a**`')).toEqual([p(t('**a**', [code]))]);
    expect(body('`` a`b ``')).toEqual([p(t('a`b', [code]))]);
  });

  it('닫는 표지가 없으면 글자 그대로다', () => {
    expect(body('**열기만')).toEqual([p(t('**열기만'))]);
    expect(body('a * b * c')).toEqual([p(t('a * b * c'))]);
    expect(body('`닫지 않음')).toEqual([p(t('`닫지 않음'))]);
  });

  it('**낱말 가운데의 `_`는 서식이 아니다** — snake_case_name', () => {
    expect(body('snake_case_name')).toEqual([p(t('snake_case_name'))]);
  });

  it('여는 표지 뒤나 닫는 표지 앞의 빈칸은 서식이 아니다', () => {
    expect(body('** 굵게 **')).toEqual([p(t('** 굵게 **'))]);
  });

  it('`\\`로 이스케이프한 기호는 글자다', () => {
    expect(body('\\*별\\* \\# \\[대괄호\\] \\\\')).toEqual([p(t('*별* # [대괄호] \\'))]);
  });

  it('이스케이프할 수 없는 글자 앞의 `\\`는 글자 그대로다', () => {
    expect(body('a\\b')).toEqual([p(t('a\\b'))]);
  });

  it('같은 서식의 이웃 글자는 한 노드로 합친다', () => {
    expect(body('가 \\* 나')).toEqual([p(t('가 * 나'))]);
  });
});

describe('링크', () => {
  it('[글](주소)', () => {
    expect(body('[위키](https://wiki.example.internal/a)')).toEqual([p(t('위키', [link('https://wiki.example.internal/a')]))]);
  });

  it('내부 경로와 앵커', () => {
    expect(body('[페이지](/pages/abc) [아래](#끝)')).toEqual([p(t('페이지', [link('/pages/abc')]), t(' '), t('아래', [link('#끝')]))]);
  });

  it('링크 글 안의 서식을 읽는다', () => {
    expect(body('[**굵게**](https://a.example)')).toEqual([p(t('굵게', [bold, link('https://a.example')]))]);
  });

  it('주소 안의 짝 맞는 괄호와 제목("…")', () => {
    expect(body('[a](https://a.example/x_(y))')).toEqual([p(t('a', [link('https://a.example/x_(y)')]))]);
    expect(body('[a](https://a.example "제목")')).toEqual([p(t('a', [link('https://a.example')]))]);
  });

  it('<…>로 감싼 주소는 빈칸을 가질 수 있다', () => {
    expect(body('[a](<https://a.example/x y>)')[0].content?.[0].marks).toEqual([link('https://a.example/x y')]);
  });

  it('`<http(s)://…>` 자동 링크', () => {
    expect(body('<https://a.example/x>')).toEqual([p(t('https://a.example/x', [link('https://a.example/x')]))]);
  });

  it('대괄호 뒤에 괄호가 없으면 링크가 아니라 글자다', () => {
    expect(body('[위키]')).toEqual([p(t('[위키]'))]);
    expect(body('[a] (https://a.example)')).toEqual([p(t('[a] (https://a.example)'))]);
  });

  it('코드 조각 안의 링크 표기는 읽지 않는다', () => {
    expect(body('`[a](b)`')).toEqual([p(t('[a](b)', [code]))]);
  });

  it('본문에 그냥 적은 주소는 링크로 만들지 않는다', () => {
    expect(body('https://a.example')).toEqual([p(t('https://a.example'))]);
  });
});

describe('받지 않는 것 — 400의 까닭을 말한다', () => {
  it('허용되지 않는 링크 주소 — javascript:·data:·//·상대 경로', () => {
    for (const href of ['javascript:alert(1)', 'data:text/html,x', '//evil.example', '/\\evil.example', 'mailto:a@b.c', 'ftp://x', 'a/b']) {
      expect(fail(`[x](${href})`).join(' ')).toMatch(/링크 주소/);
    }
  });

  it('자동 링크도 같은 판정이다', () => {
    expect(ok('<http://a.example>')).toBeTruthy();
    expect(fail('<javascript:alert(1)>').join(' ')).toMatch(/HTML|링크/);
  });

  it('원시 HTML — 태그·주석·처리 지시', () => {
    for (const html of ['<b>x</b>', '<script>alert(1)</script>', '<!-- c -->', '<?php ?>', '<div>', '</div>', '<img src=x onerror=y>']) {
      expect(fail(`앞 ${html} 뒤`).join(' ')).toMatch(/HTML/);
    }
  });

  it('`<` 뒤가 빈칸·숫자·기호이면 그냥 글자다', () => {
    expect(body('a < b, 1<2, <3')).toEqual([p(t('a < b, 1<2, <3'))]);
  });

  it('코드 안의 HTML은 글자다', () => {
    expect(body('`<b>`')).toEqual([p(t('<b>', [code]))]);
    expect(body('```\n<script>\n```')).toEqual([{ type: 'codeBlock', content: [t('<script>')] }]);
  });

  it('이스케이프한 `<`는 글자다', () => {
    expect(body('\\<b>')).toEqual([p(t('<b>'))]);
  });

  it('그림 — 문서에 그림 노드가 없다', () => {
    expect(fail('![대체](https://a.example/x.png)').join(' ')).toMatch(/그림/);
    expect(fail('![대체](/api/attachments/abc)').join(' ')).toMatch(/그림/);
  });

  it('이스케이프한 `!`는 그림이 아니다', () => {
    expect(body('\\![a](https://a.example)')).toEqual([p(t('!'), t('a', [link('https://a.example')]))]);
  });

  it('입력이 상한을 넘으면 거절한다', () => {
    expect(fail('가'.repeat(MARKDOWN_LIMITS.maxInputChars + 1)).join(' ')).toMatch(/너무 길다/);
  });

  it('인용·목록을 너무 깊이 겹치면 거절한다 — 재귀가 끝없이 내려가지 않는다', () => {
    expect(fail('> '.repeat(MARKDOWN_LIMITS.maxNesting + 5) + 'x').join(' ')).toMatch(/깊/);
    expect(fail(Array.from({ length: MARKDOWN_LIMITS.maxNesting + 5 }, (_, i) => `${'  '.repeat(i)}- x`).join('\n')).join(' ')).toMatch(/깊/);
  });

  it('까닭은 입력한 글을 되읊지 않는다 — 감사·로그로 가도 본문이 새지 않는다', () => {
    const secret = '비밀문장12345';
    const errors = [...fail(`${secret} <script>`), ...fail(`[${secret}](javascript:x)`), ...fail(`![${secret}](x)`)];
    expect(errors.join(' ')).not.toContain(secret);
  });

  it('오류는 줄 번호를 말한다', () => {
    expect(fail('가\n나\n<b>').join(' ')).toMatch(/3/);
  });
});

describe('성능 — 끝없이 오래 걸리는 입력이 없다', () => {
  const within = (ms: number, f: () => void) => {
    const start = Date.now();
    f();
    expect(Date.now() - start).toBeLessThan(ms);
  };

  it('짝 없는 강조 표지 수만 개', () => {
    within(3000, () => parseMarkdown('*a '.repeat(30_000)));
    within(3000, () => parseMarkdown('**a '.repeat(20_000)));
    within(3000, () => parseMarkdown('_a '.repeat(30_000)));
  });

  it('닫지 않은 대괄호·백틱·꺾쇠 수만 개', () => {
    within(3000, () => parseMarkdown('[a'.repeat(30_000)));
    within(3000, () => parseMarkdown('`a '.repeat(30_000)));
    within(3000, () => parseMarkdown('<a '.repeat(30_000)));
    within(3000, () => parseMarkdown('[a](b'.repeat(20_000)));
  });

  it('긴 표·긴 목록', () => {
    within(3000, () => parseMarkdown(`| a | b |\n|---|---|\n${'| 1 | 2 |\n'.repeat(5000)}`));
    within(3000, () => parseMarkdown('- 항목\n'.repeat(20_000)));
  });
});

describe('보장 — 어떤 입력에도 던지지 않고, 성공하면 정본 검증을 통과한다', () => {
  // 시드가 고정된 의사 난수 — 시험이 흔들리지 않는다
  const rng = (seed: number) => () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  const pieces = ['#', '##', ' ', '\n', '\n\n', '-', '*', '**', '_', '~~', '`', '```', '>', '|', '---', ':--', '[', ']', '(', ')', '!', '<', '>', '\\', '1.', '2)', '가', 'a', 'http://a.example', '  ', '\t', 'javascript:'];

  it('무작위로 이은 조각 5천 개', () => {
    const next = rng(20261007);
    for (let i = 0; i < 5000; i++) {
      const n = 1 + Math.floor(next() * 24);
      const md = Array.from({ length: n }, () => pieces[Math.floor(next() * pieces.length)]).join('');
      const r = parseMarkdown(md);
      if (r.ok) {
        const v = validateDocument(r.doc);
        if (!v.ok) throw new Error(`정본 검증 실패: ${JSON.stringify(md)} → ${v.errors.join(' / ')}`);
      } else {
        expect(r.errors.length).toBeGreaterThan(0);
      }
    }
  });

  it('성공한 문서의 텍스트 노드는 비어 있지 않고 마크는 허용 목록 안이다', () => {
    const r = ok('# 제목\n\n- **가** `나` [다](/x)\n\n| a |\n|---|\n| ~~b~~ |\n\n> 인용\n\n```\n코드\n```');
    expect(validateDocument(r)).toEqual({ ok: true });
  });
});

describe('왕복 — 문서 → 마크다운 → 문서 (`renderDocMarkdown`이 쓴 것을 읽는다)', () => {
  const norm = (n: DocNode): DocNode => {
    const out: DocNode = { ...n };
    if (n.marks) out.marks = [...n.marks].sort((a, b) => a.type.localeCompare(b.type));
    if (n.content) out.content = n.content.map(norm);
    return out;
  };
  const doc = (...c: DocNode[]): DocNode => ({ type: 'doc', attrs: { schemaVersion: DOCUMENT_SCHEMA_VERSION }, content: c });
  const roundtrip = (d: DocNode): DocNode => ok(renderDocMarkdown(d));

  it('제목·문단·서식·링크', () => {
    const d = doc(
      { type: 'heading', attrs: { level: 2 }, content: [t('제목')] },
      p(t('가 '), t('굵게', [bold]), t(' '), t('기울임', [italic]), t(' '), t('취소', [strike]), t(' '), t('코드', [code]), t(' '), t('링크', [link('https://a.example/x')])),
    );
    expect(norm(roundtrip(d))).toEqual(norm(d));
  });

  it('줄바꿈·인용·가로줄·코드 블록', () => {
    const d = doc(
      p(t('가'), { type: 'hardBreak' }, t('나')),
      { type: 'blockquote', content: [p(t('인용'))] },
      { type: 'horizontalRule' },
      { type: 'codeBlock', attrs: { language: 'ts' }, content: [t('const a = `x`;\n\n  b')] },
    );
    expect(norm(roundtrip(d))).toEqual(norm(d));
  });

  it('중첩 목록과 번호 목록', () => {
    const li = (...c: DocNode[]): DocNode => ({ type: 'listItem', content: c });
    const d = doc(
      { type: 'bulletList', content: [li(p(t('가')), { type: 'orderedList', attrs: { start: 3 }, content: [li(p(t('나'))), li(p(t('다')))] }), li(p(t('라')))] },
      { type: 'orderedList', attrs: { start: 1 }, content: [li(p(t('하나'))), li(p(t('둘'), { type: 'hardBreak' }, t('셋')))] },
    );
    expect(norm(roundtrip(d))).toEqual(norm(d));
  });

  it('머리 줄이 있는 표(정렬 포함)', () => {
    const cell = (kind: 'tableCell' | 'tableHeader', text: string, align?: string): DocNode => ({ type: kind, ...(align ? { attrs: { align } } : {}), content: [p(t(text))] });
    const d = doc({
      type: 'table',
      content: [
        { type: 'tableRow', content: [cell('tableHeader', 'a', 'left'), cell('tableHeader', 'b', 'right')] },
        { type: 'tableRow', content: [cell('tableCell', '1', 'left'), cell('tableCell', 'x|y', 'right')] },
      ],
    });
    expect(norm(roundtrip(d))).toEqual(norm(d));
  });

  it('**글자가 서식이 되지 않는다** — 기호·줄 머리 표기·꺾쇠가 든 문단', () => {
    const texts = ['*별* _밑_ `백틱` ~~물결~~', '# 제목이 아니다', '- 목록이 아니다', '1. 번호가 아니다', '> 인용이 아니다', '[링크](아님)', '<b>태그 아님</b>', 'a\\b \\* c', '=== ---', '!\\[a](b)'];
    for (const text of texts) {
      const d = doc(p(t(text)));
      expect(roundtrip(d), text).toEqual(d);
    }
  });

  it('쓰고 읽고 다시 써도 같다 (멱등)', () => {
    const samples = ['# 제목\n\n문단 **굵게** `코드`', '- 가\n  - 나\n\n> 인용\n\n| a | b |\n|:-:|--:|\n| 1 | 2 |', '```\n코드\n```\n\n---\n\n끝'];
    for (const s of samples) {
      const once = ok(s);
      const twice = ok(renderDocMarkdown(once));
      expect(norm(twice)).toEqual(norm(once));
    }
  });
});
