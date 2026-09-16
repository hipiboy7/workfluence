import { Module } from '@nestjs/common';
import { ServeStaticModule } from '@nestjs/serve-static';
import { resolve } from 'node:path';
import { APP_ENV, ConfigModule, loadEnv } from './config/config.module';
import { DbModule } from './db/db.module';
import { HealthController } from './health/health.controller';

// SPA 정적 서빙 여부는 모듈 구성 시점에 알아야 하므로 같은 로더를 한 번 더 호출한다 (순수 함수라 결과가 같다)
const env = loadEnv();

@Module({
  imports: [
    ConfigModule,
    DbModule,
    ...(env.WF_SERVE_WEB
      ? [
          ServeStaticModule.forRoot({
            rootPath: resolve(__dirname, '..', env.WF_WEB_DIST),
            exclude: ['/api/{*splat}'],
            serveStaticOptions: {
              // 해시 파일명 자산만 immutable, 나머지는 no-store (CLAUDE.md 7절)
              // Vite 산출물: assets/<name>-<8자 이상 base64url 해시>.<ext>
              setHeaders: (res, path) => {
                if (/[\\/]assets[\\/][^\\/]+-[A-Za-z0-9_-]{8,}\.[a-z0-9]+$/i.test(path)) {
                  res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
                } else {
                  res.setHeader('Cache-Control', 'no-store');
                }
              },
            },
          }),
        ]
      : []),
  ],
  controllers: [HealthController],
})
export class AppModule {}

export { APP_ENV };
