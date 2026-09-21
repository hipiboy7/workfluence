import * as argon2 from 'argon2';
import { Client } from 'pg';

/**
 * E2E는 **자기가 필요한 상태를 직접 만든다** (P0_설계서 13절 인계, CLAUDE.md 3절).
 * 시드 계정의 비밀번호나 상태를 전제하지 않는다 — 사람이 화면에서 바꾸는 순간 테스트가 깨진다.
 */
/**
 * 이번 실행에서만 쓸 관리자.
 *
 * **스펙 파일마다 달라야 한다.** 모듈 상수 하나를 두 파일이 공유하면 두 번째 `createAdmin()`이
 * username 중복으로 죽는다 (파일 단독 실행에서는 안 드러난다).
 */
export function newAdmin(tag: string) {
  return { username: `e2e-admin-${tag}-${Date.now()}`, password: 'E2e-Admin-2026!' };
}

function url(): string {
  const raw = process.env.WF_DATABASE_URL;
  if (!raw) throw new Error('WF_DATABASE_URL이 없다 — E2E는 앱이 쓰는 것과 같은 DB에 계정을 만든다');
  return raw;
}

/** 주어진 관리자 계정을 만든다 */
export async function createAdmin(admin: { username: string; password: string }): Promise<void> {
  const c = new Client(url());
  await c.connect();
  try {
    await c.query(
      `INSERT INTO users (username, display_name, password_hash, role, status, must_change_password, approved_at)
       VALUES ($1, 'E2E 관리자', $2, 'admin', 'active', false, now())`,
      [admin.username, await argon2.hash(admin.password, { type: argon2.argon2id })],
    );
  } finally {
    await c.end();
  }
}

/**
 * 활성 상태의 일반 사용자를 만든다.
 *
 * **가입 화면을 거치지 않는다.** 가입은 IP별 rate limit이 걸려 있어(7절, 10분에 5회)
 * 스펙이 늘어날수록 뒤에 도는 테스트가 먼저 막힌다. 가입 흐름 자체를 보는 것은
 * `auth.spec.ts`의 일이고, 다른 스펙은 "이미 있는 사용자"만 필요하다.
 */
export async function createMember(m: { username: string; password: string; displayName?: string }): Promise<void> {
  const c = new Client(url());
  await c.connect();
  try {
    await c.query(
      `INSERT INTO users (username, display_name, password_hash, role, status, must_change_password, approved_at)
       VALUES ($1, $3, $2, 'member', 'active', false, now())`,
      [m.username, await argon2.hash(m.password, { type: argon2.argon2id }), m.displayName ?? m.username],
    );
  } finally {
    await c.end();
  }
}

/**
 * 이번 실행이 만든 계정과 그 계정이 만든 것을 지운다. 감사로그는 append-only라 남는다 (그래야 맞다).
 *
 * **사용자만 지울 수는 없다.** Phase 2에서 승인 시 개인 스페이스가 자동으로 생기고(FR-309)
 * `spaces.created_by`가 `users`를 참조한다. 자식부터 거꾸로 지운다.
 */
export async function cleanup(usernames: string[]): Promise<void> {
  if (!usernames.length) return;
  const c = new Client(url());
  await c.connect();
  try {
    const ids = (await c.query('SELECT id FROM users WHERE username = ANY($1)', [usernames])).rows.map((r: { id: string }) => r.id);
    if (!ids.length) return;
    // Phase 3에서 첨부·댓글이 pages를 참조한다. 자식부터 거꾸로 지우는 순서를 지킨다
    const pagesOfMine = 'SELECT id FROM pages WHERE created_by = ANY($1) OR space_id IN (SELECT id FROM spaces WHERE created_by = ANY($1))';
    await c.query(`DELETE FROM comments WHERE created_by = ANY($1) OR page_id IN (${pagesOfMine})`, [ids]);
    await c.query(`DELETE FROM attachments WHERE uploaded_by = ANY($1) OR page_id IN (${pagesOfMine})`, [ids]);
    await c.query('DELETE FROM page_versions WHERE created_by = ANY($1) OR page_id IN (SELECT id FROM pages WHERE space_id IN (SELECT id FROM spaces WHERE created_by = ANY($1)))', [ids]);
    await c.query('DELETE FROM pages WHERE created_by = ANY($1) OR space_id IN (SELECT id FROM spaces WHERE created_by = ANY($1))', [ids]);
    await c.query('DELETE FROM space_members WHERE user_id = ANY($1) OR space_id IN (SELECT id FROM spaces WHERE created_by = ANY($1))', [ids]);
    await c.query('DELETE FROM spaces WHERE created_by = ANY($1)', [ids]);
    await c.query('UPDATE users SET approved_by = NULL WHERE approved_by = ANY($1)', [ids]);
    await c.query('DELETE FROM users WHERE id = ANY($1)', [ids]);
  } finally {
    await c.end();
  }
}
