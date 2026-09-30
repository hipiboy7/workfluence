import { POLICY_FLOOR, type Policy } from '@workfluence/shared';

/** 운영 설정의 숫자 키 — `Policy`에서 값이 수인 것만 */
export type PolicyNumberKey = { [K in keyof Policy]: Policy[K] extends number ? K : never }[keyof Policy];

/** 운영 설정 화면의 묶음 (P17 설계서 J.6 — 구획 폼 묶음 넷) */
export type PolicyGroup = 'session' | 'upload' | 'retention' | 'llm';

export const POLICY_GROUPS: readonly { id: PolicyGroup; title: string }[] = [
  { id: 'session', title: '세션·계정' },
  { id: 'upload', title: '업로드·첨부' },
  { id: 'retention', title: '보존 기간' },
  { id: 'llm', title: 'LLM 대화' },
];

/**
 * 운영 설정의 **화면 이름** (P17 설계서 J.9-9) — 키는 개발 용어라 한글 이름을 앞에 두고 키는 괄호 안에 남긴다("휴지통 보존 기간
 * (trashRetentionDays)"). 키는 장애대응 가이드·감사로그의 `settings.update`·시험이 찾는 이름이다.
 *
 * - `unit`은 칸 뒤의 글이다 — 라벨 밖에 둔다(J.5.3 "라벨 글은 이름만")
 * - `group`이 없는 키는 이 화면에 보이지 않는다 — 감사 기록 단계는 감사로그 화면에서 시스템 관리자가 고른다(P17 FR-1842)
 * - `help`는 값의 뜻이다. **범위는 여기 적지 않는다** — 범위의 한 곳은 `packages/shared/src/policy.ts`다(`CLAUDE.md` 1.3절). 바닥만은 공유 상수
 *   (`POLICY_FLOOR`)에서 읽는다
 *
 * `Record`라 `Policy`에 숫자 키가 늘면 여기 이름이 없을 때 타입 검사가 잡는다. 묶음 안의 순서는 여기 적은 순서다
 */
export const POLICY_NAMES: Record<
  PolicyNumberKey,
  {
    name: string;
    unit: string;
    group: PolicyGroup | null;
    help?: string;
    /** 값이 몇 가지뿐이면 고르는 칸으로 — 메일 재설정 켜기·끄기(P19 FR-2008) */
    choices?: readonly { value: number; label: string }[];
  }
> = {
  sessionIdleMinutes: { name: '세션 유휴 시간', unit: '분', group: 'session', help: '이만큼 아무것도 하지 않으면 로그아웃된다.' },
  sessionAbsoluteHours: { name: '세션 최대 시간', unit: '시간', group: 'session', help: '로그인한 뒤 이만큼 지나면 쓰고 있어도 다시 로그인한다.' },
  passwordMinLength: {
    name: '비밀번호 최소 길이',
    unit: '자',
    group: 'session',
    help: `${POLICY_FLOOR.passwordMinLength}자 아래로는 내리지 못한다.`,
  },
  passwordMinCharClasses: {
    name: '비밀번호 문자 종류',
    unit: '종',
    group: 'session',
    help: `영문 대문자·소문자·숫자·특수문자 가운데 몇 종을 섞는가. ${POLICY_FLOOR.passwordMinCharClasses}종 아래로는 내리지 못한다.`,
  },
  lockoutThreshold: { name: '잠금까지 실패 횟수', unit: '회', group: 'session', help: '비밀번호를 이만큼 잇달아 틀리면 계정을 잠근다.' },
  lockoutMinutes: { name: '잠금 시간', unit: '분', group: 'session' },
  passwordResetMail: {
    name: 'email로 비밀번호 재설정',
    unit: '',
    group: 'session',
    help: '켜면 비밀번호 찾기에서 가입할 때 넣은 email로 재설정 링크를 받는다(root는 빠진다). 사내 메일이 켜져 있고 공개 주소(WF_PUBLIC_URL)가 있어야 쓰인다. 끄면 이미 보낸 링크도 막힌다.',
    choices: [
      { value: 1, label: '켬' },
      { value: 0, label: '끔' },
    ],
  },
  uploadMaxMb: { name: '업로드 최대 크기', unit: 'MB', group: 'upload' },
  trashRetentionDays: { name: '휴지통 보존 기간', unit: '일', group: 'retention', help: '지난 것은 달마다 하는 정리 작업이 되살릴 수 없게 지운다.' },
  auditRetentionDays: {
    name: '감사로그 보존 기간',
    unit: '일',
    group: 'retention',
    help: `${POLICY_FLOOR.auditRetentionDays}일 아래로는 내리지 못한다 — 감사 추적을 설정 하나로 지우지 못하게.`,
  },
  llmRetentionDays: { name: 'LLM 대화 보존 기간', unit: '일', group: 'llm', help: '고정하지 않은 대화는 마지막으로 쓴 뒤 이만큼 지나면 지워진다.' },
  llmConversationMax: { name: '사람마다 대화 수', unit: '개', group: 'llm', help: '고정한 것도 센다. 넘으면 고정하지 않은 것 가운데 오래된 것부터 지워진다.' },
  llmPinnedMax: { name: '사람마다 고정 수', unit: '개', group: 'llm', help: '대화 수보다 작아야 한다. 0이면 고정을 쓰지 않는다.' },
  auditLevel: { name: '감사 기록 단계', unit: '단계', group: null },
};

/** 그 묶음의 키 — 여기 적은 순서대로 */
export function policyKeysOf(group: PolicyGroup): PolicyNumberKey[] {
  return (Object.keys(POLICY_NAMES) as PolicyNumberKey[]).filter((k) => POLICY_NAMES[k].group === group);
}
