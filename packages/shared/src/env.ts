import { z } from 'zod';
import { ROLES, type Role } from './constants';

/**
 * 환경변수 스키마 (P0_설계서_Foundation 1절, FR-010~FR-017).
 * - 모든 키는 WF_ 접두사. WF_로 시작하는데 여기 없는 키는 기동 실패 (오타·미배선 키를 즉시 드러낸다).
 * - 잘못된 타입도 기동 실패. 빈 문자열은 미설정으로 취급해 기본값을 쓴다.
 * - .env.example의 키 집합과 이 스키마의 키 집합이 같음을 env.spec.ts가 강제한다.
 *
 * Phase가 늘면 그 Phase에서 쓰는 키를 여기에 추가한다. 코드가 읽지 않는 키를 미리 선언하지 않는다 —
 * strict 스키마로 잡으려는 것이 바로 "값은 있는데 아무 일도 하지 않는" 키다.
 */

// zod 4의 .default()는 입력 문자열이 아니라 **출력 타입** 값을 받고, 값이 없을 때 파싱을 건너뛴다.
const bool = (def: boolean) =>
  z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .default(def);

/**
 * 그룹명 → 역할 매핑. JSON 문자열로 받는다 (P1_설계서_Auth 3.3절, FR-216).
 * 값이 ROLES에 없으면 기동 실패 — 오타 난 역할 이름이 "매핑 안 됨"으로 조용히 흘러가면
 * 그 그룹 사용자가 이유 없이 로그인 거부된다.
 */
const roleMap = z
  .string()
  .transform((raw, ctx) => {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        ctx.addIssue({ code: 'custom', message: 'JSON 객체여야 한다' });
        return z.NEVER;
      }
      const out: Record<string, Role> = {};
      for (const [group, role] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof role !== 'string' || !(ROLES as readonly string[]).includes(role)) {
          ctx.addIssue({ code: 'custom', message: `${group}: 역할은 ${ROLES.join('|')} 중 하나여야 한다` });
          return z.NEVER;
        }
        out[group] = role as Role;
      }
      return out;
    } catch {
      ctx.addIssue({ code: 'custom', message: 'JSON으로 파싱할 수 없다' });
      return z.NEVER;
    }
  })
  .default({} as Record<string, Role>);

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

    WF_TRUST_PROXY: bool(false),

    WF_SERVE_WEB: bool(false),
    WF_WEB_DIST: z.string().min(1).default('../web/dist'),

    // --- Phase 1: 세션·계정 (P1_설계서_Auth 9절) ---
    WF_SESSION_SECRET: z.string().min(32, '32자 이상'),
    WF_SESSION_IDLE_MINUTES: intString(1, 1440, 30),
    WF_SESSION_ABSOLUTE_HOURS: intString(1, 720, 12),
    WF_ROOT_USERNAME: z.string().min(1).default('root'),
    WF_ROOT_PASSWORD: z.string().min(1),

    // --- Phase 1: OIDC (FR-210~219) ---
    WF_OIDC_ENABLED: bool(false),
    WF_OIDC_ISSUER: z.string().default(''),
    WF_OIDC_CLIENT_ID: z.string().default(''),
    WF_OIDC_CLIENT_SECRET: z.string().default(''),
    WF_OIDC_REDIRECT_URI: z.string().default(''),
    WF_OIDC_PKCE: bool(true),
    WF_OIDC_ROLE_MAP: roleMap,
    WF_OIDC_MOCK: bool(false),
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
 * 운영에서 WF_DB_AUTO_MIGRATE=true는 허용하지 않는다 (설정 실수로 운영 DB가 기동과 함께 바뀌는 것을 막는다).
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
  const problems: string[] = [];
  if (env.WF_ENV === 'production' && env.WF_DB_AUTO_MIGRATE) {
    problems.push('WF_DB_AUTO_MIGRATE: 운영(production)에서는 true를 허용하지 않는다');
  }
  // 모의 인증이 운영에 켜지는 것은 조용히 잘못되는 유형이다 (P1_설계서_Auth 9절).
  if (env.WF_ENV === 'production' && env.WF_OIDC_MOCK) {
    problems.push('WF_OIDC_MOCK: 운영(production)에서는 모의 OIDC를 허용하지 않는다');
  }
  // 켜 놓고 값을 안 채우면 "로그인 버튼은 있는데 눌러도 안 되는" 상태가 된다. 기동에서 잡는다.
  if (env.WF_OIDC_ENABLED && !env.WF_OIDC_MOCK) {
    for (const key of ['WF_OIDC_ISSUER', 'WF_OIDC_CLIENT_ID', 'WF_OIDC_CLIENT_SECRET', 'WF_OIDC_REDIRECT_URI'] as const) {
      if (!env[key]) problems.push(`${key}: WF_OIDC_ENABLED=true면 값이 있어야 한다`);
    }
    if (Object.keys(env.WF_OIDC_ROLE_MAP).length === 0) {
      problems.push('WF_OIDC_ROLE_MAP: 비어 있으면 모든 IdP 사용자가 로그인 거부된다 (FR-218)');
    }
  }
  if (problems.length) throw new EnvValidationError(problems);
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
