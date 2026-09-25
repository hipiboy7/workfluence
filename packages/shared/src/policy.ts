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
  // Phase 10 (P10_설계서_Llm I절) — 사용자 결정 2026-09-25: "7일, 사용자당 100개, … 즐겨찾기나 고정은 최대 20개"
  llmRetentionDays: 7,
  llmConversationMax: 100,
  llmPinnedMax: 20,
};

/**
 * **정책값이 절대 내려갈 수 없는 바닥.**
 *
 * 비밀번호 최소 길이 8자는 사용자 결정(2026-09-15)이라 운영이 그 아래로 못 내린다.
 * zod 계약은 이 바닥만 강제하고, 그 위의 세기는 살아 있는 정책값으로 서비스가 본다 —
 * zod가 파싱 시점에 현재 정책을 강제하면 **낮추는 방향이 영영 안 먹는다** (P4 자체 점검 2).
 */
export const POLICY_FLOOR = {
  passwordMinLength: 8,
  /** 사용자 결정(2026-09-15)은 "8자 이상 **+ 2종 이상**"이다. 바닥이 그 절반만 강제하면 안 된다 */
  passwordMinCharClasses: 2,
  /**
   * 감사로그 보존의 바닥.
   *
   * 이 값을 1일까지 내릴 수 있으면 **감사 추적 파기를 HTTP API만으로 예약**할 수 있다 —
   * 흔적을 남기는 일을 하고 보존을 1일로 내린 뒤 정리를 돌리면 된다. append-only 트리거가
   * 막으려던 결과를 권한 하나로 얻는 길이라 막는다. 사내 보존 정책(확인 필요 B)이
   * 확인되면 그 값으로 올린다 — **내리는 방향은 열지 않는다.**
   */
  auditRetentionDays: 90,
} as const;

export type Policy = typeof POLICY_DEFAULTS;
export const POLICY_KEYS = Object.keys(POLICY_DEFAULTS) as (keyof Policy)[];

/** 정수 값의 허용 범위. **아래 끝은 "그 값으로 두면 기능이 죽는다"를 막는 선이다** */
const RANGES: Record<string, { min: number; max: number }> = {
  uploadMaxMb: { min: 1, max: 1024 },
  sessionIdleMinutes: { min: 1, max: 1440 },
  sessionAbsoluteHours: { min: 1, max: 720 },
  passwordMinLength: { min: POLICY_FLOOR.passwordMinLength, max: 128 }, // 사용자 결정(2026-09-15)인 8자 아래로는 못 내린다
  passwordMinCharClasses: { min: POLICY_FLOOR.passwordMinCharClasses, max: 4 },
  lockoutThreshold: { min: 3, max: 100 },
  lockoutMinutes: { min: 1, max: 1440 },
  trashRetentionDays: { min: 1, max: 3650 },
  auditRetentionDays: { min: POLICY_FLOOR.auditRetentionDays, max: 3650 },
  llmRetentionDays: { min: 1, max: 365 },
  llmConversationMax: { min: 1, max: 1000 },
  // 0이면 고정을 쓰지 않는다. **대화 수보다 작아야 한다**는 짝 규칙은 `policyConsistencyProblems`가 본다
  llmPinnedMax: { min: 0, max: 999 },
};

const isValidInt = (key: string, v: unknown): v is number => {
  const r = RANGES[key];
  return !!r && typeof v === 'number' && Number.isInteger(v) && v >= r.min && v <= r.max;
};

const isValidExtensions = (v: unknown): v is string[] =>
  Array.isArray(v) && v.length > 0 && v.every((e) => typeof e === 'string' && (ALLOWED_UPLOAD_EXTENSIONS as readonly string[]).includes(e));

/**
 * DB에서 읽은 값을 기본값 위에 얹는다 — **값 둘에 걸친 짝은 맞추지 않는다.**
 *
 * 쓰기 판정(`policyConsistencyProblems`)은 이것을 본다. 읽기용 `applyPolicy`는 어긋난 짝을 조용히 맞추므로, 그 결과로 판정하면
 * 어긋난 값이 판정을 지나 저장된다 (검토 반영 — 코드 리뷰).
 */
export function mergePolicy(stored: Record<string, unknown>): Policy {
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

/**
 * DB에서 읽은 값을 기본값 위에 얹는다 — 읽기용.
 *
 * **모르는 키와 틀린 값은 조용히 버린다.** 여기서 던지면 DB 한 줄이 잘못됐을 때 앱이 아예
 * 뜨지 않는다 — 고치러 들어갈 화면도 같이 죽는다. 막는 자리는 `validatePolicyPatch`(쓰기)다.
 */
export function applyPolicy(stored: Record<string, unknown>): Policy {
  const out = mergePolicy(stored);
  // **짝이 어긋나면 고정 수를 낮춰 맞춘다** (P10 FR-1134). 쓰기에서 막으므로 여기 오는 것은 관리 화면 밖에서 손댄 DB다 —
  // 던지면 기동이 막히고, 그대로 두면 고정만으로 상한이 차서 새 대화를 저장할 때 지울 것이 없다
  if (out.llmPinnedMax >= out.llmConversationMax) out.llmPinnedMax = out.llmConversationMax - 1;
  return out;
}

/**
 * **값 둘 이상에 걸친 규칙** (P10 FR-1134). 통과하면 빈 배열.
 *
 * `validatePolicyPatch`는 바꾸려는 값 하나하나의 범위만 본다 — 짝은 **바꾼 뒤의 전체**로 봐야 한다(한쪽만 바꾸는 요청이 있다).
 * 서버는 합친 값으로, 관리 화면은 지금 값에 입력을 얹은 것으로 같은 함수를 부른다.
 */
export function policyConsistencyProblems(policy: Policy): string[] {
  const problems: string[] = [];
  if (policy.llmPinnedMax >= policy.llmConversationMax) {
    problems.push(`고정 수(llmPinnedMax ${policy.llmPinnedMax})는 대화 수(llmConversationMax ${policy.llmConversationMax})보다 작아야 한다 — 같으면 고정만으로 상한이 차서 새 대화를 둘 자리가 없다`);
  }
  return problems;
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
