import { extractText, type DocNode } from '@workfluence/shared';
import { Client } from 'pg';
import { databaseUrl, loadEnv } from '../apps/api/src/config/config.module';

/**
 * 검색 인덱스 재생성 (P3_설계서_Content 2절, FR-408).
 *
 * `pages.search_text`는 **파생 데이터**다 (CLAUDE.md 6절). 본문 JSON이 정본이고, 여기서
 * 언제든 다시 만들 수 있어야 한다. 추출 규칙이 바뀌거나 인덱스가 어긋났을 때 이것을 돌린다.
 *
 * 추출은 `packages/shared`의 `extractText` **한 곳**을 쓴다 — 저장 경로와 재색인이 서로 다른
 * 규칙을 쓰면, 재색인한 뒤에 검색 결과가 조용히 달라진다.
 */
async function main(): Promise<void> {
  const env = loadEnv();
  const c = new Client(databaseUrl(env));
  await c.connect();
  try {
    const { rows } = await c.query<{ id: string; content_json: DocNode }>(
      // 지워진 페이지는 건너뛴다 — `PagesService.reindexAll`(FR-333)과 **같은 범위**여야 한다.
      // 둘이 다르면 어느 쪽으로 돌렸느냐에 따라 결과가 달라지고, 그 차이를 아무도 못 본다
      `SELECT p.id, v.content_json
         FROM pages p
         JOIN page_versions v ON v.page_id = p.id AND v.version_no = p.current_version_no
        WHERE p.deleted_at IS NULL`,
    );
    let n = 0;
    for (const r of rows) {
      await c.query('UPDATE pages SET search_text = $2 WHERE id = $1', [r.id, extractText(r.content_json)]);
      n += 1;
    }
    console.log(`재색인 완료: ${n}개 페이지`);
  } finally {
    await c.end();
  }
}

void main().catch((e: unknown) => {
  console.error(e);
  process.exitCode = 1;
});
