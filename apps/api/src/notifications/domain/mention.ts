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
 * 글자마다 **누가, 어떻게** 넣었는지를 붙인 본문 (P8_설계서_Mention C.3절).
 *
 * 실시간 편집 쪽(`attributedText`)이 만들고 이 모듈이 읽는다. **계약은 읽는 쪽이 정한다** —
 * 멘션 규칙은 이 모듈의 것이고, 만드는 쪽은 Yjs에서 보이는 사실만 옮긴다.
 *
 * - `authors[i]` — `text[i]`를 넣은 사용자 id. 모르면 `null`
 * - `structural[i]` — 블록 끝·줄바꿈처럼 **누가 친 글자가 아닌** 구조 글자
 * - `afterLeft[i]` — `text[i]`를 칠 때 바로 왼쪽이 **지금의 `text[i-1]`**이었다 (사이에 지운 흔적만 있을 수 있다)
 * - `before[i]` — `text[i]`를 칠 때 바로 오른쪽에 있던 글자. `null` = 없었다(끝에 붙였다), `undefined` = 그 글자가 지금 보이지 않는다
 * - `gaps[g]` (`0..text.length`) — `text[g-1]`과 `text[g]` 사이의 **지운 흔적**. `undefined` = 없다,
 *   문자열 = 전부 그 사람이 **자기 글자를 자기가** 지운 것, `null` = 그 밖(남이 지웠거나 모른다)
 */
export type TypedText = {
  text: string;
  authors: readonly (string | null)[];
  structural: readonly boolean[];
  afterLeft: readonly boolean[];
  before: readonly (string | null | undefined)[];
  gaps: readonly (string | null | undefined)[];
};

/** 아이디에 쓰이는 글자 — 이 글자 사이를 가르면 이름이 바뀐다 (`USERNAME`과 같은 집합) */
const ID_CHAR = /^[a-z0-9._-]$/;

/** 그 흔적이 `who`에게 문제없는가 — 없거나, 전부 `who`가 자기 글자를 지운 것 */
const harmless = (gap: string | null | undefined, who: string): boolean => gap === undefined || gap === who;

/**
 * 멘션 하나를 **만든** 사람. 확실하지 않으면 `null` (FR-900·901).
 *
 * 글자를 누가 쳤는지만 보면 틀린다. **남이 지우거나 끼워 넣어 멘션을 "생기게" 할 수 있다**
 * (P8 코드 리뷰 1 · 보안 검토 1) — `@kim.lee`에서 `.lee`를 지우면 `@kim`이 새로 생기고, 남은 글자는
 * 전부 원래 쓴 사람의 것이다. 그래서 글자와 함께 **그 글자의 앞뒤가 그 사람이 친 그대로인지** 본다.
 *
 * 1. `@`부터 이름 끝까지 **모든 글자를 한 사람(U)이** 넣었다.
 * 2. 멘션 안과 **양 끝의 틈에 남이 지운 흔적이 없다.** U가 자기 오타를 지운 흔적은 괜찮다.
 * 3. **앞 경계**(`@` 바로 앞 글자)가 U의 것이 아니면, U가 `@`를 **그 글자 바로 뒤에** 쳤어야 한다.
 *    남이 나중에 공백을 끼워 `x@kim`을 `x @kim`으로 만든 것을 여기서 막는다. 남의 문장 뒤에
 *    이어서 부르는 흔한 경우는 통과한다.
 * 4. **뒤 끝**(이름 바로 다음 글자)이 U의 것이 아니면, 그 글자가 **이름 글자 사이를 가르며** 들어온
 *    것이 아니어야 한다. `@kimlee`에 공백을 끼워 `@kim lee`로 만든 것은 막고, `@kim 확인`에 `님`을
 *    붙인 것은 통과한다. 갈랐는지 알 수 없으면(오른쪽 글자가 지금 없다) 막는다.
 *
 * 블록의 처음·끝과 구조 글자는 경계로 친다 — 누가 친 글자가 아니다.
 */
function makerOf(t: TypedText, hit: MentionHit): string | null {
  const who = t.authors[hit.start] ?? null;
  if (!who) return null;
  for (let i = hit.start + 1; i < hit.end; i++) if ((t.authors[i] ?? null) !== who) return null;
  for (let g = hit.start; g <= hit.end; g++) if (!harmless(t.gaps[g], who)) return null;

  const left = hit.start - 1;
  if (left >= 0 && !t.structural[left] && t.authors[left] !== who && !t.afterLeft[hit.start]) return null;

  const right = hit.end;
  if (right < t.text.length && !t.structural[right] && t.authors[right] !== who) {
    const was = t.before[right];
    if (was === undefined || (was !== null && ID_CHAR.test(was))) return null;
  }
  return who;
}

/**
 * 이름마다, **멘션이 나온 곳마다** 그것을 만든 사람 (P8_설계서_Mention C.3절).
 *
 * 곳마다 따로 낸다. 같은 이름을 스스로 부른 곳과 남이 부른 곳이 함께 있을 수 있고, 받는 사람에게
 * 누구를 말할지는 `callerFor`가 **받는 사람을 알고** 고른다 — 여기서 하나로 줄이면 "스스로 부른
 * 곳"이 앞에 있을 때 남이 부른 알림이 사라진다 (P8 코드 리뷰 2).
 */
export function mentionAuthors(t: TypedText): Map<string, (string | null)[]> {
  const out = new Map<string, (string | null)[]>();
  for (const hit of scanMentions(t.text)) {
    const list = out.get(hit.name) ?? [];
    list.push(makerOf(t, hit));
    out.set(hit.name, list);
  }
  return out;
}

/**
 * 받는 사람에게 **누가 불렀다고 말하나** (FR-900·902).
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
