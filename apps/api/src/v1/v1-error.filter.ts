import { BadRequestException, Catch, HttpException, Logger, type ArgumentsHost, type ExceptionFilter } from '@nestjs/common';
import { BaseExceptionFilter } from '@nestjs/core';
import { isPublicApiPath, v1ErrorBody, type V1ErrorBody } from '@workfluence/shared';
import type { Request, Response } from 'express';
import { currentRequest } from '../common/request-context';

/** 처리되지 않은 오류의 응답 문장 — 오류의 문장(테이블 이름·질의 조각)은 응답에 싣지 않는다. 로그에는 남고 요청 번호로 찾는다 */
const INTERNAL_MESSAGE = '서버 오류가 났다 — 요청 번호로 운영자에게 알린다';

/** body-parser가 던지는 오류의 `type`과 우리 말 — **오류 문장은 입력을 되읊을 수 있어 쓰지 않는다**(잘못된 JSON의 문장에 본문 조각이 들어 있다) */
const PARSE_ERRORS: Record<string, { code: string; message: string }> = {
  'entity.parse.failed': { code: 'INVALID_JSON', message: '본문이 올바른 JSON이 아니다 — 문법을 확인한다' },
  'entity.too.large': { code: 'PAYLOAD_TOO_LARGE', message: '요청 본문이 너무 크다' },
};

/** body-parser·http-errors의 오류 — `HttpException`이 아니라 `status`와 `type`을 가진 객체다. 라우팅 **전에** 나서 컨트롤러의 필터가 닿지 않는다 */
function httpErrorStatus(e: unknown): number | null {
  if (typeof e !== 'object' || e === null) return null;
  const { status, statusCode, expose } = e as { status?: unknown; statusCode?: unknown; expose?: unknown };
  const n = typeof statusCode === 'number' ? statusCode : typeof status === 'number' ? status : null;
  return n !== null && n >= 400 && n < 500 && expose === true ? n : null;
}

/** `new BadRequestException(문장)`의 응답 — `{ message, error, statusCode }`뿐이다. 코드(`code`)나 칸(`issues`)이 있으면 우리가 만든 오류다 */
function isMessageOnly(response: unknown): boolean {
  if (typeof response === 'string') return true;
  if (typeof response !== 'object' || response === null) return false;
  const keys = Object.keys(response);
  return keys.length > 0 && keys.every((k) => k === 'message' || k === 'error' || k === 'statusCode') && typeof (response as { message?: unknown }).message === 'string';
}

/**
 * 한 예외를 v1의 응답으로. `unhandled`이면 호출한 쪽이 로그를 남긴다. `preRoute`는 라우팅 **전에** 난 오류다 — Nest는 본문의 문법 오류(`SyntaxError`)를
 * `BadRequestException(문장)`으로 바꿔 보내는데 그 문장이 입력 조각을 담는다. 컨트롤러의 필터를 거치지 않고 전역 필터까지 온 문자열 400이 그것이다
 */
export function v1ErrorResponse(exception: unknown, requestId: string | null, opts: { preRoute?: boolean } = {}): { status: number; body: V1ErrorBody; unhandled: boolean } {
  if (opts.preRoute && exception instanceof BadRequestException && isMessageOnly(exception.getResponse())) {
    return { status: 400, body: v1ErrorBody(400, PARSE_ERRORS['entity.parse.failed'], requestId), unhandled: false };
  }
  if (exception instanceof HttpException) {
    const status = exception.getStatus();
    return { status, body: v1ErrorBody(status, exception.getResponse(), requestId), unhandled: false };
  }
  const status = httpErrorStatus(exception);
  if (status !== null) {
    const known = PARSE_ERRORS[String((exception as { type?: unknown }).type)];
    return { status, body: v1ErrorBody(status, known ?? undefined, requestId), unhandled: false };
  }
  return { status: 500, body: v1ErrorBody(500, { code: 'INTERNAL', message: INTERNAL_MESSAGE }, requestId), unhandled: true };
}

function respond(exception: unknown, host: ArgumentsHost, opts: { preRoute?: boolean } = {}): void {
  const res = host.switchToHttp().getResponse<Response>();
  const { status, body, unhandled } = v1ErrorResponse(exception, currentRequest()?.requestId ?? null, opts);
  // 처리되지 않은 예외는 Nest 기본 처리기와 **같은 이름(`ExceptionsHandler`)으로 로그에 남긴다** — 공통 로거가 그 이름을 `http.unhandled`로 적고 오류 문장에서
  // 값을 가린다(`errorText`, CLAUDE.md 7절 로그)
  if (unhandled) new Logger('ExceptionsHandler').error(exception);
  res.status(status).json(body);
}

/**
 * 공개 API의 오류는 **한 모양**이다 — `{ error: { code, message, requestId, details? } }` (docs/spinoff/public-api 설계서 FR-2211). 에이전트는 문장이
 * 아니라 `code`로 분기한다. 변환은 `v1ErrorBody`(A등급)와 `v1ErrorResponse`가 하고 여기는 연결이다. 컨트롤러에 거는 필터(`UseV1`)다
 */
@Catch()
export class V1ExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    respond(exception, host);
  }
}

/**
 * **전역** 필터 — 라우팅 **전에** 나는 오류(잘못된 JSON·너무 큰 본문)는 컨트롤러의 필터가 닿지 않아 Nest 기본 모양(`{statusCode, message}`)으로 나가고
 * 문장이 입력을 되읊는다. 그것을 `/api/v1` 경로에서만 한 모양으로 바꾼다. 화면용 경로는 건드리지 않고 Nest 기본 처리기에 맡긴다. 경로 판정은 CSRF 면제와 같은
 * `isPublicApiPath` 한 곳이다 — 수상한 경로 조각(`..`·인코딩)은 공개 API로 치지 않는다
 */
@Catch()
export class V1PathExceptionFilter extends BaseExceptionFilter {
  override catch(exception: unknown, host: ArgumentsHost): void {
    const req = host.switchToHttp().getRequest<Request>();
    const path = typeof req.path === 'string' ? req.path : '';
    // 컨트롤러의 필터(`UseV1`)가 먼저 받는다 — 여기까지 온 것은 라우팅 전에 난 오류다
    if (isPublicApiPath(path)) respond(exception, host, { preRoute: true });
    else super.catch(exception, host);
  }
}
