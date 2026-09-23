import type { DocNode } from './document';

/**
 * 문서 두 개를 비교한다 (A등급, P6_설계서_Collab FR-720~726).
 *
 * **HTML을 만들지 않는다** (FR-725). 구조로 돌려주고 그리는 것은 화면의 일이다 —
 * 문자열 HTML을 만들어 넘기면 이스케이프 책임이 두 곳으로 갈라지고, 그러면 한쪽이 상한다.
 *
 * 이 비교가 답해야 하는 질문은 하나다: **"무엇이 바뀌었나."** 그래서 "어떻게 바뀌었나"를
 * 정확히 재구성하려 들지 않는다 — 문단을 옮긴 것은 "옮김"이 아니라 삭제+추가로 나온다.
 * 옮김을 잡으려면 블록 짝짓기가 훨씬 복잡해지는데, 사람이 이력을 볼 때 묻는 것은
 * 대개 "이 문단이 언제 이렇게 됐나"이고 그것은 삭제+추가로도 답이 된다.
 */

export type WordDiff = { kind: 'same' | 'added' | 'removed'; text: string };

export type BlockDiff = {
  kind: 'same' | 'added' | 'removed' | 'changed';
  /** 블록 종류 (`paragraph`·`heading`·`table` 등). 바뀌었으면 **바뀐 뒤**의 종류 */
  type: string;
  /** 이전 쪽 텍스트. 추가된 블록에는 없다 */
  before?: string;
  /** 이후 쪽 텍스트. 삭제된 블록에는 없다 */
  after?: string;
  /** `changed`일 때만. 낱말 단위 차이 (FR-723) */
  words?: WordDiff[];
};

export type DocDiff = {
  changed: boolean;
  added: number;
  removed: number;
  modified: number;
  blocks: BlockDiff[];
};

/**
 * 블록을 **짝짓기 위한 지문**. 종류 + 속성 + 텍스트를 한 문자열로 접는다.
 *
 * 속성은 **키를 정렬해** 담는다. 편집기나 직렬화 순서가 달라진 것을 변경으로 읽으면
 * "아무것도 안 고쳤는데 전부 바뀌었다"가 된다.
 */
function attrsKey(attrs: DocNode['attrs']): string {
  if (!attrs) return '';
  return Object.keys(attrs)
    .filter((k) => attrs[k] !== null && attrs[k] !== undefined)
    .sort()
    .map((k) => `${k}=${JSON.stringify(attrs[k])}`)
    .join(',');
}

function fingerprint(node: DocNode): string {
  return blockKey(node);
}

/**
 * 블록 안의 **사람이 읽을 글자**를 순서대로 모은다. 표·목록처럼 자식이 깊어도 끝까지 내려간다 (FR-724).
 *
 * **이 값은 화면에 그대로 그려진다** (`BlockDiff.before`/`after`, 낱말 비교의 입력).
 * 그러니 여기에 구분자나 마크 표기를 섞으면 **비교 화면에 쓰레기 문자가 찍힌다.**
 * 짝짓기에 쓰는 값은 아래 `blockKey`로 따로 둔다.
 *
 * **블록에만 부른다 — 문서(`doc`)에는 부르지 않는다.** 처음에는 `doc`일 때 줄바꿈으로
 * 잇는 분기를 뒀는데 호출되는 자리가 없었다. 죽은 가지는 "나중에 쓰일지 모른다"로
 * 남겨 두면 그 뒤로 아무도 맞는지 확인하지 않는다.
 */
function blockText(node: DocNode): string {
  if (node.text !== undefined) return node.text;
  if (!node.content) return '';
  return node.content.map(blockText).join('');
}

/**
 * 짝짓기·같음 판정에 쓰는 **구조 지문**. 사람에게 보여 주지 않는다.
 *
 * 왜 `blockText`로는 안 되는가. 두 가지를 놓친다.
 *
 * 1. **마크.** `href`가 `/a`에서 `/evil`로 바뀐 것을 이력 비교가 "같다"고 답하면 안 된다
 *    (P6 코드 리뷰 4). `realtime.ts`의 같은 이름 함수는 처음부터 마크를 담고 있었는데
 *    복사해 오면서 한쪽만 빠졌다.
 * 2. **블록 안쪽의 경계.** 구분자 없이 이으면 `['사과','배']` 목록과 `['사과배']` 목록이
 *    같은 글자가 되어 **항목을 합친 변경이 사라진다** (P6 코드 리뷰 10).
 *
 * **구분자로 글자를 쓰지 않는다.** 한 글자를 경계로 삼으면 사람이 그 글자를 본문에 넣는
 * 순간 충돌한다 — `['사과','배']`와 `['사과\u0000배']`가 같아진다(직접 넣어 보고 확인했다).
 * 괄호로 감싸도 마찬가지로 본문에 괄호를 넣어 흉내 낼 수 있다. **`JSON.stringify`가
 * 중첩을 모호하지 않게 만든다** — 안쪽 문자열의 따옴표·역슬래시를 스스로 이스케이프한다.
 */
