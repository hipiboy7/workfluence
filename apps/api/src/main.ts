import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { CSRF_HEADER, CSRF_HEADER_VALUE } from '@workfluence/shared';
import connectPgSimple from 'connect-pg-simple';
import type { NextFunction, Request, Response } from 'express';
import session from 'express-session';
import type { Pool } from 'pg';
import { AppModule } from './app.module';
import { createLogger, PinoNestLogger } from './common/logger';
import { APP_ENV, type AppEnvToken } from './config/config.module';
import { PG_POOL } from './db/db.module';
import { runMigrations } from './db/migrate';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bufferLogs: true });
  const env = app.get<AppEnvToken>(APP_ENV);
  const logger = createLogger(env.WF_LOG_LEVEL);
  app.useLogger(new PinoNestLogger(logger));

  const pool = app.get<Pool>(PG_POOL);
  if (env.WF_DB_AUTO_MIGRATE) {
    const applied = await runMigrations(pool);
    logger.info({ applied }, '개발 모드 자동 마이그레이션 완료');
  }

  if (env.WF_TRUST_PROXY) app.set('trust proxy', 1);
  app.disable('x-powered-by');

  // 보안 헤더 (CLAUDE.md 7절). CSP는 SPA 자산이 self만 쓰도록 빌드된다는 전제
  app.use((_req: Request, res: Response, next: NextFunction) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
    );
    if (env.WF_COOKIE_SECURE) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    next();
  });

  // 서버측 세션: PG 테이블 (CLAUDE.md 0.2절·7절). 유휴 타임아웃 = 쿠키 maxAge(rolling). 절대 타임아웃은 AuthGuard.
  const PgStore = connectPgSimple(session);
  app.use(
    session({
      store: new PgStore({ pool, tableName: 'session', createTableIfMissing: true, pruneSessionInterval: 60 }),
      name: 'wf.sid',
      secret: env.WF_SESSION_SECRET,
      resave: false,
      saveUninitialized: false,
      rolling: true,
      cookie: {
        httpOnly: true,
        secure: env.WF_COOKIE_SECURE,
        sameSite: 'lax',
        maxAge: env.WF_SESSION_IDLE_MINUTES * 60_000,
        path: '/',
      },
    }),
  );

  // API 응답은 캐시 금지 + CSRF: 상태 변경 요청은 커스텀 헤더 필수 (CLAUDE.md 7절)
  app.use('/api', (req: Request, res: Response, next: NextFunction) => {
    res.setHeader('Cache-Control', 'no-store');
    const safe = req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS';
    if (!safe && req.headers[CSRF_HEADER] !== CSRF_HEADER_VALUE) {
      res.status(403).json({ statusCode: 403, message: `상태 변경 요청에는 ${CSRF_HEADER} 헤더가 필요하다` });
      return;
    }
    next();
  });

  app.useBodyParser('json', { limit: '2mb' });

  await app.listen(env.WF_PORT, '0.0.0.0');
  logger.info({ port: env.WF_PORT, env: env.WF_ENV, serveWeb: env.WF_SERVE_WEB }, 'workfluence api 기동');
}

bootstrap().catch((err) => {
  // 기동 실패(환경변수 검증 실패 등)는 즉시 종료. 조용히 뜬 채로 두지 않는다.
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
