import { POLICY_DEFAULTS, POLICY_FLOOR, SETTINGS_KEYS, applyPolicy } from '@workfluence/shared';
import { Client } from 'pg';
import { databaseUrl, loadEnv } from '../apps/api/src/config/config.module';

/**
 * 감사로그 보존 정리 (P4_설계서_Admin FR-540, `scope-definition` 위험 7).
 *
 * `audit_events`는 append-only다. 그런데 **보존 기간이 지난 것은 지워야 한다** — 그 둘을
 * 같이 지키는 방법이 "아무도 못 지운다"가 아니라 **"정해진 방법으로만 지운다"**이다.
 * 트리거는 그대로 두고, 이 트랜잭션만 두 가지를 명시해 예외를 연다 (`0005_audit_retention`).
 *
 *   wf.audit_purge = on                 ← 실수로는 못 지운다
 *   wf.audit_purge_before = <시각>      ← 그보다 최근 기록은 이 방법으로도 못 지운다
 *
 * **지운 사실 자체를 감사로그에 남긴다.** 지웠다는 기록까지 없으면 그 구간이 통째로
 * 설명되지 않는다.
 */
async function main(): Promise<void> {
  const env = loadEnv();
  const c = new Client(databaseUrl(env));
  await c.connect();
  try {
    const stored = await c.query<{ value: unknown }>('SELECT value FROM settings WHERE key = $1', [SETTINGS_KEYS.policy]);
    const policy = applyPolicy({
      auditRetentionDays: env.WF_AUDIT_RETENTION_DAYS,
      ...((stored.rows[0]?.value as Record<string, unknown>) ?? {}),
    });
    // **스크립트 단독으로도 바닥 아래로 못 간다.** DB 값이 어떤 경로로 낮아졌든
    // 여기서 다시 막는다 — 정리 명령은 흔적을 지우는 도구이므로 이중으로 건다
    const days = Math.max(policy.auditRetentionDays ?? POLICY_DEFAULTS.auditRetentionDays, POLICY_FLOOR.auditRetentionDays);

    await c.query('BEGIN');
    const { rows: cut } = await c.query<{ before: string }>(`SELECT (now() - interval '${days} days')::text AS before`);
    const before = cut[0].before;
    console.log(`[audit-purge] 보존 기간 ${days}일. ${before} 이전 기록을 지운다`);

    // 트랜잭션 안에서만 사는 설정이다 (`set_config(..., true)`). 커밋되면 사라진다
    await c.query(`SELECT set_config('wf.audit_purge', 'on', true), set_config('wf.audit_purge_before', $1, true)`, [before]);
    const del = await c.query('DELETE FROM audit_events WHERE created_at < $1', [before]);
    const n = del.rowCount ?? 0;

    // **지웠다는 것도 기록이다.** 이 INSERT는 예외 설정과 무관하게 언제나 허용된다
    await c.query(`INSERT INTO audit_events (action, target_type, detail) VALUES ('audit.purge', 'system', $1)`, [
      JSON.stringify({ retentionDays: days, before, deleted: n }),
    ]);
    await c.query('COMMIT');
    console.log(`[audit-purge] 완료: ${n}건 삭제`);
  } catch (e) {
    await c.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    await c.end();
  }
}

void main().catch((e: unknown) => {
  console.error(e);
  process.exitCode = 1;
});
