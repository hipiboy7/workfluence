import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Logger } from '@nestjs/common';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AppEnv } from '@workfluence/shared';
import { MAIL_TIMEOUT_MS } from './domain/request';
import { HttpMailSender } from './http.sender';
import { MAIL_BODY_READ_MAX, postMail } from './post';
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
      if (req.url === '/hang') return; // 답하지 않는다 — 시간 제한을 본다
      if (req.url === '/ok-endless') {
        // 200을 주고 본문을 끝내지 않는다 — 성공이면 본문을 읽지 않아야 한다
        res.writeHead(200, { 'content-type': 'application/json' });
        res.write('{"message":');
        return;
      }
      if (req.url === '/endless') {
        // 끝나지 않는 본문 — 읽는 쪽이 앞부분에서 멈춰야 한다
        res.writeHead(500, { 'content-type': 'text/plain' });
        const t = setInterval(() => res.write('y'.repeat(1024)), 5);
        res.on('close', () => clearInterval(t));
        return;
      }
      if (req.url === '/big') {
        res.writeHead(400, { 'content-type': 'text/plain' });
        return res.end('x'.repeat(100_000));
      }
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

/** 열었다 닫은 포트 — 연결이 거절된다(ECONNREFUSED). 포트 1 같은 것은 fetch가 막아 연결을 시도하지도 않는다 */
const closedPort = async (): Promise<number> => {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  const port = (s.address() as AddressInfo).port;
  await new Promise<void>((r) => s.close(() => r()));
  return port;
};

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
    expect(await new HttpMailSender(env({ WF_MAIL_API_URL: `http://127.0.0.1:${await closedPort()}/api/v1/email/send` })).send(msg)).toBe(false);
  });

  it('**시간 제한을 건다** — 메일 서버가 답하지 않으면 알림 처리가 묶인다(T-026). 앱은 MAIL_TIMEOUT_MS로 보낸다(코드 리뷰 1)', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    await new HttpMailSender(env()).send(msg);
    expect(timeout).toHaveBeenCalledWith(MAIL_TIMEOUT_MS);
  });

  it('**받는 사람이 주소 하나가 아니면 보내지 않는다** — 쉼표 목록은 사내 API가 여럿으로 읽는다(병합 전 보안 검토 2). 주소는 로그에 싣지 않는다', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn');
    expect(await new HttpMailSender(env()).send({ ...msg, to: 'a@example.internal, b@example.internal' })).toBe(false);
    expect(got).toHaveLength(0);
    expect(JSON.stringify(warn.mock.calls)).toContain('mail.bad_recipient');
    expect(JSON.stringify(warn.mock.calls)).not.toContain('b@example.internal');
  });
});

describe('postMail — 앱과 시험 명령이 함께 쓰는 보내는 길 (FR-1903)', () => {
  it('**답이 없으면 시간 제한으로 끝난다**(TimeoutError) — 매달리지 않는다', async () => {
    await expect(postMail({ url: `${base}/hang`, headers: {}, body: '{}' }, { timeoutMs: 150 })).rejects.toMatchObject({ name: 'TimeoutError' });
  });

  it('본문은 readBody일 때만, 앞의 MAIL_BODY_READ_MAX 바이트까지 읽는다', async () => {
    const r = await postMail({ url: `${base}/big`, headers: {}, body: '{}' }, { readBody: true });
    expect([r.ok, r.status]).toEqual([false, 400]);
    expect(r.body.length).toBe(MAIL_BODY_READ_MAX);
    expect((await postMail({ url: `${base}/big`, headers: {}, body: '{}' })).body).toBe('');
  });

  it('**받았으면(2xx) 본문을 읽지 않는다** — 200을 주고 본문을 끝내지 않아도 성공이다(좁은 재점검 2 — 시험 명령만 "보내지 못했다"로 오진했다)', async () => {
    const r = await postMail({ url: `${base}/ok-endless`, headers: {}, body: '{}' }, { readBody: true, timeoutMs: 1000 });
    expect(r).toEqual({ ok: true, status: 200, body: '' });
  });

  it('**끝나지 않는 본문도 앞부분에서 멈춘다** — 끝까지 읽으려 하면 시간 제한까지 매달린다', async () => {
    const r = await postMail({ url: `${base}/endless`, headers: {}, body: '{}' }, { readBody: true, timeoutMs: 3000 });
    expect([r.ok, r.status, r.body.length]).toEqual([false, 500, MAIL_BODY_READ_MAX]);
  });
});
