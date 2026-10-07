import { BadRequestException, ConflictException, ForbiddenException, HttpException, Logger, NotFoundException, UnauthorizedException, type ArgumentsHost } from '@nestjs/common';
import { BaseExceptionFilter } from '@nestjs/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runInRequestContext } from '../common/request-context';
import { V1ExceptionFilter, V1PathExceptionFilter } from './v1-error.filter';

/** 공개 API의 오류는 한 모양이다 (docs/spinoff/public-api 설계서 FR-2211). 값 변환은 shared의 `v1ErrorBody`가 하고, 여기서는 연결을 본다 */

function run(exception: unknown, requestId = 'req-1') {
  const sent: { status?: number; body?: unknown } = {};
  const res = {
    status(n: number) {
      sent.status = n;
      return res;
    },
    json(b: unknown) {
      sent.body = b;
      return res;
    },
  };
  const host = { switchToHttp: () => ({ getResponse: () => res }) } as unknown as ArgumentsHost;
  runInRequestContext({ requestId }, () => new V1ExceptionFilter().catch(exception, host));
  return sent;
}

afterEach(() => vi.restoreAllMocks());

describe('V1ExceptionFilter', () => {
  it('상태와 요청 번호를 한 모양에 싣는다', () => {
    expect(run(new NotFoundException('페이지를 찾을 수 없다'))).toEqual({
      status: 404,
      body: { error: { code: 'NOT_FOUND', message: '페이지를 찾을 수 없다', requestId: 'req-1' } },
    });
  });

  it('가드의 코드를 그대로 낸다', () => {
    expect(run(new UnauthorizedException({ code: 'TOKEN_EXPIRED', message: '토큰을 쓸 수 없다' })).body).toEqual({
      error: { code: 'TOKEN_EXPIRED', message: '토큰을 쓸 수 없다', requestId: 'req-1' },
    });
    expect((run(new ForbiddenException({ code: 'INSUFFICIENT_SCOPE', message: 'x' })).body as { error: { code: string } }).error.code).toBe('INSUFFICIENT_SCOPE');
  });

  it('입력 검증 실패(ZodPipe)는 칸과 까닭을 말한다', () => {
    const e = new BadRequestException({ message: '요청 검증 실패', issues: [{ path: 'title', message: '비어 있을 수 없다' }] });
    const { status, body } = run(e);
    expect(status).toBe(400);
    expect((body as { error: { code: string; message: string } }).error).toMatchObject({ code: 'INVALID_REQUEST' });
    expect(JSON.stringify(body)).toContain('title');
  });

  it('기준 버전이 어긋난 저장은 VERSION_CONFLICT와 지금 버전을 말한다', () => {
    const { body } = run(new ConflictException({ message: '먼저 저장했다', currentVersionNo: 4, baseVersionNo: 2 }));
    expect((body as { error: { code: string; details: unknown } }).error).toMatchObject({ code: 'VERSION_CONFLICT', details: { currentVersionNo: 4 } });
  });

  it('상태를 마음대로 가진 예외도 그 상태로 낸다', () => {
    expect(run(new HttpException('너무 잦다', 429)).status).toBe(429);
  });

  it('**처리되지 않은 오류는 500 INTERNAL이고 오류 문장을 응답에 싣지 않는다** — 로그에는 남긴다', () => {
    const log = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const { status, body } = run(new Error('relation "users" does not exist — 비밀문장'));
    expect(status).toBe(500);
    expect(body).toEqual({ error: { code: 'INTERNAL', message: '서버 오류가 났다 — 요청 번호로 운영자에게 알린다', requestId: 'req-1' } });
    expect(JSON.stringify(body)).not.toContain('비밀문장');
    expect(log).toHaveBeenCalledTimes(1);
  });
});

/** body-parser·http-errors가 만드는 오류 — Nest의 HttpException이 아니라 `status`·`type`을 가진 객체다. 라우팅 **전에** 나므로 컨트롤러의 필터가 닿지 않는다 */
const httpError = (status: number, type: string, message: string) => Object.assign(new Error(message), { status, statusCode: status, type, expose: true });

