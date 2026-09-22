import { Client } from 'pg';
import { databaseUrl, loadEnv } from '../apps/api/src/config/config.module';
import { describeDatabaseUrl } from '../apps/api/src/common/db-url';
import { REINDEX_SELECT_SQL, REINDEX_UPDATE_SQL, reindexRows, type ReindexRow } from '../apps/api/src/pages/reindex';

/**
 * 검색 인덱스 재생성 (P3_설계서_Content 2절, FR-408).
 *
 * **무엇을 골라 무엇을 쓰는지는 `apps/api/src/pages/reindex.ts`에만 있다.** 이 파일은
 * "어떻게 실행하는가"만 안다 — 앱을 띄우지 않고 DB에 직접 붙는다. 질의를 여기에 한 번 더
 * 적으면 앱 쪽과 범위가 어긋나고, 어긋난 것을 아무도 보지 못한다 (CLAUDE.md 1.3절).
 */
async function main(): Promise<void> {
  const env = loadEnv();
  const url = databaseUrl(env);
  // **어디를 만지는지 먼저 말한다.** `.env`가 가리키는 곳으로 붙으므로,
  // 컨테이너 DB를 기대하고 불렀는데 개발 DB를 만지는 일이 조용히 일어날 수 있다
  console.log(`[reindex] 대상 DB: ${describeDatabaseUrl(url)}`);
  const c = new Client(url);
  await c.connect();
  try {
    const { rows } = await c.query<ReindexRow>(REINDEX_SELECT_SQL);
    const n = await reindexRows(rows, (id, text) => c.query(REINDEX_UPDATE_SQL, [id, text]));
    console.log(`재색인 완료: ${n}개 페이지`);
  } finally {
    await c.end();
  }
}

void main().catch((e: unknown) => {
  console.error(e);
  process.exitCode = 1;
});
