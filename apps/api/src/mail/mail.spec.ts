import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Logger } from '@nestjs/common';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AppEnv } from '@workfluence/shared';
import { HttpMailSender } from './http.sender';
import { MockMailSender } from './mock.sender';

/**
 * 메일 (P6_설계서_Collab B.5절 · P18_설계서_Mail FR-1900~1903). 보내는 쪽은 **실제 HTTP**로 본다 — 로컬에 가짜 사내 메일 API를 띄워 받은 요청과
 * 넘겨주기·오류 응답을 본다(`fetch`를 흉내 내면 `redirect: 'error'` 같은 것은 보이지 않는다).
 *
 * **던지지 않는 것**이 이 모듈의 계약이다 (FR-753). 그래서 시험의 대부분이 "실패했을 때 무엇을 돌려주는가"다 — 던지면 댓글 저장이 함께 실패한다.
 */

type Got = { method?: string; url?: string; headers: IncomingHttpHeaders; body: string };
let server: Server;
let base = '';
let got: Got[] = [];
/** 다음 요청에 줄 답 — 상태와 머리말 */
let answer: { status: number; headers?: Record<string, string>; body?: string } = { status: 200 };

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (c: string) => (body += c));
    req.on('end', () => {
      got.push({ method: req.method, url: req.url, headers: req.headers, body });
      if (req.url === '/reset') return req.socket.destroy();
      res.writeHead(answer.status, { 'content-type': 'application/json', ...answer.headers });
      res.end(answer.body ?? '{"message":"Email sent successfully"}');
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));
afterEach(() => {
  got = [];
  answer = { status: 200 };
  vi.restoreAllMocks();
});

const env = (over: Partial<AppEnv> = {}): AppEnv =>
  ({
    WF_MAIL_API_URL: `${base}/api/v1/email/send`,
    WF_MAIL_FORMAT: 'text',
    WF_MAIL_SENDER_NAME: '위키',
    WF_MAIL_AUTH_HEADER: '',
    WF_MAIL_AUTH_VALUE: '',
    ...over,
  }) as AppEnv;
const msg = { to: 'a@example.internal', subject: '[위키] 제목', text: '평문 본문', markdown: '**마크다운** 본문' };

describe('MockMailSender (FR-752)', () => {
  it('보냈다고 답하지만 **실제로 보내지 않는다**', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    expect(await new MockMailSender().send(msg)).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('HttpMailSender (P18 FR-1900~1903)', () => {
  it('주소가 비면 **조용히 성공으로 치지 않는다**', async () => {
    expect(await new HttpMailSender(env({ WF_MAIL_API_URL: '' })).send(msg)).toBe(false);
    expect(got).toHaveLength(0);
  });

  it('**사용자가 준 모양으로 보낸다** — POST, JSON(utf-8), subject·content·receivers·sender_name. 인증 설정이 없으면 인증 헤더가 없다', async () => {
    expect(await new HttpMailSender(env()).send(msg)).toBe(true);
    expect(got).toHaveLength(1);
    expect(got[0].method).toBe('POST');
    expect(got[0].url).toBe('/api/v1/email/send');
    expect(got[0].headers['content-type']).toBe('application/json; charset=utf-8');
    expect(got[0].headers.authorization).toBeUndefined();
    expect(JSON.parse(got[0].body)).toEqual({ subject: '[위키] 제목', content: '평문 본문', receivers: 'a@example.internal', sender_name: '위키' });
  });

  it('**형식이 markdown이면 마크다운 본문을, 인증 설정이 있으면 그 헤더를** 싣는다 — 값이 설정에서 소비된다(5절)', async () => {
    const sender = new HttpMailSender(
      env({ WF_MAIL_API_URL: `${base}/api/v1/email/send_markdown`, WF_MAIL_FORMAT: 'markdown', WF_MAIL_SENDER_NAME: '사내 위키', WF_MAIL_AUTH_HEADER: 'X-API-Key', WF_MAIL_AUTH_VALUE: 'k-1' }),
    );
    expect(await sender.send(msg)).toBe(true);
    expect(got[0].url).toBe('/api/v1/email/send_markdown');
    expect(got[0].headers['x-api-key']).toBe('k-1');
    expect(JSON.parse(got[0].body)).toMatchObject({ content: '**마크다운** 본문', sender_name: '사내 위키' });
  });

  it.each([400, 401, 500, 503])('**%i에 던지지 않고 false** — 응답 본문은 로그에 싣지 않는다', async (status) => {
    answer = { status, body: '{"message":"필수 파라미터 누락 a@example.internal"}' };
    const warn = vi.spyOn(Logger.prototype, 'warn');
    expect(await new HttpMailSender(env()).send(msg)).toBe(false);
    // 상태만 남는다 — 남의 응답 본문(받는 주소가 들어 있을 수 있다)은 싣지 않는다
    expect(warn).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(warn.mock.calls)).toContain(`"status":${status}`);
    expect(JSON.stringify(warn.mock.calls)).not.toContain('필수 파라미터');
  });

  it('**넘겨주기(302)를 따르지 않는다** — 인증 헤더가 다른 곳으로 가지 않는다. false', async () => {
    answer = { status: 302, headers: { location: `${base}/elsewhere` } };
    expect(await new HttpMailSender(env({ WF_MAIL_AUTH_HEADER: 'Authorization', WF_MAIL_AUTH_VALUE: 'Bearer t' })).send(msg)).toBe(false);
    expect(got.map((g) => g.url)).toEqual(['/api/v1/email/send']);
  });

  it('**연결이 끊기거나 닿지 않아도 던지지 않는다** — false', async () => {
    expect(await new HttpMailSender(env({ WF_MAIL_API_URL: `${base}/reset` })).send(msg)).toBe(false);
    expect(await new HttpMailSender(env({ WF_MAIL_API_URL: 'http://127.0.0.1:1/api/v1/email/send' })).send(msg)).toBe(false);
  });
});
