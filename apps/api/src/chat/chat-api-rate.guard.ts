import { type CanActivate, type ExecutionContext, HttpException, HttpStatus, Inject, Injectable } from '@nestjs/common';
import { API_RATE_LIMITS, requiredScopes } from '@workfluence/shared';
import type { Response } from 'express';
import type { ApiTokenRequest } from '../api-tokens/api-token.guard';
import { RateLimitStore } from '../common/rate-limit.guard';
import { APP_ENV, type AppEnvToken } from '../config/config.module';

/**
 * 채팅 REST의 토큰별 빈도 제한 (P21 쟁점 2 — 사용자 결정 "추천대로"). 공개 API의 **쓰기 한도(분당 30)를 채팅에는 적용하지 않는다** — 에이전트가 대화하기에 빠듯하다.
 * 읽기는 공개 API의 읽기 한도(분당 120)를 그대로 쓰고, 쓰기는 채팅 전용 한도(`WF_CHAT_SEND_PER_MIN`)를 쓴다 — WebSocket 보내기(연결마다)와 같은 값이다.
 * `ApiTokenGuard` **뒤에** 둔다(인증을 통과한 요청만 센다). 공개 API 쓰기 예산과 키가 달라 서로를 소진시키지 않는다
 */
@Injectable()
export class ChatApiRateGuard implements CanActivate {
  constructor(
    private readonly store: RateLimitStore,
    @Inject(APP_ENV) private readonly env: Pick<AppEnvToken, 'WF_CHAT_SEND_PER_MIN'>,
  ) {}

  canActivate(ctx: ExecutionContext): boolean {
    const http = ctx.switchToHttp();
    const req = http.getRequest<ApiTokenRequest>();
    if (!req.apiToken) return true;
    const read = requiredScopes(req.method, false)[0] === 'read';
    const key = read ? `v1:${req.apiToken.id}:read` : `v1:chat:${req.apiToken.id}:write`;
    const spec = read ? API_RATE_LIMITS.read : { max: this.env.WF_CHAT_SEND_PER_MIN, windowSec: 60 };
    if (this.store.hit(req, key, spec)) return true;
    const wait = Math.max(1, this.store.retryAfterSec(key));
    http.getResponse<Response>().setHeader('Retry-After', String(wait));
    throw new HttpException(
      { code: 'RATE_LIMITED', message: `요청이 너무 잦다 — ${wait}초 뒤에 다시 시도한다`, details: { retryAfterSec: wait } },
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }
}
