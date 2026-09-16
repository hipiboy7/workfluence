import { Global, Module } from '@nestjs/common';
import { parseEnv, type AppEnv } from '@workfluence/shared';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export const APP_ENV = Symbol('APP_ENV');
export type AppEnvToken = AppEnv;

/** 저장소 루트의 .env를 읽는다. process.env가 우선한다. 운영 컨테이너는 .env 마운트 또는 환경변수 주입. */
export function loadEnv(): AppEnv {
  const candidates = [resolve(process.cwd(), '.env'), resolve(__dirname, '../../../../.env')];
  const fromFile: Record<string, string> = {};
  const found = candidates.find((p) => existsSync(p));
  if (found) {
    for (const raw of readFileSync(found, 'utf8').split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const idx = line.indexOf('=');
      if (idx > 0) fromFile[line.slice(0, idx).trim()] = line.slice(idx + 1).trim().replace(/^"(.*)"$/, '$1');
    }
  }
  return parseEnv({ ...fromFile, ...process.env });
}

@Global()
@Module({
  providers: [{ provide: APP_ENV, useFactory: loadEnv }],
  exports: [APP_ENV],
})
export class ConfigModule {}
