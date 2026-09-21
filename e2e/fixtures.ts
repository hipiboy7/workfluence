import * as argon2 from 'argon2';
import { Client } from 'pg';

/**
 * E2E는 **자기가 필요한 상태를 직접 만든다** (P0_설계서 13절 인계, CLAUDE.md 3절).
 * 시드 계정의 비밀번호나 상태를 전제하지 않는다 — 사람이 화면에서 바꾸는 순간 테스트가 깨진다.
 */
export const ADMIN = { username: `e2e-admin-${Date.now()}`, password: 'E2e-Admin-2026!' };

function url(): string {
  const raw = process.env.WF_DATABASE_URL;
  if (!raw) throw new Error('WF_DATABASE_URL이 없다 — E2E는 앱이 쓰는 것과 같은 DB에 계정을 만든다');
  return raw;
}

/** 이번 실행에서만 쓸 관리자 계정을 만든다 */
export async function createAdmin(): Promise<void> {
  const c = new Client(url());
  await c.connect();
  try {
    await c.query(
      `INSERT INTO users (username, display_name, password_hash, role, status, must_change_password, approved_at)
       VALUES ($1, 'E2E 관리자', $2, 'admin', 'active', false, now())`,
      [ADMIN.username, await argon2.hash(ADMIN.password, { type: argon2.argon2id })],
    );
  } finally {
    await c.end();
  }
}

/** 이번 실행이 만든 계정만 지운다. 감사로그는 append-only라 남는다 (그래야 맞다) */
export async function cleanup(usernames: string[]): Promise<void> {
  const c = new Client(url());
  await c.connect();
  try {
    await c.query('DELETE FROM users WHERE username = ANY($1)', [usernames]);
  } finally {
    await c.end();
  }
}
