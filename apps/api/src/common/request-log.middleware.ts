import type { NextFunction, Request, Response } from 'express';
import { randomUUID } from 'node:crypto';
import type { Logger } from 'pino';
import { accessLogEntry } from './domain/access-log';
import { requestIdFrom } from './domain/request-id';
import { runInRequestContext, type RequestContext } from './request-context';

/** 라우터가 맞춘 경로 틀(`/api/pages/:id`). 맞춘 라우트가 없으면 `null` */
function routeOf(req: Request): string | null {
  const path = (req.route as { path?: unknown } | undefined)?.path;
  return typeof path === 'string' ? `${req.baseUrl ?? ''}${path}` : null;
}

/**
 * **첫 미들웨어** (P11_설계서_Ops D.2·D.3, FR-1210~1213) — 요청 식별자를 정해 응답 머리말에 싣고, 요청 문맥을 열고, 요청이 끝나면
 * 접근 로그 한 줄을 남긴다.
 *
 * - 식별자는 nginx가 넘긴 `X-Request-Id`가 모양에 맞으면 그것, 아니면 새로 만든다(`requestIdFrom`)
 * - 무엇을 남기고 어느 수준인지는 순수 함수(`accessLogEntry`)가 정한다 — 여기는 시각과 이벤트만 다룬다
 * - 받는 쪽이 먼저 끊으면(`close`만 오고 `finish`가 없다) `aborted`로 한 번만 적는다
 */
export function requestMiddleware(logger: Logger, now: () => number = () => performance.now()) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const requestId = requestIdFrom(req.headers['x-request-id']) ?? randomUUID();
    res.setHeader('X-Request-Id', requestId);
    const started = now();
    // 가드가 사용자를 확인하면 이 객체에 `userId`를 더한다(`setRequestUser`) — 접근 로그도 그것을 읽는다
    const ctx: RequestContext = { requestId };
    let logged = false;
    const done = (aborted: boolean) => {
      if (logged) return;
      logged = true;
      const entry = accessLogEntry({
        method: req.method,
        url: req.originalUrl || req.url,
        route: routeOf(req),
        status: res.statusCode,
        durationMs: now() - started,
        userId: ctx.userId ?? null,
        aborted,
      });
      if (entry) logger[entry.level]({ requestId, ...entry.fields }, entry.msg);
    };
    res.on('finish', () => done(false));
    res.on('close', () => done(!res.writableFinished));
    runInRequestContext(ctx, next);
  };
}
