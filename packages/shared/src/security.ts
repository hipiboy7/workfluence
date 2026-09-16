import { PASSWORD_POLICY, TEMP_PASSWORD_LENGTH } from './constants';
import { checkPasswordPolicy } from './permissions';

/**
 * 계정 복구·초기화에 쓰는 순수 함수 (A등급).
 * 난수 소스는 주입받는다 — 서버는 crypto.randomInt, 테스트는 결정적 시퀀스.
 */

/** ID 마스킹: 앞 2자(길이 5 이상이면 뒤 1자도) 노출, 나머지 `*`. 길이 2 이하는 첫 글자만. */
export function maskUsername(username: string): string {
  const n = username.length;
  if (n === 0) return '';
  if (n <= 2) return username[0] + '*'.repeat(n - 1);
  const head = username.slice(0, 2);
  const tail = n >= 5 ? username.slice(-1) : '';
  return head + '*'.repeat(n - head.length - tail.length) + tail;
}

/** email 마스킹(감사로그용): 로컬 파트 앞 2자만 노출 */
export function maskEmail(email: string): string {
  const [local = '', domain = ''] = email.split('@');
  const shown = local.slice(0, 2);
  return `${shown}${'*'.repeat(Math.max(local.length - shown.length, 1))}@${domain}`;
}

const LOWER = 'abcdefghjkmnpqrstuvwxyz'; // i, l, o 제외 (혼동 문자)
const UPPER = 'ABCDEFGHJKMNPQRSTUVWXYZ';
const DIGIT = '23456789';
const SYMBOL = '!@#$%&*+-=?';
const ALL = LOWER + UPPER + DIGIT + SYMBOL;

export type RandomInt = (maxExclusive: number) => number;

/**
 * 임시 비밀번호 생성. 4종(소문자·대문자·숫자·특수)을 각 1자 이상 보장하므로 정책(2종 이상)을 항상 만족한다.
 * 혼동 문자(0/O, 1/l/I)는 제외한다 — 화면에서 읽고 옮겨 적는 값이다.
 */
export function generateTemporaryPassword(randomInt: RandomInt, length: number = TEMP_PASSWORD_LENGTH): string {
  if (length < 4) throw new Error('임시 비밀번호 길이는 4 이상');
  const pick = (set: string) => set[randomInt(set.length)];
  const chars = [pick(LOWER), pick(UPPER), pick(DIGIT), pick(SYMBOL)];
  while (chars.length < length) chars.push(pick(ALL));
  // Fisher–Yates 셔플: 앞 4자리가 항상 같은 종류 순서가 되지 않게
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  const pw = chars.join('');
  const violations = checkPasswordPolicy(pw, PASSWORD_POLICY);
  if (violations.length) throw new Error(`생성된 임시 비밀번호가 정책을 위반: ${violations.join(', ')}`);
  return pw;
}

/** 스페이스 내부 식별자(key) 자동 생성: WF + 6자 대문자·숫자 */
export function generateSpaceKey(randomInt: RandomInt): string {
  const set = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let s = 'WF';
  for (let i = 0; i < 6; i++) s += set[randomInt(set.length)];
  return s;
}
