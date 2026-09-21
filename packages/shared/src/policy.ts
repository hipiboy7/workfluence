import { ALLOWED_UPLOAD_EXTENSIONS, PASSWORD_POLICY } from './constants';

/**
 * 운영 정책값 (A등급, P4_설계서_Admin E절, FR-520~527).
 *
 * `CLAUDE.md` 5절의 **세 번째 분류**다 — 운영 중 관리자가 조절하는 값. 기본값은 여기(코드)에
 * 남고, DB `settings`에 값이 있으면 그것이 이긴다. **DB가 비어도 기동해야 한다** (FR-522).
 *
 * 순수 함수다. 서버(변경 판정)와 화면(입력 판정)이 같은 규칙을 쓴다 — 둘이 갈라지면
 * "화면은 받아 주는데 저장이 안 되는" 상태가 된다.
 */

export const POLICY_DEFAULTS = {
  uploadMaxMb: 20,
  allowedExtensions: [...ALLOWED_UPLOAD_EXTENSIONS] as string[],
  sessionIdleMinutes: 30,
  sessionAbsoluteHours: 12,
  passwordMinLength: PASSWORD_POLICY.minLength,
  passwordMinCharClasses: PASSWORD_POLICY.minCharClasses,
  lockoutThreshold: PASSWORD_POLICY.lockoutThreshold,
  lockoutMinutes: PASSWORD_POLICY.lockoutMinutes,
  trashRetentionDays: 30,
  auditRetentionDays: 365,
};

export type Policy = typeof POLICY_DEFAULTS;
export const POLICY_KEYS = Object.keys(POLICY_DEFAULTS) as (keyof Policy)[];

/** 정수 값의 허용 범위. **아래 끝은 "그 값으로 두면 기능이 죽는다"를 막는 선이다** */
const RANGES: Record<string, { min: number; max: number }> = {
  uploadMaxMb: { min: 1, max: 1024 },
  sessionIdleMinutes: { min: 1, max: 1440 },
  sessionAbsoluteHours: { min: 1, max: 720 },
  passwordMinLength: { min: 8, max: 128 }, // 사용자 결정(2026-09-15)인 8자 아래로는 못 내린다
  passwordMinCharClasses: { min: 1, max: 4 },
  lockoutThreshold: { min: 3, max: 100 },
  lockoutMinutes: { min: 1, max: 1440 },
  trashRetentionDays: { min: 1, max: 3650 },
  auditRetentionDays: { min: 1, max: 3650 },
};

const isValidInt = (key: string, v: unknown): v is number => {
  const r = RANGES[key];
  return !!r && typeof v === 'number' && Number.isInteger(v) && v >= r.min && v <= r.max;
};

const isValidExtensions = (v: unknown): v is string[] =>
  Array.isArray(v) && v.length > 0 && v.every((e) => typeof e === 'string' && (ALLOWED_UPLOAD_EXTENSIONS as readonly string[]).includes(e));

/**
 * DB에서 읽은 값을 기본값 위에 얹는다.
 *
 * **모르는 키와 틀린 값은 조용히 버린다.** 여기서 던지면 DB 한 줄이 잘못됐을 때 앱이 아예
 * 뜨지 않는다 — 고치러 들어갈 화면도 같이 죽는다. 막는 자리는 `validatePolicyPatch`(쓰기)다.
 */
export function applyPolicy(stored: Record<string, unknown>): Policy {
  const out = { ...POLICY_DEFAULTS, allowedExtensions: [...POLICY_DEFAULTS.allowedExtensions] };
  for (const key of POLICY_KEYS) {
    const v = stored[key];
    if (v === undefined) continue;
    if (key === 'allowedExtensions') {
      if (isValidExtensions(v)) out.allowedExtensions = [...v];
    } else if (isValidInt(key, v)) {
      (out as Record<string, unknown>)[key] = v;
    }
  }
  return out;
}

/** 바꾸려는 값 판정. 통과하면 빈 배열, 아니면 사람이 읽을 이유들 */
export function validatePolicyPatch(patch: Record<string, unknown>): string[] {
  const errors: string[] = [];
  const keys = Object.keys(patch);
  if (keys.length === 0) return ['바꿀 값이 없다'];

  for (const key of keys) {
    if (!(POLICY_KEYS as string[]).includes(key)) {
      errors.push(`모르는 설정 키다: ${key}`);
      continue;
    }
    const v = patch[key];
    if (key === 'allowedExtensions') {
      if (!isValidExtensions(v)) errors.push('허용 확장자는 우리가 판정할 수 있는 소문자 확장자 목록이어야 하고 비어 있을 수 없다');
    } else if (!isValidInt(key, v)) {
      const r = RANGES[key];
      errors.push(`${key}는 ${r.min}~${r.max} 사이의 정수여야 한다`);
    }
  }
  return errors;
}
