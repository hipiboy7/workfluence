import { describe, expect, it } from 'vitest';
import { MAIL_FORMATS, isHttpHeaderName, mailApiUrlProblem, mailHeaderValueProblem } from './mail';

/**
 * A등급 — **테스트 먼저** (3절, P18_설계서_Mail FR-1904). 사내 메일 API의 설정은 폐쇄망 현장에서 사람이 적는다 — 틀린 값은 기동에서 막는다.
 * 주소에 비밀이 섞이면(사용자 정보·질의) 시험 명령의 창·로그로 나간다 — 비밀은 인증 헤더로만 받는다
 */
describe('mailApiUrlProblem — 사내 메일 API의 보내는 주소', () => {
  it('http(s) 주소는 받는다 — 경로·포트 그대로', () => {
    for (const ok of ['https://mail.example.internal/api/v1/email/send', 'http://10.0.0.5:8080/api/v1/email/send_markdown', 'https://mail.example.internal/send/'])
      expect(mailApiUrlProblem(ok), ok).toBeNull();
  });

  it('**http(s)가 아니거나 주소가 아니면** 까닭을 말한다', () => {
    for (const bad of ['mail.example.internal/send', 'ftp://mail.example.internal/send', 'javascript:alert(1)', 'file:///etc/passwd', 'https://'])
      expect(mailApiUrlProblem(bad), bad).toMatch(/http|주소/);
  });

  it('**사용자 정보·질의·조각을 받지 않는다** — 비밀이 주소에 섞이면 창과 로그로 나간다(인증은 헤더로)', () => {
    expect(mailApiUrlProblem('https://user:pass@mail.example.internal/send')).toMatch(/사용자 정보/);
    expect(mailApiUrlProblem('https://user@mail.example.internal/send')).toMatch(/사용자 정보/);
    expect(mailApiUrlProblem('https://mail.example.internal/send?key=abc')).toMatch(/질의/);
    expect(mailApiUrlProblem('https://mail.example.internal/send#x')).toMatch(/조각/);
  });

  it('너무 긴 주소는 받지 않는다', () => {
    expect(mailApiUrlProblem(`https://mail.example.internal/${'a'.repeat(2100)}`)).toMatch(/길다/);
  });
});

describe('인증 헤더 (FR-1902)', () => {
  it('헤더 이름은 HTTP 토큰 글자만 — 빈칸·콜론·줄바꿈·한글은 아니다', () => {
    for (const ok of ['Authorization', 'X-API-Key', 'x-api-key', 'X_Token.v2']) expect(isHttpHeaderName(ok), ok).toBe(true);
    for (const bad of ['', 'X API Key', 'X-Key:', 'X-Key\r\nX-Evil', '인증', 'X-Key\t']) expect(isHttpHeaderName(bad), JSON.stringify(bad)).toBe(false);
  });

  it('**헤더 값에 줄바꿈을 받지 않는다** — 다른 헤더를 끼워 넣는 길이다. 빈 값도 아니다', () => {
    expect(mailHeaderValueProblem('Bearer abc.def')).toBeNull();
    expect(mailHeaderValueProblem('abc')).toBeNull();
    for (const bad of ['Bearer a\r\nX-Evil: 1', 'a\nb', 'a\0b']) expect(mailHeaderValueProblem(bad), JSON.stringify(bad)).toMatch(/줄바꿈|글자/);
    expect(mailHeaderValueProblem('   ')).toMatch(/비/);
  });
});

describe('MAIL_FORMATS', () => {
  it('평문과 마크다운 — 사내 API의 /send와 /send_markdown', () => {
    expect(MAIL_FORMATS).toEqual(['text', 'markdown']);
  });
});