describe('본문 파싱 오류도 한 모양이다 (잘못된 JSON·너무 큰 본문)', () => {
  it('잘못된 JSON은 400 INVALID_JSON — **오류 문장이 입력을 되읊지 않는다**', () => {
    const e = httpError(400, 'entity.parse.failed', `Unexpected token '비' in {"name": 비밀문장}`);
    const { status, body } = run(e);
    expect(status).toBe(400);
    expect((body as { error: { code: string } }).error.code).toBe('INVALID_JSON');
    expect(JSON.stringify(body)).not.toContain('비밀문장');
  });

  it('너무 큰 본문은 413 PAYLOAD_TOO_LARGE', () => {
    const { status, body } = run(httpError(413, 'entity.too.large', 'request entity too large'));
    expect(status).toBe(413);
    expect((body as { error: { code: string } }).error.code).toBe('PAYLOAD_TOO_LARGE');
  });

  it('그 밖의 4xx 오류는 상태로 말하고 문장은 싣지 않는다', () => {
    const { status, body } = run(httpError(415, 'charset.unsupported', '비밀문장 charset'));
    expect(status).toBe(415);
    expect(JSON.stringify(body)).not.toContain('비밀문장');
    expect((body as { error: { requestId: string } }).error.requestId).toBe('req-1');
  });

  it('상태가 5xx인 객체나 상태 없는 오류는 처리되지 않은 오류다(500)', () => {
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    expect(run(httpError(502, 'x', 'y')).status).toBe(500);
    expect(run(new Error('x')).status).toBe(500);
  });
});

describe('V1PathExceptionFilter — 전역: /api/v1 경로만 한 모양, 나머지는 Nest 기본', () => {
  function runPath(path: string, exception: unknown) {
    const sent: { status?: number; body?: unknown } = {};
    const res = {
      status(n: number) {
        sent.status = n;
        return res;
      },
      json(b: unknown) {
        sent.body = b;
        return res;
      },
    };
    const host = { switchToHttp: () => ({ getResponse: () => res, getRequest: () => ({ path }) }) } as unknown as ArgumentsHost;
    runInRequestContext({ requestId: 'req-9' }, () => new V1PathExceptionFilter().catch(exception, host));
    return sent;
  }

  it('/api/v1 경로의 파싱 오류는 한 모양', () => {
    const sent = runPath('/api/v1/pages', httpError(400, 'entity.parse.failed', 'x'));
    expect(sent.status).toBe(400);
    expect((sent.body as { error: { code: string; requestId: string } }).error).toMatchObject({ code: 'INVALID_JSON', requestId: 'req-9' });
  });

  it('**Nest는 잘못된 JSON(SyntaxError)을 `BadRequestException(문장)`으로 바꿔 보낸다** — 라우팅 전의 문자열 400은 INVALID_JSON이고 문장(입력 조각이 든다)은 싣지 않는다', () => {
    const sent = runPath('/api/v1/pages', new BadRequestException(`Unexpected token '비' in {"name": 비밀문장}`));
    const err = (sent.body as { error: { code: string; message: string } }).error;
    expect(sent.status).toBe(400);
    expect(err.code).toBe('INVALID_JSON');
    expect(JSON.stringify(sent.body)).not.toContain('비밀문장');
  });

  it('코드나 칸이 있는 400(객체 응답)은 그대로 둔다', () => {
    const sent = runPath('/api/v1/pages', new BadRequestException({ code: 'SOMETHING', message: '고유한 까닭' }));
    expect((sent.body as { error: { code: string } }).error.code).toBe('SOMETHING');
  });

  it('화면용 경로는 건드리지 않고 Nest 기본 처리기에 맡긴다', () => {
    const base = vi.spyOn(BaseExceptionFilter.prototype, 'catch').mockImplementation(() => undefined);
    const sent = runPath('/api/pages', httpError(400, 'entity.parse.failed', 'x'));
    expect(base).toHaveBeenCalledTimes(1);
    expect(sent.body).toBeUndefined();
  });

  it('경로 조각이 수상한 /api/v1(`..`)도 건드리지 않는다 — 공개 API 경로 판정(isPublicApiPath)을 따른다', () => {
    const base = vi.spyOn(BaseExceptionFilter.prototype, 'catch').mockImplementation(() => undefined);
    runPath('/api/v1/../pages', new Error('x'));
    expect(base).toHaveBeenCalledTimes(1);
  });
});
