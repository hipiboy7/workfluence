import { Global, Inject, Injectable, Module, type OnModuleDestroy } from '@nestjs/common';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { APP_ENV, type AppEnvToken } from '../config/config.module';
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
      useFactory: (env: AppEnvToken) =>
        new Pool({
          connectionString: env.WF_ENV === 'test' && env.WF_DATABASE_URL_TEST ? env.WF_DATABASE_URL_TEST : env.WF_DATABASE_URL,
          max: 10,
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
