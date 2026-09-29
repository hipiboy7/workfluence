import { describe, expect, it } from 'vitest';
import { mentionMail, testMail } from './compose';

/**
 * A등급 — **테스트 먼저** (3절, P18_설계서_Mail FR-1901). 메일 한 통의 제목·평문·마크다운. 평문은 Phase 6의 글 그대로다(P6 FR-755 — 문서 본문을
 * 싣지 않는다, 누가·어디서·문서 제목·링크). 마크다운은 사내 API의 `/send_markdown`으로 간다 — 제목·이름에 든 마크다운 글자가 서식이 되지 않게 한다
 */
const url = 'https://wiki.example.internal/pages/11111111-1111-4111-8111-111111111111';

describe('mentionMail', () => {
  it('**평문은 Phase 6의 글 그대로다** — 부른 사람·어디서·문서 제목·바로 가기', () => {
    const m = mentionMail({ callerName: '홍길동', where: '댓글', pageTitle: '회의록', pageUrl: url });
    expect(m.subject).toBe('[위키] 홍길동 님이 회원님을 불렀습니다');
    expect(m.text).toBe(['홍길동 님이 댓글에서 회원님을 불렀습니다.', '', '문서: 회의록', `바로 가기: ${url}`, '', '내용은 위키에서 확인해 주세요.'].join('\n'));
  });

  it('**부른 사람을 모르면 이름을 적지 않는다**(P8) — 제목도 본문도', () => {
    const m = mentionMail({ callerName: null, where: '문서', pageTitle: '회의록', pageUrl: url });
    expect(m.subject).toBe('[위키] 문서에서 회원님이 불렸습니다');
    expect(m.text.split('\n')[0]).toBe('문서에서 회원님이 불렸습니다.');
    expect(m.markdown.split('\n')[0]).toBe('문서에서 회원님이 불렸습니다.');
  });

  it('**주소를 모르면 링크 줄을 빼고 보낸다**(P6 자체 점검 21) — 평문·마크다운 둘 다', () => {
    const m = mentionMail({ callerName: '홍길동', where: '문서', pageTitle: '회의록', pageUrl: null });
    expect(m.text).not.toMatch(/바로 가기/);
    expect(m.markdown).not.toMatch(/\]\(/);
  });

  it('**마크다운은 이름·제목을 굵게, 링크는 링크로** — 마크다운 글자는 이스케이프한다(`*주간*`이 기울임이 되지 않게)', () => {
    const m = mentionMail({ callerName: '홍*길*동', where: '댓글', pageTitle: '*주간* [회의]', pageUrl: url });
    expect(m.markdown).toBe(
      ['**홍\\*길\\*동** 님이 댓글에서 회원님을 불렀습니다.', '', '문서: **\\*주간\\* \\[회의\\]**', '', `[문서 열기](${url})`, '', '내용은 위키에서 확인해 주세요.'].join('\n'),
    );
    // 제목(subject)은 평문이다 — 메일 제목은 마크다운으로 그려지지 않는다
    expect(m.subject).toBe('[위키] 홍*길*동 님이 회원님을 불렀습니다');
  });

  it('**마크다운의 `<`·`>`·`&`는 엔터티로** — 렌더러에 따라 `\\<`는 통하지 않고 제목의 `<a href=…>`가 숨은 링크가 된다(병합 전 보안 검토 1)', () => {
    const m = mentionMail({ callerName: 'A & B', where: '댓글', pageTitle: '<a href="https://phish.example/login">문서 열기</a>', pageUrl: url });
    expect(m.markdown).not.toMatch(/<a /);
    expect(m.markdown).toContain('문서: **&lt;a href="https://phish.example/login"&gt;문서 열기&lt;/a&gt;**');
    expect(m.markdown.split('\n')[0]).toBe('**A &amp; B** 님이 댓글에서 회원님을 불렀습니다.');
    // 평문은 글 그대로다
    expect(m.text).toContain('문서: <a href="https://phish.example/login">문서 열기</a>');
  });

  it('**이름·제목은 메일에서 한 줄이다** — 줄바꿈(CR 하나·U+2028 등)이 새 줄을 만들어 줄 머리 이스케이프를 비켜 가지 않게(병합 전 보안 검토 3)', () => {
    const m = mentionMail({ callerName: '홍\u2028길동', where: '문서', pageTitle: 'x\r# 큰 글씨\n> 인용', pageUrl: null });
    expect(m.markdown).toContain('문서: **x \\# 큰 글씨 &gt; 인용**');
    expect(m.markdown.split('\n')[0]).toBe('**홍 길동** 님이 문서에서 회원님을 불렀습니다.');
    expect(m.text).toContain('문서: x # 큰 글씨 > 인용');
    expect(m.subject).toBe('[위키] 홍 길동 님이 회원님을 불렀습니다');
  });

  it('링크 주소의 괄호·빈칸은 퍼센트로 바꾼다 — 마크다운 링크가 중간에서 끊기지 않게', () => {
    const m = mentionMail({ callerName: null, where: '문서', pageTitle: 't', pageUrl: 'https://wiki.example.internal/a (b)/pages/x' });
    expect(m.markdown).toContain('[문서 열기](https://wiki.example.internal/a%20%28b%29/pages/x)');
  });
});

describe('testMail — 시험 명령이 보내는 한 통 (FR-1905)', () => {
  it('평문과 마크다운 둘 다 같은 말을 하고, 보낸 때를 싣는다', () => {
    const m = testMail('2026-09-29T08:00:00.000Z');
    expect(m.subject).toBe('[위키] 시험 메일');
    for (const body of [m.text, m.markdown]) {
      expect(body).toContain('시험 메일');
      expect(body).toContain('2026-09-29T08:00:00.000Z');
    }
    expect(m.markdown).toContain('**');
  });
});
