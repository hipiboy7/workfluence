import { z } from 'zod';

/**
 * 환경변수 스키마 (CLAUDE.md 5절).
 * - 모든 키는 WF_ 접두사. WF_로 시작하는데 여기 없는 키는 기동 실패 (오타·미배선 키를 즉시 드러낸다).
 * - 잘못된 타입도 기동 실패.
 * - .env.example의 키 집합과 이 스키마의 키 집합이 같음을 env.spec.ts가 강제한다.
 */

// zod 4의 .default()는 입력 문자열이 아니라 **출력 타입** 값을 받고, 값이 없을 때 파싱을 건너뛴다.
const bool = (def: boolean) =>
  z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .default(def);

const intString = (min: number, max: number, def: number) =>
  z
    .string()
    .regex(/^\d+$/, '정수여야 한다')
    .transform(Number)
    .pipe(z.number().int().min(min).max(max))
    .default(def);

export const envSchema = z
  .object({
    WF_ENV: z.enum(['development', 'test', 'production']).default('development'),
    WF_PORT: intString(1, 65535, 3000),
    WF_LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

    WF_DATABASE_URL: z.string().url(),
    WF_DATABASE_URL_TEST: z.string().url().optional(),
    WF_DB_AUTO_MIGRATE: bool(false),

    WF_PG_EMBEDDED_DIR: z.string().min(1).default('.local/pgdata'),
    WF_PG_EMBEDDED_PORT: intString(1024, 65535, 5433),
    WF_PG_EMBEDDED_PASSWORD: z.string().min(1).default('workfluence'),

    WF_SESSION_SECRET: z.string().min(32, '세션 시크릿은 32자 이상'),
    WF_COOKIE_SECURE: bool(false),
    WF_SESSION_IDLE_MINUTES: intString(1, 24 * 60, 30),
    WF_SESSION_ABSOLUTE_HOURS: intString(1, 24 * 30, 12),
    WF_TRUST_PROXY: bool(false),

    // 최초 root 계정 (pnpm db:seed). 개발(development)에서는 admin1·member1·pending1 시드 계정도 같은 비밀번호를 쓴다
    WF_ROOT_USERNAME: z.string().min(1).default('root'),
    WF_ROOT_INITIAL_PASSWORD: z.string().min(8).optional(),
    WF_ROOT_EMAIL: z.string().min(3).default('root@example.internal'),

    WF_SERVE_WEB: bool(false),
    WF_WEB_DIST: z.string().min(1).default('../web/dist'),
  })
  .strict();

export type AppEnv = z.infer<typeof envSchema>;

/** 스키마에 선언된 키 목록. .env.example 대조와 문서 표 생성에 쓴다. */
export const ENV_KEYS = Object.keys(envSchema.shape) as (keyof AppEnv)[];

export class EnvValidationError extends Error {
  constructor(public readonly issues: string[]) {
    super(`환경변수 검증 실패:\n  - ${issues.join('\n  - ')}`);
    this.name = 'EnvValidationError';
  }
}

/**
 * process.env 같은 문자열 맵에서 WF_* 키만 골라 검증한다.
 * 운영에서 WF_DB_AUTO_MIGRATE=true는 허용하지 않는다 (CLAUDE.md 6절).
 */
export function parseEnv(source: Record<string, string | undefined>): AppEnv {
  const picked: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (key.startsWith('WF_') && value !== undefined && value !== '') picked[key] = value;
  }
  const result = envSchema.safeParse(picked);
  if (!result.success) {
    throw new EnvValidationError(
      result.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`),
    );
  }
  const env = result.data;
  if (env.WF_ENV === 'production' && env.WF_DB_AUTO_MIGRATE) {
    throw new EnvValidationError(['WF_DB_AUTO_MIGRATE: 운영(production)에서는 true를 허용하지 않는다']);
  }
  return env;
}

/** .env.example 본문에서 키를 추출한다 (주석·빈 줄 제외). */
export function extractEnvExampleKeys(content: string): string[] {
  return content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
    .map((line) => line.split('=')[0].trim());
}
