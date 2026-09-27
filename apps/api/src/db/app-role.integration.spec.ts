import { escapeIdentifier, Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrl, loadEnv } from '../config/config.module';
import { closeTestDb, openTestDb } from '../test/db';
import { applyAppRole } from './app-role';

/**
 * B등급 — **앱 DB 계정** (P13 D.3, FR-1420·1421·1424, 보류 12). 실제 PostgreSQL. 시험용 계정을 만들어 **그 계정으로 붙어** 본다 —
 * 권한 목록만 읽으면 "주었다"를 볼 뿐 "막혔다"를 보지 못한다. 보류 12의 판정 방법(`information_schema.role_table_grants`)도 함께 본다.
 * 계정은 클러스터 전체의 것이라 끝나면 지운다(앞선 실행이 남긴 것도 처음에 지운다)
 */

const ROLE = 'wf_app_test';
const PASSWORD = 'app-role-test-password';
let owner: Pool;
let app: Pool;

const urlAs = (user: string, password: string): string => {
  const url = new URL(databaseUrl({ ...loadEnv(), WF_ENV: 'test' }));
  url.username = user;
  url.password = password;
  return url.toString();
};

async function dropRole(): Promise<void> {
  const exists = await owner.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [ROLE]);
  if (exists.rowCount === 0) return;
  await owner.query(`DROP OWNED BY ${escapeIdentifier(ROLE)}`);
  await owner.query(`DROP ROLE ${escapeIdentifier(ROLE)}`);
}

beforeAll(async () => {
  ({ pool: owner } = await openTestDb());
  await dropRole();
  await applyAppRole(owner, ROLE, PASSWORD);
  app = new Pool({ connectionString: urlAs(ROLE, PASSWORD), max: 1 });
});
afterAll(async () => {
  await app?.end();
  await dropRole();
  await closeTestDb();
});

describe('앱 계정이 할 수 있는 것', () => {
  it('표를 읽고 쓴다 — 감사로그에는 쌓는다', async () => {
    await expect(app.query('SELECT count(*) FROM users')).resolves.toBeTruthy();
    await expect(app.query(`INSERT INTO audit_events (action, target_type, target_id) VALUES ('auth.logout', 'test', 'app-role')`)).resolves.toBeTruthy();
    await expect(app.query(`SELECT count(*) FROM audit_events WHERE target_id = 'app-role'`)).resolves.toBeTruthy();
  });
});

describe('앱 계정이 할 수 없는 것 (FR-1420)', () => {
  it('**감사로그를 고치거나 지우거나 비울 수 없다** — 트리거보다 앞에서 권한이 막는다', async () => {
    await expect(app.query(`UPDATE audit_events SET action = action WHERE target_id = 'app-role'`)).rejects.toThrow(/permission denied/);
    await expect(app.query(`DELETE FROM audit_events WHERE target_id = 'app-role'`)).rejects.toThrow(/permission denied/);
    await expect(app.query('TRUNCATE audit_events')).rejects.toThrow(/permission denied/);
  });

  it('**DDL을 못 한다** — 표를 만들지도 지우지도 못한다', async () => {
    await expect(app.query('CREATE TABLE wf_app_should_not_exist (a int)')).rejects.toThrow(/permission denied/);
    await expect(app.query('DROP TABLE users')).rejects.toThrow(/must be owner|permission denied/);
  });

  it('슈퍼유저·DB 만들기·역할 만들기가 없다', async () => {
    const { rows } = await owner.query<{ rolsuper: boolean; rolcreatedb: boolean; rolcreaterole: boolean; rolbypassrls: boolean }>(
      'SELECT rolsuper, rolcreatedb, rolcreaterole, rolbypassrls FROM pg_roles WHERE rolname = $1',
      [ROLE],
    );
    expect(rows[0]).toEqual({ rolsuper: false, rolcreatedb: false, rolcreaterole: false, rolbypassrls: false });
  });

  it('**보류 12의 판정 방법** — `role_table_grants`에서 감사로그는 SELECT·INSERT뿐이다', async () => {
    const { rows } = await owner.query<{ p: string }>(
      `SELECT privilege_type AS p FROM information_schema.role_table_grants WHERE grantee = $1 AND table_name = 'audit_events' ORDER BY 1`,
      [ROLE],
    );
    expect(rows.map((r) => r.p)).toEqual(['INSERT', 'SELECT']);
  });
});

describe('멱등 (FR-1421)', () => {
  it('두 번 불러도 되고, 비밀번호가 바뀐다 — 옛 비밀번호로는 못 붙는다', async () => {
    await applyAppRole(owner, ROLE, 'rotated-password');
    const fresh = new Pool({ connectionString: urlAs(ROLE, 'rotated-password'), max: 1 });
    const stale = new Pool({ connectionString: urlAs(ROLE, PASSWORD), max: 1 });
    try {
      await expect(fresh.query('SELECT 1')).resolves.toBeTruthy();
      await expect(stale.query('SELECT 1')).rejects.toThrow(/password authentication failed/);
    } finally {
      await fresh.end();
      await stale.end();
      await applyAppRole(owner, ROLE, PASSWORD);
    }
  });

  it('누가 손으로 넓혀 둔 속성도 다시 좁힌다', async () => {
    await owner.query(`ALTER ROLE ${escapeIdentifier(ROLE)} CREATEDB`);
    await applyAppRole(owner, ROLE, PASSWORD);
    const { rows } = await owner.query<{ c: boolean }>('SELECT rolcreatedb AS c FROM pg_roles WHERE rolname = $1', [ROLE]);
    expect(rows[0].c).toBe(false);
  });
});
