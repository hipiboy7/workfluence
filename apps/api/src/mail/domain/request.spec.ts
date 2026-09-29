import { describe, expect, it } from 'vitest';
import { failureHint, hideSecret, isSingleRecipient, mailConfigOf, mailRequest, statusHint } from './request';

/**
 * A등급 — **테스트 먼저** (3절, P18_설계서_Mail FR-1900·1902·1905). 사내 메일 API에 보내는 요청의 모양은 **사용자가 준 설명 그대로**다
 * (`docs/prompts/phase17/scope.md`): `{"subject", "content", "receivers", "sender_name"}`. 현장의 API가 다르면 이 파일(과 이 시험)만 고친다(A.1-2)
 */
const cfg = mailConfigOf({
  WF_MAIL_API_URL: 'https://mail.example.internal/api/v1/email/send',
  WF_MAIL_FORMAT: 'text',
  WF_MAIL_SENDER_NAME: '위키',
  WF_MAIL_AUTH_HEADER: '',
  WF_MAIL_AUTH_VALUE: '',
});
const msg = { to: 'user@example.internal', subject: '[위키] 제목', text: '평문 본문', markdown: '**마크다운** 본문' };

describe('mailRequest', () => {
  it('**사용자가 준 모양으로 보낸다** — 받는 사람은 한 통에 하나(`receivers`), 보내는 이름, 평문 본문', () => {
    const r = mailRequest(cfg, msg);
    expect(r.url).toBe('https://mail.example.internal/api/v1/email/send');
    expect(r.headers).toEqual({ 'content-type': 'application/json; charset=utf-8' });
    expect(JSON.parse(r.body)).toEqual({ subject: '[위키] 제목', content: '평문 본문', receivers: 'user@example.internal', sender_name: '위키' });
  });

  it('**형식이 markdown이면 마크다운 본문을 싣는다** — 주소는 설정 그대로(형식에 맞는 주소를 적는다, A.1-4)', () => {
    const r = mailRequest({ ...cfg, format: 'markdown', url: 'https://mail.example.internal/api/v1/email/send_markdown' }, msg);
    expect(r.url).toBe('https://mail.example.internal/api/v1/email/send_markdown');
    expect(JSON.parse(r.body).content).toBe('**마크다운** 본문');
  });

  it('**제목의 줄바꿈·제어 글자는 빈칸으로 바꾼다** — 사내 API가 제목을 메일 머리말(SMTP 헤더)로 옮겨도 머리말을 끼워 넣지 못한다(P7 C.4.1 — 표시 이름이 제목에 든다. 사내 계정의 이름은 가입 검사를 지나지 않는다)', () => {
    const r = mailRequest(cfg, { ...msg, subject: '[위키] 홍길동\r\nBcc: x@example.internal\u0000 님이 회원님을 불렀습니다' });
    expect(JSON.parse(r.body).subject).toBe('[위키] 홍길동 Bcc: x@example.internal 님이 회원님을 불렀습니다');
    // 유니코드 줄 구분자도 줄바꿈이다(병합 전 보안 검토 6)
    expect(JSON.parse(mailRequest(cfg, { ...msg, subject: 'a\u0085b\u2028c\u2029d' }).body).subject).toBe('a b c d');
    // C1 제어 글자(터미널이 명령으로 읽는 CSI 등)도 — 시험 명령이 창에 찍는 남의 글도 이것을 지난다(코드 리뷰 10)
    expect(JSON.parse(mailRequest(cfg, { ...msg, subject: 'a\u009b31mb' }).body).subject).toBe('a 31mb');
    // 본문의 줄바꿈은 그대로다 — 본문은 여러 줄이다
    expect(JSON.parse(mailRequest(cfg, { ...msg, text: '한 줄\n두 줄' }).body).content).toBe('한 줄\n두 줄');
  });

  it('**인증 헤더는 둘 다 있을 때만** 싣는다 — 이름은 설정 그대로', () => {
    const withKey = mailRequest({ ...cfg, authHeader: 'X-API-Key', authValue: 'k-1' }, msg);
    expect(withKey.headers).toEqual({ 'content-type': 'application/json; charset=utf-8', 'X-API-Key': 'k-1' });
    expect(mailRequest({ ...cfg, authHeader: 'Authorization', authValue: 'Bearer t' }, msg).headers.Authorization).toBe('Bearer t');
    expect(Object.keys(mailRequest({ ...cfg, authHeader: 'X-API-Key', authValue: '' }, msg).headers)).toEqual(['content-type']);
  });
});

describe('isSingleRecipient — 받는 사람은 주소 하나 (A.1-3)', () => {
  it('**주소 하나만** — 쉼표로 이은 여럿·줄바꿈·형식이 아닌 것은 아니다. 사내 API의 `receivers`는 쉼표를 목록으로 읽는다(병합 전 보안 검토 2 — 사내 계정의 email은 형식 검사를 지나지 않았다)', () => {
    expect(isSingleRecipient('user@example.internal')).toBe(true);
    for (const bad of ['me@example.internal, other@example.internal', 'me@example.internal,other@example.internal', 'me@example.internal\r\nBcc: x@example.internal', 'not-an-address', '', ' user@example.internal'])
      expect(isSingleRecipient(bad), JSON.stringify(bad)).toBe(false);
  });
});

