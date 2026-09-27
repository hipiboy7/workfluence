/**
 * **부분 일치 패턴** — 사용자가 적은 글자를 그대로 찾는다. `%`와 `_`는 ILIKE의 와일드카드라, 그대로 두면 `q=%` 한 글자가 **볼 수 있는
 * 전부**를 돌려준다(P3 자체 점검 #12). 역슬래시로 풀어 둔다 — PostgreSQL의 기본 이스케이프 문자다. 검색과 사용자 찾기가 같이 쓴다
 */
export function containsPattern(q: string): string {
  return `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}
