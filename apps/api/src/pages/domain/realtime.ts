import { extractText, validateDocument, type DocNode } from '@workfluence/shared';

/**
 * 실시간 편집이 **버전을 만들지 말지** 판정한다 (A등급, P6_설계서_Collab C.2절 ⑤,
 * P7_설계서_Hardening §F).
 *
 * **이 판정이 가장 조심할 곳이다.** `page_versions`는 append-only라 (6절) 잘못 만든
 * 버전을 지울 수 없다. 그래서 이 함수는 **만드는 쪽이 아니라 안 만드는 쪽으로 기운다** —
 * 놓친 저장은 다음 유휴에 다시 오지만, 잘못 만든 버전은 영원히 이력에 남는다.
 *
 * 순수 함수로 떼어낸 이유는 판정 조건이 여럿이고 그 조합을 실제 WebSocket 연결로
 * 시험하는 것은 느리고 불확실하기 때문이다. 게이트웨이는 시각과 문서를 모아 주기만 한다.
 */

export type SaveDecision =
  | { save: true; text: string }
  | { save: false; reason: string; errors: string[] };

/**
 * 왜 지금 판정하는가. **`force` 하나로 묶으면 안 된다** (P6 코드 리뷰 8).
 *
 * | 계기 | 유휴를 기다리나 | 빈 문서로 덮을 수 있나 |
 * |---|---|---|
 * | `idle` — 주기 점검 | 기다린다 | 아니다 |
 * | `manual` — 사람이 저장을 눌렀다 | 안 기다린다 | **그렇다** (일부러 비운 것이다) |
 * | `leave` — 마지막 사람이 나갔다 | 안 기다린다 | 아니다 |
 * | `shutdown` — 프로세스가 내려간다 | 안 기다린다 | 아니다 |
 *
 * 전에는 뒤의 셋이 전부 `force: true`였다. 그래서 **"연결이 끊기며 빈 상태가 올라오면
 * 내용이 사라진다"고 주석에 적어 둔 바로 그 경로가 보호를 뚫고 있었다.**
 */
export type SaveTrigger = 'idle' | 'manual' | 'leave' | 'shutdown';

export type SaveInput = {
  /** 실시간 상태에서 뽑아낸 지금 문서 */
  next: DocNode;
  /** 정본의 마지막 버전 내용. 첫 저장이면 `null` */
  previous: DocNode | null;
  /** 지금 화면의 제목. 본문이 같아도 이것이 다르면 저장한다 */
  nextTitle?: string;
  /** 정본의 제목 */
  previousTitle?: string;
  /** 마지막 변경 이후 흐른 시간 */
  idleMs: number;
  /** 이만큼 조용하면 저장한다 (`WF_COLLAB_IDLE_SAVE_MS`) */
  idleThresholdMs: number;
  trigger: SaveTrigger;
};

function attrsKey(attrs: DocNode['attrs']): string {
  if (!attrs) return '';
  // **값이 빈 속성은 없는 것과 같다.** ProseMirror가 `target: null`·`colwidth: null`을
  // 늘 붙이는데 그것을 담으면 REST로 저장된 문서와 Yjs를 거친 문서가 달라 보인다
  return Object.keys(attrs)
    .filter((k) => attrs[k] !== null && attrs[k] !== undefined)
    .sort()
    .map((k) => `${k}:${JSON.stringify(attrs[k])}`)
    .join(',');
}

function marksKey(marks: DocNode['marks']): string {
  if (!marks || marks.length === 0) return '';
  // 순서는 뜻이 없다. 정렬하지 않으면 왕복하며 순서가 바뀐 것을 변경으로 읽는다
  return marks
    .map((m) => `${m.type}(${attrsKey(m.attrs)})`)
    .sort()
    .join('+');
}

/**
 * 자식 목록을 **표준형**으로 만든다.
 *
 * Yjs는 같은 서식의 이웃한 글자를 한 덩어리로 들고 있어, 왕복하면 `'He' + 'llo'`가
 * `'Hello'` 하나가 된다. 표준형으로 접지 않으면 **REST로 저장해 둔 옛 문서를 협업
 * 편집기로 열었다 닫기만 해도 똑같은 내용의 버전이 하나 늘어난다** (P6 코드 리뷰 7).
 */
