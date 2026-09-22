import { Global, Inject, Injectable, Module, type OnModuleDestroy } from '@nestjs/common';
import { DB_POOL } from '@workfluence/shared';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { APP_ENV, databaseUrl, type AppEnvToken } from '../config/config.module';
import * as schema from './schema';

export const DB = Symbol('DB');
export const PG_POOL = Symbol('PG_POOL');
export type Db = NodePgDatabase<typeof schema>;

@Injectable()
export class PoolHolder implements OnModuleDestroy {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}
  async onModuleDestroy(): Promise<void> {
    await this.pool.end();
  }
}

@Global()
@Module({
  providers: [
    {
      provide: PG_POOL,
      inject: [APP_ENV],
      // 접속 문자열 선택은 databaseUrl 한 곳에서 한다 (test 환경에서 개발 DB로 조용히 붙지 않게).
      //
      // **기다림에 상한을 둔다** (T-026). 풀이 마르면 예전에는 아무 말 없이 영원히 기다렸고,
      // 그래서 앱 전체가 멈춘 채 헬스체크만 무응답이 됐다. 지금은 10초 뒤 실패해서 로그와
      // 응답에 드러난다. `idle_in_transaction_session_timeout`은 새는 연결을 DB가 직접 끊는다
      useFactory: (env: AppEnvToken) =>
        new Pool({
          connectionString: databaseUrl(env),
          max: DB_POOL.max,
          connectionTimeoutMillis: DB_POOL.connectionTimeoutMillis,
          options: `-c idle_in_transaction_session_timeout=${DB_POOL.idleInTransactionTimeoutMillis}`,
        }),
    },
    {
      provide: DB,
      inject: [PG_POOL],
      useFactory: (pool: Pool): Db => drizzle(pool, { schema }),
    },
    PoolHolder,
  ],
  exports: [DB, PG_POOL],
})
export class DbModule {}
