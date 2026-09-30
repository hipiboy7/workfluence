import { describe, expect, it } from 'vitest';
import { MAIL_FORMATS, isHttpHeaderName, isSingleMailAddress, mailApiUrlProblem, mailAuthHeaderProblem, mailHeaderValueProblem, publicUrlProblem } from './mail';

/**
 * A등급 — **테스트 먼저** (3절, P18_설계서_Mail FR-1904). 사내 메일 API의 설정은 폐쇄망 현장에서 사람이 적는다 — 틀린 값은 기동에서 막는다.
 * 주소에 비밀이 섞이면(사용자 정보·질의) 시험 명령의 창·로그로 나간다 — 비밀은 인증 헤더로만 받는다
 */
describe('publicUrlProblem — 메일 속 링크의 주소(WF_PUBLIC_URL, P19 병합 전 자체 점검 5)', () => {
  it('http(s) 주소는 받는다 — 포트·경로 그대로, 끝의 `/`도', () => {
    for (const ok of ['https://wiki.example.internal', 'https://wiki.example.internal:8443', 'http://127.0.0.1:3100', 'https://wiki.example.internal/wiki/'])
      expect(publicUrlProblem(ok), ok).toBeNull();
  });

  it('**스킴이 없거나 http(s)가 아니면** 까닭을 말한다 — 그런 링크는 메일에서 열리지 않는다(재설정 메일은 링크가 전부다)', () => {
    for (const bad of ['wiki.example.internal', 'wiki.example.internal:8443', 'ftp://wiki.example.internal', 'javascript:alert(1)', 'https://'])
      expect(publicUrlProblem(bad), bad).toMatch(/http|주소/);
  });

  it('**사용자 정보·질의·조각을 받지 않는다** — 링크 뒤에 붙는 경로·조각(`#t=…`)이 깨진다', () => {
    expect(publicUrlProblem('https://u:p@wiki.example.internal')).toMatch(/사용자 정보/);
    expect(publicUrlProblem('https://wiki.example.internal/?a=1')).toMatch(/질의/);
    expect(publicUrlProblem('https://wiki.example.internal/#x')).toMatch(/조각/);
  });
});

describe('mailApiUrlProblem — 사내 메일 API의 보내는 주소', () => {
  it('http(s) 주소는 받는다 — 경로·포트 그대로', () => {
    for (const ok of ['https://mail.example.internal/api/v1/email/send', 'http://mail.example.internal:8080/api/v1/email/send_markdown', 'https://mail.example.internal/send/'])
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

  it('**인증 헤더로 쓸 수 없는 이름은 받지 않는다** — 요청의 모양을 바꾸는 머리말(Host·Content-Type·Content-Length·Transfer-Encoding 등)을 덮어쓰지 못하게(P18 코드 리뷰 12). 대소문자 무관', () => {
    for (const ok of ['Authorization', 'X-API-Key', 'X-Auth-Token']) expect(mailAuthHeaderProblem(ok), ok).toBeNull();
    for (const bad of ['Host', 'content-type', 'Content-Length', 'Transfer-Encoding', 'Connection', 'Expect', 'Upgrade', 'TE', 'Trailer', 'Keep-Alive', 'Proxy-Authorization'])
      expect(mailAuthHeaderProblem(bad), bad).toMatch(/쓸 수 없/);
    expect(mailAuthHeaderProblem('X API Key')).toMatch(/헤더 이름/);
  });

  it('**헤더 값에 줄바꿈을 받지 않는다** — 다른 헤더를 끼워 넣는 길이다. 빈 값도 아니다', () => {
    expect(mailHeaderValueProblem('Bearer abc.def')).toBeNull();
    expect(mailHeaderValueProblem('abc')).toBeNull();
    for (const bad of ['Bearer a\r\nX-Evil: 1', 'a\nb', 'a\0b']) expect(mailHeaderValueProblem(bad), JSON.stringify(bad)).toMatch(/줄바꿈|글자/);
    expect(mailHeaderValueProblem('   ')).toMatch(/비/);
  });

  it('**헤더 값은 보이는 ASCII만** — 한글 등 다른 글자면 보낼 때마다 실패하고, 그 오류 문장이 비밀 값의 글자 위치와 코드를 로그에 남긴다(병합 전 보안 검토 5)', () => {
    expect(mailHeaderValueProblem('Bearer a~!@#$%^&*()_+-={}[]|:;"<>,.?/')).toBeNull();
    for (const bad of ['Bearer 토큰', 'k\u00e9y', 'k\u200bey']) expect(mailHeaderValueProblem(bad), bad).toMatch(/ASCII/);
  });
});

describe('MAIL_FORMATS', () => {
  it('평문과 마크다운 — 사내 API의 /send와 /send_markdown', () => {
    expect(MAIL_FORMATS).toEqual(['text', 'markdown']);
  });
});

describe('isSingleMailAddress — 받는 사람은 주소 하나 (P18 A.1-11)', () => {
  it('**주소 하나면 받는다 — 모양을 까다롭게 보지 않는다**: 한 단어 도메인(`user@corp`)·대문자·`+`·밑줄 도메인도. 사내 IdP가 주는 주소가 가입 검사(`emailSchema`)보다 느슨할 수 있다 — 막으면 그 조직의 부르기 메일이 신호 없이 멈춘다(좁은 재점검 보통 1)', () => {
    for (const ok of ['user@example.internal', 'user@corp', 'Hong.GilDong@Corp.CO.KR', 'a+b@example.internal', 'user@sub_domain.example.internal', 'a&b@example.internal'])
      expect(isSingleMailAddress(ok), ok).toBe(true);
  });

  it('**여럿·머리말을 만드는 글자는 아니다** — 쉼표·세미콜론 목록, 빈칸·줄바꿈·제어 글자, `@`가 없거나 둘, 꺾쇠(`이름 <주소>`), 빈 값, 너무 긴 값', () => {
    for (const bad of ['a@example.internal, b@example.internal', 'a@example.internal;b@example.internal', 'a@example.internal b@example.internal', 'a@example.internal\r\nBcc: x@example.internal', ' a@example.internal', 'a@example.internal\u0000', 'not-an-address', 'a@b@example.internal', '<a@example.internal>', '"a" <a@example.internal>', '', `${'a'.repeat(250)}@example.internal`])
      expect(isSingleMailAddress(bad), JSON.stringify(bad)).toBe(false);
  });
});

