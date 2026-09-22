import { describe, expect, it, vi } from 'vitest';
import type { AppEnv } from '@workfluence/shared';
import { HttpMailSender } from './http.sender';
import { MockMailSender } from './mock.sender';

/**
 * 메일 (P6_설계서_Collab B.5절).
 *
 * **던지지 않는 것**이 이 모듈의 계약이다 (FR-753). 그래서 테스트의 대부분이
 * "실패했을 때 무엇을 돌려주는가"다 — 던지면 댓글 저장이 함께 실패한다.
 */

const env = (over: Partial<AppEnv> = {}): AppEnv =>
  ({ WF_MAIL_API_URL: 'https://mail.example.internal/send', WF_MAIL_API_TOKEN: 'tok', WF_MAIL_FROM: 'wiki@example.internal', ...over }) as AppEnv;

const msg = { to: ['a@example.internal'], subject: '제목', text: '본문' };

describe('MockMailSender (FR-752)', () => {
  it('보냈다고 답하지만 **실제로 보내지 않는다**', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    expect(await new MockMailSender().send(msg)).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});

describe('HttpMailSender (FR-751·753)', () => {
  it('주소나 보내는이가 비면 **조용히 성공으로 치지 않는다**', async () => {
    expect(await new HttpMailSender(env({ WF_MAIL_API_URL: '' })).send(msg)).toBe(false);
    expect(await new HttpMailSender(env({ WF_MAIL_FROM: '' })).send(msg)).toBe(false);
  });

  it('가정한 형식으로 보낸다 (A.1절) — 틀리면 이 파일만 고친다', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('', { status: 200 }));
    expect(await new HttpMailSender(env()).send(msg)).toBe(true);
    const [url, init] = spy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://mail.example.internal/send');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer tok');
    expect(JSON.parse(init.body as string)).toEqual({ from: 'wiki@example.internal', to: msg.to, subject: '제목', text: '본문' });
    // **시간 제한을 둔다.** 메일 서버가 안 받으면 알림 처리가 거기 묶인다 (T-026의 교훈)
    expect(init.signal).toBeDefined();
    spy.mockRestore();
  });

  it('토큰이 없으면 인증 헤더를 붙이지 않는다 — `Bearer undefined`를 보내지 않는다', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('', { status: 200 }));
    await new HttpMailSender(env({ WF_MAIL_API_TOKEN: '' })).send(msg);
    expect((spy.mock.calls[0]?.[1]?.headers as Record<string, string>).authorization).toBeUndefined();
    spy.mockRestore();
  });

  it('**오류 응답에 던지지 않는다** — `false`로 답한다 (FR-753)', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('서버 사정', { status: 500 }));
    expect(await new HttpMailSender(env()).send(msg)).toBe(false);
    spy.mockRestore();
  });

  it('**연결 자체가 실패해도 던지지 않는다**', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('ECONNREFUSED'));
    expect(await new HttpMailSender(env()).send(msg)).toBe(false);
    spy.mockRestore();
  });
});
