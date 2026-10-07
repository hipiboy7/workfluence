import { Catch, HttpException, Logger, type ArgumentsHost, type ExceptionFilter } from '@nestjs/common';
import { v1ErrorBody } from '@workfluence/shared';
import type { Response } from 'express';
import { currentRequest } from '../common/request-context';

/** 처리되지 않은 오류의 응답 문장 — 오류의 문장(테이블 이름·질의 조각)은 응답에 싣지 않는다. 로그에는 남고 요청 번호로 찾는다 */
const INTERNAL_MESSAGE = '서버 오류가 났다 — 요청 번호로 운영자에게 알린다';

/**
 * 공개 API의 오류는 **한 모양**이다 — `{ error: { code, message, requestId, details? } }` (docs/spinoff/public-api 설계서 FR-2211). 에이전트는 문장이
 * 아니라 `code`로 분기한다. 변환은 `v1ErrorBody`(A등급)가 하고 여기는 연결이다.
 *
 * 처리되지 않은 예외는 Nest 기본 처리기와 **같은 이름(`ExceptionsHandler`)으로 로그에 남긴다** — 공통 로거가 그 이름을 `http.unhandled`로 적고 오류 문장에서
 * 값을 가린다(`errorText`, CLAUDE.md 7절 로그)
 */
@Catch()
export class V1ExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();
    const requestId = currentRequest()?.requestId ?? null;
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      res.status(status).json(v1ErrorBody(status, exception.getResponse(), requestId));
      return;
    }
    new Logger('ExceptionsHandler').error(exception);
    res.status(500).json(v1ErrorBody(500, { code: 'INTERNAL', message: INTERNAL_MESSAGE }, requestId));
  }
}
