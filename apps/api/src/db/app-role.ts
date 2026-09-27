import { escapeIdentifier, escapeLiteral, type Pool } from 'pg';

/**
 * **앱 DB 계정과 권한** (P13_설계서_Readiness D.3, FR-1420·1421, 보류 12). B등급 — 실제 PostgreSQL로 시험한다.
 *
 * 운영 DB 계정을 둘로 나눈다 — 소유 계정(표를 만들고 고치는 일: 마이그레이션·시드·월간 작업·백업)과 앱 계정(기동 중인 앱). 예전에는 앱이
 * postgres 이미지의 슈퍼유저로 붙어, 감사로그의 불변이 트리거 한 겹이었다(`CLAUDE.md` 6절 "앱 DB 계정에 INSERT만"을 지키지 못했다).
 *
 * **마이그레이션 단계가 부른다**(소유 계정으로) — 초기화 스크립트는 빈 볼륨에서 한 번만 돌아 이미 설치된 곳에 붙일 길이 없다. 멱등이다:
 * 계정이 있으면 비밀번호만 맞춘다. 표는 마이그레이션마다 늘 수 있으므로 매번 모든 표에 다시 준다.
 *
 * 앱 계정이 할 수 있는 것: 스키마 `public`의 모든 표에 DML, 모든 시퀀스 사용. **할 수 없는 것**: DDL(스키마의 CREATE), `audit_events`의
 * UPDATE·DELETE·TRUNCATE, 역할·DB 만들기, 슈퍼유저. 세션 표는 마이그레이션이 만든다 — 앱은 기동 중에 DDL을 쓰지 않는다
 * (`createTableIfMissing: false`).
 */
export async function applyAppRole(pool: Pool, role: string, password: string): Promise<string> {
  const who = escapeIdentifier(role);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const exists = await client.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [role]);
    if (exists.rowCount === 0) await client.query(`CREATE ROLE ${who} LOGIN`);
    // 속성은 매번 다시 좁힌다 — 누가 손으로 넓혀 둔 계정도 돌아온다
    await client.query(`ALTER ROLE ${who} WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD ${escapeLiteral(password)}`);
    const { rows } = await client.query<{ db: string }>('SELECT current_database() AS db');
    await client.query(`GRANT CONNECT ON DATABASE ${escapeIdentifier(rows[0].db)} TO ${who}`);
    // DDL을 막는다. PostgreSQL 15부터 PUBLIC에는 CREATE가 없지만, 그 전에 만든 DB라면 PUBLIC을 거쳐 얻는다 — 둘 다 거둔다
    await client.query('REVOKE CREATE ON SCHEMA public FROM PUBLIC');
    await client.query(`REVOKE CREATE ON SCHEMA public FROM ${who}`);
    await client.query(`GRANT USAGE ON SCHEMA public TO ${who}`);
    await client.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${who}`);
    await client.query(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${who}`);
    // **감사로그는 쌓기만** (CLAUDE.md 6절). 정리(`audit-purge`)는 소유 계정의 월간 작업이다
    await client.query(`REVOKE UPDATE, DELETE, TRUNCATE ON audit_events FROM ${who}`);
    await client.query('COMMIT');
    return `앱 계정 ${role}: 권한 적용`;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    client.release();
  }
}