function blockKey(node: DocNode): string {
  return JSON.stringify([
    node.type,
    attrsKey(node.attrs),
    marksKey(node.marks),
    node.text ?? '',
    (node.content ?? []).map(blockKey),
  ]);
}

/** 마크를 지문에 담는다. 순서는 뜻이 없으므로 정렬한다 */
function marksKey(marks: DocNode['marks']): string {
  if (!marks || marks.length === 0) return '';
  return marks
    .map((m) => `${m.type}[${attrsKey(m.attrs)}]`)
    .sort()
    .join('+');
}

/** 낱말로 쪼갠다. 공백은 버리고 낱말만 남긴다 — 공백 변경은 사람이 묻는 차이가 아니다 */
function words(text: string): string[] {
  return text.split(/\s+/).filter(Boolean);
}

/**
 * 최장 공통 부분수열. 짝지어진 위치의 목록을 돌려준다.
 *
 * 블록 수는 한 문서에서 수백을 넘지 않으므로(페이지 트리 최대 깊이와 같은 규모) O(n·m)
 * 표를 그대로 쓴다. 더 빠른 알고리즘은 읽기 어려워지는 값에 비해 얻는 것이 없다.
 */
function lcs(a: readonly string[], b: readonly string[]): [number, number][] {
  const n = a.length;
  const m = b.length;
  const table: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      table[i][j] = a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }
  const pairs: [number, number][] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      pairs.push([i, j]);
      i++;
      j++;
    } else if (table[i + 1][j] >= table[i][j + 1]) i++;
    else j++;
  }
  return pairs;
}

/** 낱말 단위 차이 (FR-723) */
export function diffWords(before: string, after: string): WordDiff[] {
  const a = words(before);
  const b = words(after);
  const pairs = lcs(a, b);
  const out: WordDiff[] = [];
  let i = 0;
  let j = 0;
  for (const [pa, pb] of pairs) {
    while (i < pa) out.push({ kind: 'removed', text: a[i++] });
    while (j < pb) out.push({ kind: 'added', text: b[j++] });
    out.push({ kind: 'same', text: a[i] });
    i++;
    j++;
  }
  while (i < a.length) out.push({ kind: 'removed', text: a[i++] });
  while (j < b.length) out.push({ kind: 'added', text: b[j++] });
  return out;
}

/**
 * 짝지어지지 않은 블록 묶음을 **변경 / 추가 / 삭제**로 접는다.
 *
 * 같은 자리에서 하나가 빠지고 하나가 들어왔으면 **"고쳤다"로 읽는다** — 사람이 문단
 * 하나를 고치면 지문이 달라져 짝이 안 맞는데, 그것을 삭제+추가로 보여 주면
 * "무엇이 바뀌었나"에 답하지 못한다.
 */
function foldGap(oldBlocks: DocNode[], newBlocks: DocNode[], out: BlockDiff[], count: { added: number; removed: number; modified: number }): void {
  const n = Math.min(oldBlocks.length, newBlocks.length);
  for (let k = 0; k < n; k++) {
    const before = blockText(oldBlocks[k]);
    const after = blockText(newBlocks[k]);
    out.push({ kind: 'changed', type: newBlocks[k].type, before, after, words: diffWords(before, after) });
    count.modified++;
  }
  for (let k = n; k < oldBlocks.length; k++) {
    out.push({ kind: 'removed', type: oldBlocks[k].type, before: blockText(oldBlocks[k]) });
    count.removed++;
  }
  for (let k = n; k < newBlocks.length; k++) {
    out.push({ kind: 'added', type: newBlocks[k].type, after: blockText(newBlocks[k]) });
    count.added++;
  }
}

export function diffDocs(before: DocNode, after: DocNode): DocDiff {
  const a = before.content ?? [];
  const b = after.content ?? [];
  const pairs = lcs(a.map(fingerprint), b.map(fingerprint));

  const blocks: BlockDiff[] = [];
  const count = { added: 0, removed: 0, modified: 0 };
  let i = 0;
  let j = 0;
  for (const [pa, pb] of pairs) {
    foldGap(a.slice(i, pa), b.slice(j, pb), blocks, count);
    blocks.push({ kind: 'same', type: b[pb].type, before: blockText(a[pa]), after: blockText(b[pb]) });
    i = pa + 1;
    j = pb + 1;
  }
  foldGap(a.slice(i), b.slice(j), blocks, count);

  return { changed: count.added + count.removed + count.modified > 0, ...count, blocks };
}
