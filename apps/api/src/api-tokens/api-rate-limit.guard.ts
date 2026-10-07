import { type CanActivate, type ExecutionContext, HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { API_RATE_LIMITS, requiredScopes } from '@workfluence/shared';
import type { Response } from 'express';
import { RateLimitStore } from '../common/rate-limit.guard';
import type { ApiTokenRequest } from './api-token.guard';

/**
 * 공개 API의 **토큰별** 빈도 제한 (docs/spinoff/public-api 설계서 FR-2213). `ApiTokenGuard` **뒤에** 둔다 — 인증을 통과해 토큰이 정해진 요청만 센다(가짜
 * 토큰을 던져 키를 부풀리지 못한다). 읽기와 쓰기를 따로 세고, 넘으면 429 `RATE_LIMITED`에 `Retry-After`(초)를 싣는다.
 *
 * 저장소는 이 모듈이 따로 가진 `RateLimitStore`다 — 로그인 등 IP별 제한의 예산(`AuthModule`)과 섞이지 않는다. 메모리에 둔다(단일 앱 서버 — 이중화는 하지 않는다)
 */
@Injectable()
export class ApiRateLimitGuard implements CanActivate {
  constructor(private readonly store: RateLimitStore) {}

  canActivate(ctx: ExecutionContext): boolean {
    const http = ctx.switchToHttp();
    const req = http.getRequest<ApiTokenRequest>();
    if (!req.apiToken) return true; // 토큰 가드를 거치지 않은 경로(상태 확인·명세)
    const kind = requiredScopes(req.method, false)[0] === 'read' ? 'read' : 'write';
    const key = `v1:${req.apiToken.id}:${kind}`;
    if (this.store.hit(req, key, API_RATE_LIMITS[kind])) return true;
    const wait = Math.max(1, this.store.retryAfterSec(key));
    http.getResponse<Response>().setHeader('Retry-After', String(wait));
    throw new HttpException(
      { code: 'RATE_LIMITED', message: `요청이 너무 잦다 — ${wait}초 뒤에 다시 시도한다`, details: { retryAfterSec: wait } },
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }
}
