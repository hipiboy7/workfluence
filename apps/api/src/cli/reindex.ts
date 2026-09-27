import type { AppEnv } from '@workfluence/shared';
import { Client } from 'pg';
import { databaseUrl, loadEnv } from '../config/config.module';
import { describeDatabaseUrl } from '../common/db-url';
import { REINDEX_SELECT_SQL, REINDEX_UPDATE_SQL, reindexRows, type ReindexRow } from '../pages/reindex';

/**
 * 검색 인덱스 재생성 (P3_설계서_Content 2절, FR-408).
 *
 * **무엇을 골라 무엇을 쓰는지는 `apps/api/src/pages/reindex.ts`에만 있다.** 이 파일은
 * "어떻게 실행하는가"만 안다 — 앱을 띄우지 않고 DB에 직접 붙는다. 질의를 여기에 한 번 더
 * 적으면 앱 쪽과 범위가 어긋나고, 어긋난 것을 아무도 보지 못한다 (CLAUDE.md 1.3절).
 */
export async function searchReindex(env: AppEnv = loadEnv(), url: string = databaseUrl(env)): Promise<void> {
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

/**
 * **컨테이너에서 도는 입구** (P13 D.2, FR-1410). 운영 서버에는 Node도 저장소도 없어, 앱 이미지 안의 이 파일을 compose의 `tools`로 부른다 —
 * `docker compose … run --rm tools node dist/cli/reindex.js`. 개발 명령(`pnpm search:reindex`)은 `scripts/reindex.ts`를 거쳐 같은 함수를 부른다(FR-1411)
 */
if (require.main === module) {
  void searchReindex().catch((e: unknown) => {
    console.error(e);
    process.exitCode = 1;
  });
}
