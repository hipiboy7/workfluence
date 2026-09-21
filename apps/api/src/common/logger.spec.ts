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
});
