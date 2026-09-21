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

export function extractMentions(doc: DocNode): string[] {
  const text = extractText(doc);
  const found: string[] = [];
  const seen = new Set<string>();

  for (const m of text.matchAll(MENTION)) {
    // 뒤에 붙은 문장부호는 아이디가 아니다. `@kim,` `@kim.` `@kim...`
    const name = m[2].replace(/[.\-_]+$/, '');
    if (!USERNAME.test(name) || seen.has(name)) continue;
    seen.add(name);
    found.push(name);
  }
  return found;
}
