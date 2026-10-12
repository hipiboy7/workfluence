import { type CanActivate, type ExecutionContext, HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { API_RATE_LIMITS, requiredScopes } from '@workfluence/shared';
import type { Response } from 'express';
import type { ApiTokenRequest } from '../api-tokens/api-token.guard';
import { RateLimitStore } from '../common/rate-limit.guard';

/**
 * 채팅 REST(공개 API)의 빈도 제한 (P21 쟁점 2 — 사용자 결정 "추천대로"). **읽기**는 공개 API의 읽기 한도(토큰마다 분당 120)를 그대로 쓴다.
 * **쓰기는 여기서 세지 않는다** — 공개 API의 쓰기 한도(분당 30)는 대화하기에 빠듯해 채팅에 적용하지 않고, 채팅 쓰기 한도는 **사용자마다** `ChatService.send`가
 * 센다(보안 검토 2 — 연결·토큰마다 세면 끊고 다시 붙거나 토큰을 여럿 만들어 곱해진다). 방 만들기·초대·읽음은 공개 API의 쓰기 한도를 쓰지 않으므로
 * 이 경로의 쓰기는 한도가 없다 — 방 만들기·초대의 한도는 보류 39에서 본다.
 * `ApiTokenGuard` **뒤에** 둔다(인증을 통과한 요청만 센다)
 */
@Injectable()
export class ChatApiRateGuard implements CanActivate {
  constructor(private readonly store: RateLimitStore) {}

  canActivate(ctx: ExecutionContext): boolean {
    const http = ctx.switchToHttp();
    const req = http.getRequest<ApiTokenRequest>();
    if (!req.apiToken) return true;
    if (requiredScopes(req.method, false)[0] !== 'read') return true;
    const key = `v1:${req.apiToken.id}:read`;
    if (this.store.hit(req, key, API_RATE_LIMITS.read)) return true;
    const wait = Math.max(1, this.store.retryAfterSec(key));
    http.getResponse<Response>().setHeader('Retry-After', String(wait));
    throw new HttpException(
      { code: 'RATE_LIMITED', message: `요청이 너무 잦다 — ${wait}초 뒤에 다시 시도한다`, details: { retryAfterSec: wait } },
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }
}
