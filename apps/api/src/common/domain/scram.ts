import { createHash, createHmac, pbkdf2Sync } from 'node:crypto';

/**
 * PostgreSQL이 저장하는 **SCRAM-SHA-256 확인값** (A등급, 병합 전 검토 — `apps/api/src/db/app-role.ts`가 쓴다).
 *
 * `ALTER ROLE … PASSWORD '<평문>'`은 그 문장이 실패하거나 `log_statement`가 켜져 있으면 postgres 로그에 평문이 남는다(`CLAUDE.md` 7절).
 * 이 값(`SCRAM-SHA-256$<반복>:<솔트>$<StoredKey>:<ServerKey>`)을 보내면 PostgreSQL은 그대로 저장하고, 평문은 앱 밖으로 가지 않는다.
 * 계산은 RFC 5802·7677: SaltedPassword = PBKDF2-HMAC-SHA-256(비밀번호, 솔트, 반복), ClientKey = HMAC(SaltedPassword, "Client Key"),
 * StoredKey = SHA-256(ClientKey), ServerKey = HMAC(SaltedPassword, "Server Key").
 *
 * **인쇄 가능한 ASCII만 받는다.** PostgreSQL은 비밀번호를 SASLprep으로 고른 뒤 계산한다 — ASCII는 그대로 두지만 그 밖은 여기서 같게
 * 만들 수 없다. 앱 계정 비밀번호는 설정 검사가 URL에 안전한 글자로 좁혀 둔다(`WF_DB_APP_PASSWORD`). 반복은 PostgreSQL의 기본값(4096)이다
 */
export const SCRAM_ITERATIONS = 4096;
const MIN_SALT_BYTES = 16;

export function scramSha256Verifier(password: string, salt: Buffer, iterations: number = SCRAM_ITERATIONS): string {
  if (!/^[\x21-\x7e]+$/.test(password)) throw new Error('SCRAM 확인값은 인쇄 가능한 ASCII 비밀번호로만 만든다');
  if (salt.length < MIN_SALT_BYTES) throw new Error(`솔트는 ${MIN_SALT_BYTES}바이트 이상이어야 한다`);
  const salted = pbkdf2Sync(Buffer.from(password, 'utf8'), salt, iterations, 32, 'sha256');
  const clientKey = createHmac('sha256', salted).update('Client Key').digest();
  const storedKey = createHash('sha256').update(clientKey).digest();
  const serverKey = createHmac('sha256', salted).update('Server Key').digest();
  return `SCRAM-SHA-256$${iterations}:${salt.toString('base64')}$${storedKey.toString('base64')}:${serverKey.toString('base64')}`;
}