function canonicalKids(nodes: readonly DocNode[]): DocNode[] {
  const out: DocNode[] = [];
  for (const node of nodes) {
    const last = out[out.length - 1];
    if (node.type === 'text' && last?.type === 'text' && marksKey(last.marks) === marksKey(node.marks)) {
      out[out.length - 1] = { ...last, text: (last.text ?? '') + (node.text ?? '') };
      continue;
    }
    out.push(node);
  }
  // 빈 글자는 보이지도 않고 뜻도 없다
  return out.filter((n) => !(n.type === 'text' && !n.text));
}

/**
 * **`JSON.stringify`로 감싼다.** 글자를 경계로 쓰면 사람이 그 글자를 본문에 넣어 구조를
 * 흉내 낼 수 있고, 그러면 **바뀐 문서를 "그대로"로 보아 저장을 건너뛴다.**
 * 스스로의 편집이 사라지는 것이라 남을 해치지는 않지만, 조용히 잘못되는 쪽이다
 * (`packages/shared/src/diff.ts`의 `blockKey`와 같은 판단).
 */
function fingerprint(node: DocNode): string {
  return JSON.stringify([
    node.type,
    attrsKey(node.attrs),
    marksKey(node.marks),
    node.text ?? '',
    canonicalKids(node.content ?? []).map(fingerprint),
  ]);
}

/** 검증 오류 목록. 통과하면 빈 목록 */
function validationErrors(doc: DocNode): string[] {
  const v = validateDocument(doc);
  return v.ok ? [] : v.errors;
}

/** 검증 오류를 화면에 알릴 까닭 한 줄로 — 첫 문장과 나머지 건수. 오류가 없으면 `null` (P9 D.9) */
export function blockedReason(errors: readonly string[]): string | null {
  if (!errors.length) return null;
  return errors.length > 1 ? `${errors[0]} 외 ${errors.length - 1}건` : errors[0];
}

/**
 * **이 문서로는 자동 저장이 멈추는가** — 그 까닭 한 줄, 아니면 `null` (P9 D.9). 방을 열 때 쓴다. `shouldSaveVersion`의 첫 단계와
 * 같은 검증이다 — 두 벌로 두면 한쪽만 바뀌어 들어오는 사람이 판정과 다른 까닭을 본다 (P9 세 번째 코드 리뷰 5)
 */
export function saveBlockedReason(doc: DocNode): string | null {
  return blockedReason(validationErrors(doc));
}

export function shouldSaveVersion(input: SaveInput): SaveDecision {
  const { trigger } = input;

  // **검증이 가장 먼저다.** 어떤 계기도 이것은 넘지 못한다 — 깨진 문서가 정본이 되면
  // 그 뒤의 검색·내보내기·비교가 전부 그것을 읽는다 (FR-708)
  const errors = validationErrors(input.next);
  if (errors.length) return { save: false, reason: `문서 검증 실패 (${errors.length}건)`, errors };

  // 같으면 만들지 않는다. 커서만 움직여도 Yjs 변경이 오기 때문에 이것이 없으면
  // 가만히 보고만 있어도 버전이 쌓인다 (FR-707). **강제 저장도 예외가 아니다**
  const titleChanged = input.nextTitle !== undefined && input.previousTitle !== undefined && input.nextTitle !== input.previousTitle;
  if (input.previous && !titleChanged && fingerprint(input.next) === fingerprint(input.previous)) {
    return { save: false, reason: '내용이 그대로', errors: [] };
  }

  const text = extractText(input.next).trim();

  if (!text) {
    // 내용이 아예 없던 페이지를 비운 채로 남길 이유는 없다
    if (!input.previous) return { save: false, reason: '빈 문서', errors: [] };
    const hadContent = extractText(input.previous).trim().length > 0;
    // **빈 문서로 덮어쓰는 것은 사람이 저장을 눌렀을 때뿐이다.** 연결이 끊기며 빈 상태가
    // 올라오는 경우가 실제로 있고, 마지막 퇴장·프로세스 종료가 그 경로다
    if (hadContent && trigger !== 'manual') return { save: false, reason: '빈 문서로 덮어쓰지 않는다', errors: [] };
    if (!hadContent && !titleChanged) return { save: false, reason: '빈 문서', errors: [] };
  }

  if (trigger === 'idle' && input.idleMs < input.idleThresholdMs) return { save: false, reason: '아직 편집 중', errors: [] };

  return { save: true, text };
}
