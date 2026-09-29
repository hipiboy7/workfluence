import { describe, expect, it } from 'vitest';
import { failureHint, hideSecret, mailConfigOf, mailRequest, statusHint } from './request';

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

  it('**인증 헤더는 둘 다 있을 때만** 싣는다 — 이름은 설정 그대로', () => {
    const withKey = mailRequest({ ...cfg, authHeader: 'X-API-Key', authValue: 'k-1' }, msg);
    expect(withKey.headers).toEqual({ 'content-type': 'application/json; charset=utf-8', 'X-API-Key': 'k-1' });
    expect(mailRequest({ ...cfg, authHeader: 'Authorization', authValue: 'Bearer t' }, msg).headers.Authorization).toBe('Bearer t');
    expect(Object.keys(mailRequest({ ...cfg, authHeader: 'X-API-Key', authValue: '' }, msg).headers)).toEqual(['content-type']);
  });
});

describe('hideSecret — 응답·오류 글에서 인증 값을 가린다 (FR-1902)', () => {
  it('값이 몇 번 나와도 모두 가리고, 값이 없으면 그대로', () => {
    expect(hideSecret('bad key k-1 (k-1)', 'k-1')).toBe('bad key *** (***)');
    expect(hideSecret('그대로', '')).toBe('그대로');
  });

  it('**`Bearer ` 뒤의 토큰만 되읊어도 가린다** — 값 전체가 아니라 토큰만 돌려주는 서버가 있다', () => {
    expect(hideSecret('invalid token abc.def', 'Bearer abc.def')).toBe('invalid token ***');
  });
});

describe('시험 명령의 까닭 (FR-1905)', () => {
  it('상태 코드마다 무엇을 볼지 말한다', () => {
    expect(statusHint(400)).toMatch(/필수|받는 주소|보내는 이름/);
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
});
