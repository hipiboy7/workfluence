import { Injectable, type LoggerService } from '@nestjs/common';
import pino, { type Logger } from 'pino';

/**
 * JSON 한 줄 stdout 로거 (CLAUDE.md 0.2절). 비밀번호·토큰·세션 ID·문서 본문은 로그에 넣지 않는다 (7절).
 * Nest의 LoggerService 인터페이스에 맞춰 부트스트랩 로그도 같은 형식으로 나간다.
 */
export function createLogger(level: string): Logger {
  return pino({
    level,
    base: { service: 'workfluence-api' },
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: ['req.headers.cookie', 'req.headers.authorization', 'password', 'passwordHash'],
  });
}

@Injectable()
export class PinoNestLogger implements LoggerService {
  constructor(private readonly logger: Logger) {}
  log(message: unknown, context?: string): void {
    this.logger.info({ context }, String(message));
  }
  error(message: unknown, trace?: string, context?: string): void {
    this.logger.error({ context, trace }, String(message));
  }
  warn(message: unknown, context?: string): void {
    this.logger.warn({ context }, String(message));
  }
  debug(message: unknown, context?: string): void {
    this.logger.debug({ context }, String(message));
  }
  verbose(message: unknown, context?: string): void {
    this.logger.trace({ context }, String(message));
  }
}
