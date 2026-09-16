import { defineConfig } from 'drizzle-kit';

// 마이그레이션 SQL 생성 전용. 적용은 src/db/migrate.ts (CLAUDE.md 6절: 운영은 명시적 단계로만)
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema.ts',
  out: './drizzle',
  dbCredentials: {
    url: process.env.WF_DATABASE_URL ?? 'postgres://workfluence:workfluence@127.0.0.1:5433/workfluence',
  },
  strict: true,
  verbose: true,
});
