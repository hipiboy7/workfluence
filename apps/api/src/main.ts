import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { NextFunction, Request, Response } from 'express';
import type { Pool } from 'pg';
import { AppModule } from './app.module';
import { PinoNestLogger, createLogger } from './common/logger';
import { APP_ENV, type AppEnvToken } from './config/config.module';
import { PG_POOL } from './db/db.module';
import { runMigrations } from './db/migrate';

/**
 * 부트스트랩 (P0_설계서_Foundation 6절).
 * 세션·CSRF는 Phase 1에서 붙인다 — 보호할 세션이 없는 상태의 CSRF 미들웨어는 의미 없는 관문이다.
 */
async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bufferLogs: true });
  const env = app.get<AppEnvToken>(APP_ENV);
  const logger = createLogger(env.WF_LOG_LEVEL);
  app.useLogger(new PinoNestLogger(logger));

  if (env.WF_DB_AUTO_MIGRATE) {
    // 운영에서는 env 스키마가 true를 거부한다 (FR-014)
    const applied = await runMigrations(app.get<Pool>(PG_POOL));
    logger.info({ applied }, '개발 모드 자동 마이그레이션 완료');
  }

  if (env.WF_TRUST_PROXY) app.set('trust proxy', 1);
  app.disable('x-powered-by');

  // 보안 응답 헤더 (CLAUDE.md 7절). SPA 자산이 self만 참조한다는 전제
  app.use((_req: Request, res: Response, next: NextFunction) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
    );
    if (env.WF_ENV === 'production') res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    next();
  });

  // API 응답은 캐시 금지
  app.use('/api', (_req: Request, res: Response, next: NextFunction) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });

  app.useBodyParser('json', { limit: '2mb' });

  await app.listen(env.WF_PORT, '0.0.0.0');
  logger.info({ port: env.WF_PORT, env: env.WF_ENV, serveWeb: env.WF_SERVE_WEB }, 'workfluence api 기동');
}

bootstrap().catch((err) => {
  // 기동 실패(환경변수 검증 실패 등)는 즉시 종료한다. 조용히 뜬 채로 두지 않는다.
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
