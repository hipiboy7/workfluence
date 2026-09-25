import type { Logger } from 'pino';
import { describe, expect, it } from 'vitest';
import { PinoNestLogger, createLogger } from './logger';

describe('createLogger (FR-050, FR-051)', () => {
  it('설정한 레벨을 쓰고 서비스 이름을 붙인다', () => {
    const logger = createLogger('debug');
    expect(logger.level).toBe('debug');
  });

  /** pino는 fd에 직접 쓰므로 출력 확인은 destination을 주입해서 한다 */
  const capture = () => {
    const lines: string[] = [];
    return { lines, stream: { write: (chunk: string) => void lines.push(chunk) } };
  };

  it('비밀번호·쿠키·인증 헤더를 로그에 남기지 않는다', () => {
    const { lines, stream } = capture();
    createLogger('info', stream).info(
      { password: 'p@ssw0rd', passwordHash: '$argon2id$...', req: { headers: { cookie: 'wf.sid=abc', authorization: 'Bearer t' } } },
      'test',
    );
    const out = lines.join('');
    expect(out).toContain('[Redacted]');
    expect(out).not.toContain('p@ssw0rd');
    expect(out).not.toContain('wf.sid=abc');
    expect(out).not.toContain('Bearer t');
  });

  it('JSON 한 줄이고 service 필드를 담는다', () => {
    const { lines, stream } = capture();
    createLogger('info', stream).info({ n: 1 }, '기동');
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0].trim()) as { service: string; msg: string; n: number; time: string };
    expect(parsed).toMatchObject({ service: 'workfluence-api', msg: '기동', n: 1 });
    expect(Number.isNaN(Date.parse(parsed.time))).toBe(false);
  });

  it('레벨보다 낮은 로그는 출력하지 않는다', () => {
    const { lines, stream } = capture();
    const logger = createLogger('warn', stream);
    logger.info('무시');
    logger.warn('출력');
    expect(lines).toHaveLength(1);
  });
});

describe('PinoNestLogger (FR-052)', () => {
  const fake = () => {
    const calls: { level: string; ctx: unknown; msg: string }[] = [];
    const rec = (level: string) => (ctx: unknown, msg: string) => calls.push({ level, ctx, msg });
    const logger = { info: rec('info'), error: rec('error'), warn: rec('warn'), debug: rec('debug'), trace: rec('trace') } as unknown as Logger;
    return { logger, calls };
  };

  it('Nest 로그를 같은 형식으로 흘려보낸다', () => {
    const { logger, calls } = fake();
    const nest = new PinoNestLogger(logger);
    nest.log('기동', 'Bootstrap');
    nest.warn('주의', 'Ctx');
    nest.debug('디버그', 'Ctx');
    nest.verbose('상세', 'Ctx');
    nest.error('실패', 'stack...', 'Ctx');
    expect(calls.map((c) => c.level)).toEqual(['info', 'warn', 'debug', 'trace', 'error']);
    expect(calls[0]).toMatchObject({ ctx: { context: 'Bootstrap' }, msg: '기동' });
    expect(calls[4]).toMatchObject({ ctx: { context: 'Ctx', trace: 'stack...' }, msg: '실패' });
  });

  it('문자열이 아닌 메시지도 문자열로 바꿔 넘긴다', () => {
    const { logger, calls } = fake();
    new PinoNestLogger(logger).log({ a: 1 });
    expect(typeof calls[0].msg).toBe('string');
  });

  /**
   * 검토 반영 — **처리되지 않은 예외를 Nest가 오류 객체째 넘긴다** (`ExceptionsHandler`). 예전에는 `String(err)`라 스택이 버려지고
   * DB 오류면 drizzle 문장(질의 매개변수 = 문서 본문)이 그대로 msg로 갔다 (사용자 요청 "로깅 체계 검토" 2026-09-25, 7절)
   */
  it('**오류 객체는 문장을 가려 적고 스택을 남긴다**', () => {
    const { logger, calls } = fake();
    const pg = Object.assign(new Error('violates not-null constraint'), { code: '23502' });
    const err = new Error('Failed query: insert … params: 비밀 본문', { cause: pg });
    // Nest의 `Logger`는 context가 있으면 `(message, undefined, context)`로 부른다 — 실제로 확인한 모양이다
    new PinoNestLogger(logger).error(err, undefined, 'ExceptionsHandler');
    expect(calls[0].msg).toBe('23502 violates not-null constraint');
    const ctx = calls[0].ctx as { context?: string; trace?: string };
    expect(ctx.context).toBe('ExceptionsHandler');
    expect(ctx.trace).toMatch(/\n\s+at /);
    expect(JSON.stringify(calls)).not.toContain('비밀');
  });

  it('Nest가 문장과 스택을 따로 줄 때는 그대로 — 문자열 문장은 우리가 쓴 것이다', () => {
    const { logger, calls } = fake();
    new PinoNestLogger(logger).error('실패', 'stack...', 'Ctx');
    expect(calls[0]).toMatchObject({ ctx: { context: 'Ctx', trace: 'stack...' }, msg: '실패' });
  });

  it('문장과 스택이 **문자열로** 따로 와도 drizzle 문장은 가린다 — `logger.error(e.message, e.stack)` 모양', () => {
    const { logger, calls } = fake();
    const err = new Error('Failed query: insert … values ($1)\nparams: 비밀 본문');
    new PinoNestLogger(logger).error(err.message, err.stack, 'Ctx');
    expect(calls[0].msg).toBe('(DB 질의 실패 — 문장은 싣지 않는다)');
    const trace = (calls[0].ctx as { trace?: string }).trace as string;
    expect(trace).toMatch(/\n\s+at /);
    expect(JSON.stringify(calls)).not.toContain('비밀');
  });

  it('경고·기록에 온 오류 객체도 같게', () => {
    const { logger, calls } = fake();
    const nest = new PinoNestLogger(logger);
    nest.warn(new Error('Failed query: x params: 비밀'), 'Ctx');
    nest.log(new TypeError('t'), 'Ctx');
    expect(calls.map((c) => c.msg)).toEqual(['Error (DB 질의 실패 — 문장은 싣지 않는다)', 'TypeError: t']);
  });
});
