import { Module } from '@nestjs/common';
import { ServeStaticModule } from '@nestjs/serve-static';
import { resolve } from 'node:path';
import { AuditModule } from './audit/audit.module';
import { AuthModule } from './auth/auth.module';
import { APP_ENV, ConfigModule, loadEnv } from './config/config.module';
import { DbModule } from './db/db.module';
import { HealthController } from './health/health.controller';
import { PagesModule } from './pages/pages.module';
import { SearchModule } from './search/search.module';
import { SpacesModule } from './spaces/spaces.module';
import { UsersModule } from './users/users.module';

// SPA 정적 서빙 여부는 부트스트랩 전에 알아야 하므로 여기서 한 번 더 읽는다 (ConfigModule과 같은 로더)
const env = loadEnv();

@Module({
  imports: [
    ConfigModule,
    DbModule,
    AuditModule,
    UsersModule,
    AuthModule,
    SpacesModule,
    PagesModule,
    SearchModule,
    ...(env.WF_SERVE_WEB
      ? [
          ServeStaticModule.forRoot({
            rootPath: resolve(__dirname, '..', env.WF_WEB_DIST),
            exclude: ['/api/{*splat}'],
            serveStaticOptions: {
              // 해시 파일명 자산은 immutable, index.html은 no-store (CLAUDE.md 7절 응답 헤더)
              setHeaders: (res, path) => {
                // Vite 산출물: assets/<name>-<8자 이상 해시>.<ext>
                if (/[\\/]assets[\\/][^\\/]+-[A-Za-z0-9_-]{8,}\.[a-z0-9]+$/i.test(path)) res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
                else res.setHeader('Cache-Control', 'no-store');
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
