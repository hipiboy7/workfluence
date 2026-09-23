import { describe, expect, it } from 'vitest';
import { safeDisplayName } from './display-name';

/**
 * IdP가 준 표시 이름 정제 (P7 FR-807, 보안 검토 F4).
 *
 * 로컬 가입은 `displayNameSchema`가 줄바꿈을 막는데 **JIT 동기화는 zod를 거치지 않아
 * 주 로그인 경로가 그 방어를 통째로 비켜 갔다.** 이 값은 멘션 메일 제목에 들어간다.
 */
describe('safeDisplayName', () => {
  it('평범한 이름은 그대로 둔다', () => {
    expect(safeDisplayName('홍길동', 'sub-1')).toBe('홍길동');
  });

  it('**CR·LF를 공백으로 바꾼다** — 메일 헤더 인젝션의 씨앗이다', () => {
    expect(safeDisplayName('홍길동\r\nBcc: outside@example.internal', 'sub-1')).toBe('홍길동 Bcc: outside@example.internal');
  });

  it('탭·널 같은 다른 제어문자도 지운다', () => {
    expect(safeDisplayName('앞\u0000\u0009뒤', 'sub-1')).toBe('앞 뒤');
  });

  it('앞뒤 공백을 턴다', () => {
    expect(safeDisplayName('  이름  ', 'sub-1')).toBe('이름');
  });

  it('100자를 넘으면 자른다 — DB 컬럼에 길이 제한이 없다', () => {
    expect(safeDisplayName('가'.repeat(300), 'sub-1')).toHaveLength(100);
  });

  it('비면 `sub`를 쓴다 — 빈 이름은 화면에서 누가 누군지 알 수 없게 만든다', () => {
    expect(safeDisplayName('\r\n  \t', 'sub-1')).toBe('sub-1');
  });

  it('`sub`마저 제어문자뿐이면 마지막 기본값으로 간다', () => {
    expect(safeDisplayName('', '\u0001\u0002')).toBe('사용자');
  });

  it('**거부하지 않고 고친다** — 로그인 자체를 막으면 프로필 하나로 사람이 못 들어온다', () => {
    expect(safeDisplayName('a\nb', 'sub')).toBeTruthy();
  });
});
