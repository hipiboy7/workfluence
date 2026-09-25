import { Injectable, type LoggerService } from '@nestjs/common';
import pino, { type Logger } from 'pino';
import type { LogEvent } from '@workfluence/shared';
import { errorStack, errorText, scrubMessage, scrubStack } from './error-text';
import { isLogLine } from './log-line';
import { currentRequest } from './request-context';

/**
 * JSON 한 줄 stdout 로거 (CLAUDE.md 0.2절). 비밀번호·토큰·세션 ID·문서 본문은 로그에 넣지 않는다 (7절).
 * Nest의 LoggerService 인터페이스에 맞춰 부트스트랩 로그도 같은 형식으로 나간다.
 */
/**
 * @param destination 출력 대상. 기본은 stdout이다. 테스트가 출력을 확인할 수 있도록 주입받는다 —
 *   pino는 파일 디스크립터에 직접 쓰므로 `process.stdout.write`를 감시해도 잡히지 않는다.
 */
export function createLogger(level: string, destination?: pino.DestinationStream): Logger {
  return pino(
    {
      level,
      base: { service: 'workfluence-api' },
      timestamp: pino.stdTimeFunctions.isoTime,
      // **요청 안의 모든 줄에 요청 식별자와 사용자** (P11 FR-1211). 줄이 직접 준 필드가 이긴다(실시간 편집은 그 연결의 사용자를 준다)
      mixin: () => {
        const c = currentRequest();
        return c ? { requestId: c.requestId, ...(c.userId ? { userId: c.userId } : {}) } : {};
      },
      // pino의 redact 경로는 정확 일치라 최상위만 가리면 중첩된 값이 새어 나간다.
      // 와일드카드(`*.x`)로 한 단계 아래까지 덮고, 토큰·세션 식별자도 포함한다 (FR-051).
      redact: [
        'req.headers.cookie',
        'req.headers.authorization',
        'headers.cookie',
        'headers.authorization',
        'password',
        'passwordHash',
        'token',
        'accessToken',
        'refreshToken',
        'idToken',
        'sessionId',
        'sid',
        'secret',
        'clientSecret',
        '*.password',
        '*.passwordHash',
        '*.token',
        '*.accessToken',
        '*.refreshToken',
        '*.idToken',
        '*.sessionId',
        '*.secret',
        '*.clientSecret',
      ],
    },
    destination ?? pino.destination({ fd: 1, sync: true }),
  );
}

/**
 * 받은 것을 로그 문장으로. **오류 객체는 `errorText`로** — 처리되지 않은 예외를 Nest가 오류 객체째 넘긴다(`ExceptionsHandler`).
 * 문자열은 우리가 쓴 문장이지만, Nest 안쪽이 `e.message`를 넘기는 자리가 있어 drizzle 문장만은 걸러 낸다
 */
function text(message: unknown): string {
  if (message instanceof Error) return errorText(message);
  return typeof message === 'string' ? scrubMessage(message) : String(message);
}

/** Nest가 처리되지 않은 예외를 넘기는 자리의 이름 — 그 줄은 `http.unhandled`다 (P11 D.4) */
const UNHANDLED_CONTEXT = 'ExceptionsHandler';

type Level = 'info' | 'warn' | 'error' | 'debug' | 'trace';

@Injectable()
export class PinoNestLogger implements LoggerService {
  constructor(private readonly logger: Logger) {}

  /**
   * **event 줄**(`logLine`)이면 필드로 펼친다 (P11 D.4) — `event`·식별자 필드·문장, 오류는 `error`(와 `error` 수준이면 `trace`)로
   */
  private eventLine(level: Level, message: unknown, context: string | undefined): boolean {
    if (!isLogLine(message)) return false;
    const { event, msg, fields, err } = message;
    const obj: Record<string, unknown> = { context, event, ...fields };
    if (err !== undefined) {
      obj.error = errorText(err);
      if (level === 'error') obj.trace = errorStack(err);
    }
    this.logger[level](obj, msg);
    return true;
  }

  log(message: unknown, context?: string): void {
    if (this.eventLine('info', message, context)) return;
    this.logger.info({ context }, text(message));
  }
  /**
   * 스택은 `trace`로 남긴다 — 예전에는 오류 객체가 오면 `String(err)`라 **스택이 버려졌다**(디버깅할 것이 없었다). 문자열로 온 스택도
   * 문장 줄을 걷어 낸다 — 스택의 첫 줄이 곧 오류 문장이다. 처리되지 않은 예외(`ExceptionsHandler`)는 `http.unhandled`로 적는다
   */
  error(message: unknown, trace?: string, context?: string): void {
    if (this.eventLine('error', message, context)) return;
    // 문자열 스택은 **drizzle 문장이 들어 있을 때만** 걸러 낸다 — 평범한 스택은 그대로가 디버깅에 낫다
    const stack = typeof trace === 'string' ? (trace.includes('Failed query:') ? scrubStack(trace, text(message)) : trace) : errorStack(message);
    const event: LogEvent | undefined = context === UNHANDLED_CONTEXT ? 'http.unhandled' : undefined;
    this.logger.error({ context, ...(event ? { event } : {}), trace: stack }, text(message));
  }
  warn(message: unknown, context?: string): void {
    if (this.eventLine('warn', message, context)) return;
    this.logger.warn({ context }, text(message));
  }
  debug(message: unknown, context?: string): void {
    if (this.eventLine('debug', message, context)) return;
    this.logger.debug({ context }, text(message));
  }
  verbose(message: unknown, context?: string): void {
    if (this.eventLine('trace', message, context)) return;
    this.logger.trace({ context }, text(message));
  }
}
