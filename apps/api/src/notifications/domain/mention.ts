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
 * **같은 이름이 여러 번 나오면 전부 낸다.** 곳마다 친 사람이 다를 수 있다.
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
 * 이름마다 **그 멘션을 친 사람** (P8_설계서_Mention C.3절, FR-900·901).
 *
 * `authors[i]`는 `text[i]`를 넣은 사람이다(`attributedText`). 멘션 하나는 `@`부터 이름 끝까지
 * **모든 글자를 같은 사람이 넣었을 때만** 그 사람의 것이다. 한 글자라도 다른 사람이거나
 * 모르면 `null` — A가 `@ki`를 치고 B가 `m`을 붙였으면 누가 불렀다고 말할 수 없다.
 *
 * 같은 이름이 여러 곳에 있으면 **문서 순서로 처음 나오는, 친 사람을 아는 것**을 쓴다.
 * 그 사람이 그 이름을 부른 것은 사실이다. 멘션 밖의 글자(앞의 공백 등)는 보지 않는다.
 */
export function mentionAuthors(text: string, authors: readonly (string | null)[]): Map<string, string | null> {
  const out = new Map<string, string | null>();
  for (const hit of scanMentions(text)) {
    if (out.get(hit.name)) continue; // 이미 아는 사람을 찾았다
    let who: string | null = authors[hit.start] ?? null;
    for (let i = hit.start + 1; who && i < hit.end; i++) if ((authors[i] ?? null) !== who) who = null;
    out.set(hit.name, who);
  }
  return out;
}
