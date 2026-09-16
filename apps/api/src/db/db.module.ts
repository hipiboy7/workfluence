import { Global, Inject, Injectable, Module, type OnModuleDestroy } from '@nestjs/common';
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
      // 접속 문자열 선택은 databaseUrl 한 곳에서 한다 (test 환경에서 개발 DB로 조용히 붙지 않게)
      useFactory: (env: AppEnvToken) => new Pool({ connectionString: databaseUrl(env), max: 10 }),
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
