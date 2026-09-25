import type { NextFunction, Request, Response } from 'express';
import { EventEmitter } from 'node:events';
import type { Logger } from 'pino';
import { describe, expect, it } from 'vitest';
import { currentRequest, setRequestUser } from './request-context';
import { requestMiddleware } from './request-log.middleware';

/**
 * B등급 — 첫 미들웨어 (P11 D.2·D.3). 요청·응답은 가짜다 — 실제 서버에서의 모양은 E2E(머리말)와 컨테이너 확인(nginx·앱 로그·감사 행을
 * 같은 식별자로 찾기)이 본다
 */
class FakeRes extends EventEmitter {
  statusCode = 200;
  writableFinished = false;
  headers: Record<string, string> = {};
  setHeader(k: string, v: string) {
    this.headers[k.toLowerCase()] = v;
  }
}

function run(req: Partial<Request>, inside: () => void = () => undefined) {
  const res = new FakeRes();
  const lines: { level: string; obj: Record<string, unknown>; msg: string }[] = [];
  const rec = (level: string) => (obj: Record<string, unknown>, msg: string) => lines.push({ level, obj, msg });
  const logger = { info: rec('info'), warn: rec('warn') } as unknown as Logger;
  let t = 1000;
  let seen: string | undefined;
  const next: NextFunction = () => {
    seen = currentRequest()?.requestId;
    inside();
  };
  requestMiddleware(logger, () => (t += 7))({ method: 'GET', headers: {}, url: '/api/x', originalUrl: '/api/x', baseUrl: '', ...req } as Request, res as unknown as Response, next);
  return { res, lines, seen };
}

describe('requestMiddleware', () => {
  it('**nginx가 준 식별자를 쓰고 응답 머리말로 돌려준다** — 뒤의 처리는 그 문맥 안에서 돈다', () => {
    const { res, seen } = run({ headers: { 'x-request-id': '0f1e2d3c4b5a69788796a5b4c3d2e1f0' } });
    expect(res.headers['x-request-id']).toBe('0f1e2d3c4b5a69788796a5b4c3d2e1f0');
    expect(seen).toBe('0f1e2d3c4b5a69788796a5b4c3d2e1f0');
  });

  it('**모양이 틀리면 새로 만든다** — 로그 줄을 꾸미는 값을 쓰지 않는다', () => {
    const { res, seen } = run({ headers: { 'x-request-id': 'x\n{"level":50}' } });
    expect(res.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
    expect(seen).toBe(res.headers['x-request-id']);
  });

  it('**끝나면 접근 로그 한 줄** — 경로 틀·상태·걸린 시간·가드가 확인한 사용자, 식별자', () => {
    const { res, lines } = run({ route: { path: '/api/pages/:id' } as never, originalUrl: '/api/pages/p1?q=비밀' }, () => setRequestUser('u1'));
    res.statusCode = 404;
    res.writableFinished = true;
    res.emit('finish');
    res.emit('close');
    expect(lines).toHaveLength(1);
    expect(lines[0].level).toBe('info');
    expect(lines[0].obj).toMatchObject({ event: 'http.request', route: '/api/pages/:id', status: 404, durationMs: 7, userId: 'u1' });
    expect(lines[0].obj.requestId).toBe(res.headers['x-request-id']);
    expect(JSON.stringify(lines)).not.toContain('비밀');
  });

  it('**받는 쪽이 먼저 끊으면** `aborted`로 한 번', () => {
    const { res, lines } = run({ route: { path: '/api/llm/ask' } as never, originalUrl: '/api/llm/ask', method: 'POST' });
    res.emit('close');
    expect(lines).toHaveLength(1);
    expect(lines[0].obj).toMatchObject({ route: '/api/llm/ask', aborted: true });
  });

  it('헬스체크는 남기지 않는다', () => {
    const { res, lines } = run({ route: { path: '/api/health' } as never, originalUrl: '/api/health' });
    res.writableFinished = true;
    res.emit('finish');
    expect(lines).toEqual([]);
  });
});