describe('hideSecret — 응답·오류 글에서 인증 값을 가린다 (FR-1902)', () => {
  it('값이 몇 번 나와도 모두 가리고, 값이 없으면 그대로', () => {
    expect(hideSecret('bad key k-1 (k-1)', 'k-1')).toBe('bad key *** (***)');
    expect(hideSecret('그대로', '')).toBe('그대로');
  });

  it('**JSON으로 이스케이프해 되읊어도 가린다** — `/`를 `\\/`로, `"`·`\\`를 이스케이프해 돌려주는 서버가 있다(자체 점검 3)', () => {
    expect(hideSecret('{"msg":"bad Bearer ab\\/cd+ef=="}', 'Bearer ab/cd+ef==')).toBe('{"msg":"bad ***"}');
    expect(hideSecret('{"msg":"bad k\\"q\\\\1"}', 'k"q\\1')).toBe('{"msg":"bad ***"}');
  });

  it('값 앞뒤의 빈칸은 떼고 가린다 — 보낼 때 떼어지므로 서버가 되읊는 값에는 없다(병합 전 보안 검토 4)', () => {
    expect(hideSecret('bad key k-1', ' k-1 ')).toBe('bad key ***');
  });

  it('**`Bearer ` 뒤의 토큰만 되읊어도 가린다** — 값 전체가 아니라 토큰만 돌려주는 서버가 있다', () => {
    expect(hideSecret('invalid token abc.def', 'Bearer abc.def')).toBe('invalid token ***');
  });
});

describe('시험 명령의 까닭 (FR-1905)', () => {
  it('상태 코드마다 무엇을 볼지 말한다', () => {
    expect(statusHint(400)).toMatch(/필수|받는 주소|보내는 이름/);
    // 필수 필드 누락을 422로 답하는 서버도 있다(자체 점검 9)
    expect(statusHint(422)).toBe(statusHint(400));
    expect(statusHint(401)).toMatch(/WF_MAIL_AUTH/);
    expect(statusHint(403)).toMatch(/WF_MAIL_AUTH/);
    expect(statusHint(404)).toMatch(/WF_MAIL_API_URL/);
    expect(statusHint(405)).toMatch(/WF_MAIL_API_URL/);
    expect(statusHint(500)).toMatch(/메일 서버/);
    expect(statusHint(503)).toMatch(/메일 서버/);
    expect(statusHint(418)).toMatch(/418/);
  });

  it('닿지 않은 까닭을 오류 코드로 말한다 — 주소는 싣지 않는다', () => {
    const err = (code: string, message = 'fetch failed') => Object.assign(new TypeError(message), { cause: Object.assign(new Error(code), { code }) });
    expect(failureHint(err('ECONNREFUSED'))).toMatch(/ECONNREFUSED/);
    expect(failureHint(err('ENOTFOUND'))).toMatch(/ENOTFOUND.*호스트|호스트.*ENOTFOUND/);
    expect(failureHint(err('UNABLE_TO_VERIFY_LEAF_SIGNATURE'))).toMatch(/ca\/ca\.pem/);
    expect(failureHint(err('SELF_SIGNED_CERT_IN_CHAIN'))).toMatch(/ca\/ca\.pem/);
    expect(failureHint(Object.assign(new TypeError('fetch failed'), { cause: new Error('unexpected redirect') }))).toMatch(/넘겨주기/);
    expect(failureHint(new DOMException('The operation was aborted due to timeout', 'TimeoutError'))).toMatch(/10초/);
    expect(failureHint(new Error('무언가'))).toMatch(/닿지 않/);
  });

  it('**원인을 가려 말한다** — 요청을 만들지 못함(헤더 값의 글자), fetch가 막는 포트, 인증서 만료·호스트 이름 불일치는 "ca.pem"이 아니다(코드 리뷰 2·5·6)', () => {
    const err = (code: string | undefined, message: string) => Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error(message), code ? { code } : {}) });
    expect(failureHint(new TypeError('Cannot convert argument to a ByteString because the character at index 13 has a value of 54620'))).toMatch(/요청을 만들지 못했다/);
    expect(failureHint(new TypeError('Cannot convert argument to a ByteString because the character at index 13 has a value of 54620'))).not.toMatch(/54620|13/);
    expect(failureHint(err(undefined, 'bad port'))).toMatch(/포트/);
    expect(failureHint(err('CERT_HAS_EXPIRED', 'certificate has expired'))).toMatch(/만료/);
    expect(failureHint(err('CERT_HAS_EXPIRED', 'certificate has expired'))).not.toMatch(/ca\.pem/);
    expect(failureHint(err('ERR_TLS_CERT_ALTNAME_INVALID', "Hostname/IP does not match certificate's altnames"))).toMatch(/호스트 이름/);
  });
});
