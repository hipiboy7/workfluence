import { createHash } from 'node:crypto';
import { PASSWORD_RESET, canResetPasswordByMail, type Role, type UserStatus } from '@workfluence/shared';

/**
 * 메일 재설정 링크 (A등급, P19_설계서_Recovery C.3, FR-2003~2005·2008). **판정만 한다** — 시간(`now`)과 무작위 바이트는 부르는 쪽이 넣는다.
 * 표에 쓰고 메일을 보내는 것은 `RecoveryService`다.
 */

const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');

/** 값 — 무작위 바이트를 base64url로(주소에 그대로 싣는다). **바이트 수가 맞지 않으면 던진다** — 짧은 값은 추측할 수 있다 (A.1-5) */
export function newResetToken(bytes: Buffer): string {
  if (bytes.length !== PASSWORD_RESET.tokenBytes) throw new Error(`재설정 값은 ${PASSWORD_RESET.tokenBytes}바이트여야 한다`);
  return bytes.toString('base64url');
}

/** 서버에 두는 것 — 값의 SHA-256(16진). DB가 새어도 링크가 되지 않는다 */
export function tokenDigest(token: string): string {
  return sha256(token);
}

/**
 * 발급 때의 비밀번호 해시에서 뽑은 표시 (A.1-4). 쓸 때 지금 해시의 것과 견준다 — 본인 변경·관리자 초기화·다른 링크 어느 길로 바뀌었든 링크가 죽는다.
 * 길마다 링크를 지우는 코드를 두면 새 길이 생길 때 잊는다
 */
export function passwordMark(passwordHash: string): string {
  return sha256(passwordHash);
}

/**
 * 링크 주소 — 값은 **`#` 뒤**다 (A.1-6). 브라우저가 서버로 보내지 않아 접근 로그·Referer에 가지 않는다. 공개 주소 끝의 `/`는 뗀다.
 * 주소가 없으면 `null` — 이 메일은 링크가 전부라 보낼 수 없다
 */
export function resetLinkUrl(publicUrl: string, token: string): string | null {
  const base = publicUrl.trim().replace(/\/+$/, '');
  return base ? `${base}/reset-password#t=${token}` : null;
}

export function linkExpiresAt(now: Date): Date {
  return new Date(now.getTime() + PASSWORD_RESET.linkMinutes * 60_000);
}

/**
 * 이 계정에 지금 메일을 보내지 않는가 — 마지막 발급이 간격(5분) 안이면 (A.1-7). 마지막 발급이 **미래**면(시계가 뒤로 갔다) 보내지 않는다 — 되풀이를
 * 막는 쪽으로 틀린다
 */
export function mailThrottled(lastIssuedAt: Date | null, now: Date): boolean {
  if (!lastIssuedAt) return false;
  return now.getTime() - lastIssuedAt.getTime() < PASSWORD_RESET.mailIntervalMinutes * 60_000;
}

/**
 * **보내기가 실패하면 간격만 푼다** (병합 전 코드 리뷰 4) — 발급 시각을 간격만큼 앞당긴다. 값을 지우면 메일 API가 받아 놓고 늦게(시간 제한 뒤) 답했을 때
 * 이미 닿은 링크가 죽는다. 기한(`expires_at`)은 그대로다 — 곧바로 다시 요청할 수 있고, 새 요청은 옛 값을 지운다
 */
export function throttleReleasedAt(now: Date): Date {
  return new Date(now.getTime() - PASSWORD_RESET.mailIntervalMinutes * 60_000);
}

export type ResetLinkProblem = 'expired' | 'changed' | 'ineligible';

/**
 * 링크를 쓸 수 없는 까닭 — 없으면 `null` (FR-2003·2007). 기한 → 받을 수 있는 계정 → 비밀번호 표시 순서로 본다. 까닭은 감사에만 남고 응답은 하나다
 */
export function resetLinkProblem(
  link: { expiresAt: Date; passwordMark: string },
  user: { passwordHash: string | null; role: Role; status: UserStatus; oidcSub: string | null },
  now: Date,
): ResetLinkProblem | null {
  if (now.getTime() >= link.expiresAt.getTime()) return 'expired';
  if (user.passwordHash === null || !canResetPasswordByMail({ role: user.role, status: user.status, local: user.oidcSub === null })) return 'ineligible';
  if (passwordMark(user.passwordHash) !== link.passwordMark) return 'changed';
  return null;
}

/**
 * 메일 재설정을 **쓸 수 있는가** (FR-2008, A.1-9) — 메일이 켜져 있고(`WF_MAIL_ENABLED`) 모의가 아니고(`WF_MAIL_MOCK` — 보내는 척만 하면 링크가
 * 아무에게도 가지 않는다, 병합 전 보안 검토 2), 공개 주소가 있고(`WF_PUBLIC_URL`), 운영 설정이 켬(`passwordResetMail`). 하나라도 아니면 화면이 단추를
 * 보이지 않고 요청·링크 쓰기가 404다
 */
export function resetMailAvailable(c: { mailEnabled: boolean; mailMock: boolean; publicUrl: string; policy: number }): boolean {
  return c.mailEnabled && !c.mailMock && c.publicUrl.trim() !== '' && c.policy === 1;
}
