import { POLICY_DEFAULTS, SETTINGS_KEYS, applyPolicy } from '@workfluence/shared';
import { Client } from 'pg';
import { rm } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { databaseUrl, loadEnv } from '../apps/api/src/config/config.module';

/**
 * 휴지통 물리 삭제 (P4_설계서_Admin FR-515~517, `scope-definition` 위험 7).
 *
 * **자동으로 돌지 않는다.** 사람이 부르는 명령이다 (쟁점 6) — 자동 실행 주기는 운영 환경을
 * 알아야 정할 수 있어 Phase 5 배포가이드로 넘긴다.
 *
 * 지우는 것은 **보존 기간을 넘긴 것뿐**이다. `deleted_at`이 비어 있는 행은 건드리지 않는다.
 * 순서는 자식부터다 — 알림·라벨 연결·댓글·첨부·버전·페이지·스페이스.
 */
async function main(): Promise<void> {
  const env = loadEnv();
  const c = new Client(databaseUrl(env));
  await c.connect();
  try {
    // 정책값은 DB가 이긴다 (FR-527). 없으면 환경변수, 그것도 없으면 코드 기본값
    const stored = await c.query<{ value: unknown }>('SELECT value FROM settings WHERE key = $1', [SETTINGS_KEYS.policy]);
    const policy = applyPolicy({
      trashRetentionDays: env.WF_TRASH_RETENTION_DAYS,
      ...((stored.rows[0]?.value as Record<string, unknown>) ?? {}),
    });
    const days = policy.trashRetentionDays ?? POLICY_DEFAULTS.trashRetentionDays;
    const cutoff = `now() - interval '${days} days'`;
    console.log(`[purge] 보존 기간 ${days}일. 그보다 오래된 휴지통 항목을 지운다`);

    await c.query('BEGIN');

    // 지울 페이지: 직접 지워진 것 + 지워진 스페이스에 속한 것
    const pageIds = (
      await c.query<{ id: string }>(
        `SELECT id FROM pages
          WHERE deleted_at IS NOT NULL AND deleted_at < ${cutoff}
             OR space_id IN (SELECT id FROM spaces WHERE deleted_at IS NOT NULL AND deleted_at < ${cutoff})`,
      )
    ).rows.map((r) => r.id);

    // 지울 첨부의 해시를 **미리** 모은다. 행을 지운 뒤에는 무엇을 참조했는지 알 수 없다
    const shas = pageIds.length
      ? (await c.query<{ sha256: string }>('SELECT DISTINCT sha256 FROM attachments WHERE page_id = ANY($1)', [pageIds])).rows.map((r) => r.sha256)
      : [];

    const counts: Record<string, number> = {};
    const del = async (label: string, sql: string, params: unknown[] = []) => {
      counts[label] = (await c.query(sql, params)).rowCount ?? 0;
    };

    if (pageIds.length) {
      await del('notifications', 'DELETE FROM notifications WHERE page_id = ANY($1)', [pageIds]);
      await del('page_labels', 'DELETE FROM page_labels WHERE page_id = ANY($1)', [pageIds]);
      await del('comments', 'DELETE FROM comments WHERE page_id = ANY($1)', [pageIds]);
      await del('attachments', 'DELETE FROM attachments WHERE page_id = ANY($1)', [pageIds]);
      await del('page_versions', 'DELETE FROM page_versions WHERE page_id = ANY($1)', [pageIds]);
      // 자식이 먼저 지워지도록 부모 참조를 끊는다
      await c.query('UPDATE pages SET parent_id = NULL WHERE id = ANY($1)', [pageIds]);
      await del('pages', 'DELETE FROM pages WHERE id = ANY($1)', [pageIds]);
    }
    await del('space_members', `DELETE FROM space_members WHERE space_id IN (SELECT id FROM spaces WHERE deleted_at IS NOT NULL AND deleted_at < ${cutoff})`);
    await del('spaces', `DELETE FROM spaces WHERE deleted_at IS NOT NULL AND deleted_at < ${cutoff}`);

    // 감사로그에 남긴다 (FR-516). 본 작업과 같은 트랜잭션이다
    await c.query(`INSERT INTO audit_events (action, target_type, detail) VALUES ('trash.purge', 'system', $1)`, [
      JSON.stringify({ retentionDays: days, ...counts }),
    ]);
    await c.query('COMMIT');

    // **파일 실체는 참조가 하나도 안 남을 때만 지운다** (FR-517).
    // 같은 내용을 여러 메타데이터가 가리킬 수 있어서다. DB를 커밋한 뒤에 확인한다 —
    // 반대 순서로 하면 롤백된 트랜잭션 때문에 살아 있는 첨부의 파일을 지우게 된다
    const root = isAbsolute(env.WF_STORAGE_PATH) ? env.WF_STORAGE_PATH : resolve(process.cwd(), env.WF_STORAGE_PATH);
    let files = 0;
    for (const sha of shas) {
      const still = await c.query('SELECT 1 FROM attachments WHERE sha256 = $1 LIMIT 1', [sha]);
      if (still.rowCount) continue;
      await rm(join(root, sha.slice(0, 2), sha), { force: true });
      files += 1;
    }

    console.log(`[purge] 완료: ${Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(' · ')} · 파일 ${files}`);
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
