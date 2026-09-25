import { sql, type AnyColumn, type SQL } from 'drizzle-orm';

/**
 * 이름으로 정렬한다 — **`COLLATE "C"`(유니코드 코드 순서)**. 한글 음절은 유니코드에서 가나다 순이다 (CLAUDE.md 6절).
 *
 * **DB의 기본 정렬에 맡기지 않는다.** 운영 DB(postgres:17 이미지)의 기본 정렬은 `en_US.utf8`(glibc)이고, 그 정렬은 한글을
 * 가나다 순으로 두지 않는다 — `나중 | 가나 | 다음 | 가장 먼저`. 개발·시험의 임베디드 DB는 `C`라 차이가 보이지 않았고, CI(postgres:17)가
 * 잡았다 (T-046). ICU 정렬(`ko-x-icu`)은 PostgreSQL 빌드에 따라 없을 수 있어 쓰지 않는다 — 없으면 질의가 통째로 실패한다.
 * `C`에서는 영문 대문자가 소문자보다, 영문이 한글보다 앞선다.
 */
export function byName(column: AnyColumn): SQL {
  return sql`${column} COLLATE "C"`;
}
