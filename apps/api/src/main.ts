import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { LogEvent } from '@workfluence/shared';
import type { Server } from 'node:http';
import { CollabGateway } from './pages/collab/collab.gateway';
import type { NestExpressApplication } from '@nestjs/platform-express';
import connectPgSimple from 'connect-pg-simple';
import type { NextFunction, Request, Response } from 'express';
import session from 'express-session';
import type { Pool } from 'pg';
import { AppModule } from './app.module';
import { errorText, isQueryError } from './common/error-text';
import { PinoNestLogger, createLogger } from './common/logger';
import { requestMiddleware } from './common/request-log.middleware';
import { APP_ENV, type AppEnvToken } from './config/config.module';
import { PG_POOL } from './db/db.module';
import { runMigrations } from './db/migrate';

/**
 * 부트스트랩 (P0_설계서_Foundation 6절, P1_설계서_Auth 4절).
 */
async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bufferLogs: true });
  const env = app.get<AppEnvToken>(APP_ENV);
  const logger = createLogger(env.WF_LOG_LEVEL);
  app.useLogger(new PinoNestLogger(logger));

  if (env.WF_DB_AUTO_MIGRATE) {
    // 운영에서는 env 스키마가 true를 거부한다 (FR-014)
    const applied = await runMigrations(app.get<Pool>(PG_POOL));
    logger.info({ event: 'app.migrated' satisfies LogEvent, applied }, '개발 모드 자동 마이그레이션 완료');
  }

  // **첫 미들웨어** — 요청 식별자·요청 문맥·접근 로그 (P11_설계서_Ops D.2·D.3). 뒤의 모든 미들웨어·가드·서비스가 그 문맥 안에서 돈다
  app.use(requestMiddleware(logger));

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

  /**
   * 서버측 세션 (FR-220~223). 저장소는 PG이고 **앱과 같은 풀을 재사용한다** (P0 13절 인계).
   *
   * - 쿠키 maxAge = 유휴 타임아웃. `rolling`이 요청마다 갱신한다
   * - **절대 타임아웃은 쿠키로 못 지킨다** — rolling이 갱신해 버리므로 AuthGuard가 본다
   * - 테이블은 마이그레이션이 만든다. createTableIfMissing을 켜면 스키마가 두 곳에서 관리된다
   */
  const PgStore = connectPgSimple(session);
  app.use(
    session({
      name: 'wf.sid',
      store: new PgStore({ pool: app.get<Pool>(PG_POOL), tableName: 'sessions', createTableIfMissing: false }),
      secret: env.WF_SESSION_SECRET,
      resave: false,
      saveUninitialized: false,
      rolling: true,
      cookie: {
        httpOnly: true,
        sameSite: 'lax',
        secure: env.WF_ENV === 'production',
        maxAge: env.WF_SESSION_IDLE_MINUTES * 60_000,
      },
    }),
  );

  await app.listen(env.WF_PORT, '0.0.0.0');

  // **실시간 편집을 같은 HTTP 서버에 붙인다** (P6_설계서_Collab C.2절). 포트를 따로 열면
  // nginx 설정이 둘이 되고 방화벽 규칙도 둘이 된다 — 폐쇄망에서 늘릴 이유가 없다.
  // `listen` 뒤에 붙이는 것은 그때 서버 객체가 실제로 듣고 있기 때문이다
  app.get(CollabGateway).attach(app.getHttpServer() as Server);
  // event는 목록(`LOG_EVENTS`)의 코드다 — `satisfies`가 오타를 컴파일에서 막는다(가이드 대조는 목록만 본다, P11 자체 점검 7)
  logger.info({ event: 'app.started' satisfies LogEvent, port: env.WF_PORT, env: env.WF_ENV, serveWeb: env.WF_SERVE_WEB }, 'workfluence api 기동');
}

bootstrap().catch((err) => {
  // 기동 실패(환경변수 검증 실패 등)는 즉시 종료한다. 조용히 뜬 채로 두지 않는다.
  // 환경변수 오류는 여러 줄 문장 그대로 — 무엇을 고칠지 다 보여야 한다. DB 질의 오류는 매개변수를 싣지 않는다(7절, `errorText`)
  console.error(isQueryError(err) ? errorText(err) : err instanceof Error ? err.message : err);
  process.exit(1);
});
