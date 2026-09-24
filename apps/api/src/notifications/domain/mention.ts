import { extractText, type DocNode } from '@workfluence/shared';

/**
 * 문서에서 멘션(`@아이디`)을 뽑는다 (A등급, P4_설계서_Admin E절, FR-501).
 *
 * 순수 함수다 — DB를 보지 않는다. 여기서 나온 이름이 실제 사용자인지, 그 사람이 이
 * 스페이스를 볼 수 있는지는 부르는 쪽이 판정한다 (FR-502).
 */

/**
 * `@` 앞이 **글의 시작이거나 공백·여는 괄호·따옴표**일 때만 멘션이다.
 *
 * 이 조건이 없으면 `kim@example.internal`의 `@example`이 멘션이 되어, 메일 주소를 적을
 * 때마다 엉뚱한 사람에게 알림이 간다. 반대로 한국어는 `@kim님은`처럼 **뒤에** 조사가
 * 붙으므로 뒤쪽은 열어 둔다 — 아이디 문자가 아닌 것이 나오면 거기서 끊긴다.
 */
const MENTION = /(^|[\s([{<"'`])@([a-z0-9._-]{1,80})/gu;

/** `usernameSchema`와 같은 규칙 (소문자·숫자·._- 2~64자). 둘이 어긋나면 있지도 않은 사람을 찾게 된다 */
const USERNAME = /^[a-z0-9._-]{2,64}$/;

/** 본문에서 찾은 멘션 하나. `start`는 `@`의 위치, `end`는 이름 끝 **다음** 위치다 */
export type MentionHit = { name: string; start: number; end: number };

/**
 * 본문에서 멘션을 **위치까지** 찾는다 (P8_설계서_Mention C.3절).
 *
 * `.`·`-`·`_`는 아이디에도 쓰이고 문장부호로도 쓰인다 — `@kim.`은 "kim에게"일 수도
 * `kim.`이라는 아이디일 수도 있다. 그래서 **자르지 않은 것을 먼저** 두고, 뒤쪽 구분자를
 * 뗀 것을 다음에 둔다. 부르는 쪽이 실제 사용자와 맞춰 보고 **먼저 맞는 것**을 쓴다.
 * 예전에는 무조건 떼어서 `@kim_`이 `kim`에게 갔다 (코드 리뷰 7).
 *
 * **같은 이름이 여러 번 나오면 전부 낸다.** 곳마다 그 멘션을 만든 사람이 다를 수 있다.
 */
export function scanMentions(text: string): MentionHit[] {
  const hits: MentionHit[] = [];
  for (const m of text.matchAll(MENTION)) {
    const raw = m[2];
    // 앞 경계 글자(공백·괄호)는 멘션이 아니다. `@`는 그 바로 뒤다
    const at = (m.index ?? 0) + m[1].length;
    const trimmed = raw.replace(/[.\-_]+$/, '');
    for (const name of raw === trimmed ? [raw] : [raw, trimmed]) {
      if (!USERNAME.test(name)) continue;
      hits.push({ name, start: at, end: at + 1 + name.length });
    }
  }
  return hits;
}

/** 문서에서 **후보 이름들**을 찾은 순서대로, 겹치지 않게 (FR-501·504) */
export function extractMentions(doc: DocNode): string[] {
  return [...new Set(scanMentions(extractText(doc)).map((h) => h.name))];
}

/**
 * 받는 사람에게 **누가 불렀다고 말하나** (FR-900·902).
 *
 * `occurrences`는 그 이름이 나온 곳마다 그 멘션을 만든 사람이다(문서 순서, 모르면 `null`). 하나로 줄이지 않고
 * 받는 사람을 알고 고른다 — 줄이면 스스로 부른 곳이 앞에 있을 때 남이 부른 알림이 사라진다 (P8 코드 리뷰 2).
 *
 * - 남이 부른 곳이 하나라도 있으면 **문서 순서로 처음 나온 그 사람**이다. 그 사람이 부른 것은 사실이다.
 * - 없고 모르는 곳이 있으면 부르되 이름을 비운다 (`caller: null`) — 모르는 곳이 남이 부른 것일 수 있다.
 * - **스스로 부른 곳뿐이면 알림을 만들지 않는다** (`skip`). 이것만이 "자기 자신 필터"를 거는 경우다.
 * - 글자 기록에서 그 이름을 못 찾았으면 모름이다.
 */
export function callerFor(occurrences: readonly (string | null)[] | undefined, recipientId: string): { skip: boolean; caller: string | null } {
  if (!occurrences?.length) return { skip: false, caller: null };
  const other = occurrences.find((a): a is string => a !== null && a !== recipientId);
  if (other) return { skip: false, caller: other };
  if (occurrences.some((a) => a === null)) return { skip: false, caller: null };
  return { skip: true, caller: recipientId };
}
