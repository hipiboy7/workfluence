import { SETTINGS_KEYS, applyPolicy } from '@workfluence/shared';
import { Client } from 'pg';
import { rm } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { databaseUrl, loadEnv } from '../apps/api/src/config/config.module';
import { blobPath } from '../apps/api/src/attachments/domain/blob-path';

/**
 * 휴지통 물리 삭제 (P4_설계서_Admin FR-515~517, `scope-definition` 위험 7).
 *
 * **자동으로 돌지 않는다.** 사람이 부르는 명령이다 (쟁점 6) — 자동 실행 주기는 운영 환경을
 * 알아야 정할 수 있어 Phase 5 배포가이드로 넘긴다.
 *
 * **지우는 것은 두 갈래다.**
 *   ① 보존 기간을 넘겨 **직접 지워진** 페이지·첨부·댓글·스페이스
 *   ② 보존 기간을 넘긴 스페이스에 **딸린 페이지 전부** — 지워지지 않은 것까지 포함한다
 *
 * ②를 빼면 스페이스 행을 지울 수 없어서(FK) 스페이스가 영영 남는다. 그래서 필요한
 * 동작이지만, **"휴지통만 건드린다"고 오해하면 살아 있던 문서를 잃는다** — 스페이스를
 * 되살리면 안에 있던 문서도 함께 돌아오기 때문이다 (코드 리뷰 5·8). 출력에서 둘을 나눠 센다.
 *
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
    const days = policy.trashRetentionDays;
    const cutoff = `now() - interval '${days} days'`;
    console.log(`[purge] 보존 기간 ${days}일. 그보다 오래된 휴지통 항목을 지운다`);

    await c.query('BEGIN');

    // 지울 페이지: 직접 지워진 것 + 지워진 스페이스에 속한 것
    const direct = (
      await c.query<{ id: string }>(`SELECT id FROM pages WHERE deleted_at IS NOT NULL AND deleted_at < ${cutoff}`)
    ).rows.map((r) => r.id);
    // 보존 기간을 넘긴 스페이스에 딸린 것 — **지워지지 않은 페이지까지** 포함된다
    const viaSpace = (
      await c.query<{ id: string }>(
        `SELECT id FROM pages WHERE deleted_at IS NULL
           AND space_id IN (SELECT id FROM spaces WHERE deleted_at IS NOT NULL AND deleted_at < ${cutoff})`,
      )
    ).rows.map((r) => r.id);
    const pageIds = [...new Set([...direct, ...viaSpace])];
    if (viaSpace.length) {
      console.log(`[purge] 주의: 지워진 스페이스에 딸린 **살아 있던** 페이지 ${viaSpace.length}건도 함께 지운다`);
    }

    // **따로 지운 첨부·댓글도 대상이다** (쟁점 5 "페이지·첨부·댓글·스페이스 전부").
    // 페이지는 살아 있는데 사용자가 첨부만 지운 경우, 페이지 기준으로만 모으면 영영 남는다
    const oldAttachments = (
      await c.query<{ id: string }>(`SELECT id FROM attachments WHERE deleted_at IS NOT NULL AND deleted_at < ${cutoff}`)
    ).rows.map((r) => r.id);
    const oldComments = (
      await c.query<{ id: string }>(`SELECT id FROM comments WHERE deleted_at IS NOT NULL AND deleted_at < ${cutoff}`)
    ).rows.map((r) => r.id);

    // 지울 첨부의 해시를 **미리** 모은다. 행을 지운 뒤에는 무엇을 참조했는지 알 수 없다
    const shaRows = await c.query<{ sha256: string }>(
      `SELECT DISTINCT sha256 FROM attachments WHERE page_id = ANY($1) OR id = ANY($2)`,
      [pageIds, oldAttachments],
    );
    const shas = shaRows.rows.map((r) => r.sha256);

    const counts: Record<string, number> = {};
    const del = async (label: string, sql: string, params: unknown[] = []) => {
      counts[label] = (await c.query(sql, params)).rowCount ?? 0;
    };

    // 페이지보다 먼저, 그리고 페이지와 무관하게 따로 지워진 것도 함께
    if (oldComments.length) {
      await del('notifications(댓글)', 'DELETE FROM notifications WHERE comment_id = ANY($1)', [oldComments]);
      await del('comments(개별)', 'DELETE FROM comments WHERE id = ANY($1)', [oldComments]);
    }
    if (oldAttachments.length) await del('attachments(개별)', 'DELETE FROM attachments WHERE id = ANY($1)', [oldAttachments]);

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
    // **아무 페이지도 안 쓰는 라벨은 남기지 않는다.** 서비스(`labels.service.ts`)가 뗄 때
    // 하는 것과 같은 판단이다 — 자동완성 목록이 쓰레기로 찬다 (자체 점검 17)
    await del('labels(고아)', 'DELETE FROM labels WHERE NOT EXISTS (SELECT 1 FROM page_labels pl WHERE pl.label_id = labels.id)');

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
      // 자리 계산은 앱과 **같은 함수**를 쓴다. 따로 적으면 한쪽만 바뀌어도 아무도 못 본다
      await rm(blobPath(root, sha), { force: true });
      files += 1;
    }

    console.log(
      `[purge] 완료: 직접 지운 페이지 ${direct.length}건 · 스페이스에 딸린 페이지 ${viaSpace.length}건 · ` +
        `${Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(' · ')} · 파일 ${files}`,
    );
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
