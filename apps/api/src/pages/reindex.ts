import { extractText, type DocNode } from '@workfluence/shared';

/**
 * 검색 인덱스 재생성의 **유일한 정의** (FR-408·FR-333, P3_설계서_Content 2절).
 *
 * `pages.search_text`는 파생 데이터다 (CLAUDE.md 6절). 본문 JSON이 정본이고 여기서 언제든
 * 다시 만들 수 있어야 한다.
 *
 * **왜 질의를 문자열로 빼 두는가.** 예전에는 같은 일이 두 곳에 있었다 — `PagesService`는
 * drizzle로, `pnpm search:reindex`는 `pg` 클라이언트로 각자 썼다. 두 질의의 **범위가
 * 어긋나면**(한쪽은 지운 페이지를 넣고 다른 쪽은 빼면) 어느 쪽으로 돌렸느냐에 따라 검색
 * 결과가 달라지고, **그 차이를 아무도 보지 못한다.** 실행 방법은 둘이어도 좋지만
 * "무엇을 골라 무엇을 쓰는가"는 한 곳이어야 한다 (CLAUDE.md 1.3절).
 */

/** 재색인 대상 — **지워진 페이지는 뺀다.** 각 페이지의 현재 버전 본문만 본다 */
export const REINDEX_SELECT_SQL = `SELECT p.id, v.content_json
   FROM pages p
   JOIN page_versions v ON v.page_id = p.id AND v.version_no = p.current_version_no
  WHERE p.deleted_at IS NULL`;

/** `$1` = 페이지 id, `$2` = 추출한 텍스트 */
export const REINDEX_UPDATE_SQL = `UPDATE pages SET search_text = $2 WHERE id = $1`;

export type ReindexRow = { id: string; content_json: DocNode };

/**
 * 고른 행을 훑어 `search_text`를 다시 쓴다. 텍스트 추출은 `packages/shared`의 `extractText`
 * 한 곳을 쓴다 — 저장 경로와 재색인이 서로 다른 규칙을 쓰면 재색인 뒤에 검색이 조용히 달라진다.
 *
 * `write`만 받는다. 드리즐이냐 `pg` 클라이언트냐는 여기서 알 필요가 없다 (CLAUDE.md 2절 ISP).
 */
export async function reindexRows(rows: ReindexRow[], write: (id: string, text: string) => Promise<unknown>): Promise<number> {
  let n = 0;
  for (const r of rows) {
    await write(r.id, extractText(r.content_json));
    n += 1;
  }
  return n;
}
