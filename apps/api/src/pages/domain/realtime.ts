import { extractText, validateDocument, type DocNode } from '@workfluence/shared';

/**
 * 실시간 편집이 **버전을 만들지 말지** 판정한다 (A등급, P6_설계서_Collab C.2절 ⑤).
 *
 * **이 판정이 이 Phase에서 가장 조심할 곳이다.** `page_versions`는 append-only라
 * (6절) 잘못 만든 버전을 지울 수 없다. 그래서 이 함수는 **만드는 쪽이 아니라
 * 안 만드는 쪽으로 기운다** — 놓친 저장은 다음 유휴에 다시 오지만, 잘못 만든 버전은
 * 영원히 이력에 남는다.
 *
 * 순수 함수로 떼어낸 이유는 판정 조건이 다섯이고 그 조합을 실제 WebSocket 연결로
 * 시험하는 것은 느리고 불확실하기 때문이다. 게이트웨이는 시각과 문서를 모아 주기만 한다.
 */

export type SaveDecision =
  | { save: true; text: string }
  | { save: false; reason: string; errors: string[] };

export type SaveInput = {
  /** 실시간 상태에서 뽑아낸 지금 문서 */
  next: DocNode;
  /** 정본의 마지막 버전 내용. 첫 저장이면 `null` */
  previous: DocNode | null;
  /** 마지막 변경 이후 흐른 시간 */
  idleMs: number;
  /** 이만큼 조용하면 저장한다 (`WF_COLLAB_IDLE_SAVE_MS`) */
  idleThresholdMs: number;
  /** 마지막 연결이 끊길 때처럼 **기다릴 수 없는** 경우 */
  force?: boolean;
};

/**
 * 비교용 지문. 속성 **키를 정렬해** 담는다 — 직렬화 순서가 달라진 것을 변경으로 읽으면
 * 아무도 안 고쳤는데 버전이 하나 생긴다 (`diff.ts`와 같은 판단).
 */
function fingerprint(node: DocNode): string {
  const attrs = node.attrs
    ? Object.keys(node.attrs)
        .sort()
        .map((k) => `${k}:${JSON.stringify(node.attrs![k])}`)
        .join(',')
    : '';
  const marks = node.marks?.map((m) => `${m.type}${JSON.stringify(m.attrs ?? {})}`).join(',') ?? '';
  const kids = (node.content ?? []).map(fingerprint).join('');
  return `<${node.type}|${attrs}|${marks}|${node.text ?? ''}${kids}>`;
}

export function shouldSaveVersion(input: SaveInput): SaveDecision {
  // **검증이 가장 먼저다.** 강제 저장도 이것은 넘지 못한다 — 깨진 문서가 정본이 되면
  // 그 뒤의 검색·내보내기·비교가 전부 그것을 읽는다 (FR-708)
  const validation = validateDocument(input.next);
  if (!validation.ok) return { save: false, reason: `문서 검증 실패 (${validation.errors.length}건)`, errors: validation.errors };

  // 같으면 만들지 않는다. 커서만 움직여도 Yjs 변경이 오기 때문에 이것이 없으면
  // 가만히 보고만 있어도 버전이 쌓인다 (FR-707). **강제 저장도 예외가 아니다** —
  // 창을 닫을 때마다 버전이 하나씩 늘면 이력을 읽을 수 없게 된다
  if (input.previous && fingerprint(input.next) === fingerprint(input.previous)) {
    return { save: false, reason: '내용이 그대로', errors: [] };
  }

  const text = extractText(input.next).trim();

  // **빈 문서로 덮어쓰지 않는다.** 연결이 끊기며 빈 상태가 올라오는 경우가 실제로
  // 있고, 그대로 저장하면 내용이 사라진다. 일부러 비운 것은 `force`로 구분한다
  if (!text && !input.force) {
    const hadContent = input.previous ? extractText(input.previous).trim().length > 0 : false;
    return { save: false, reason: hadContent ? '빈 문서로 덮어쓰지 않는다' : '빈 문서', errors: [] };
  }
  if (!text && input.force && !input.previous) return { save: false, reason: '빈 문서', errors: [] };

  if (!input.force && input.idleMs < input.idleThresholdMs) return { save: false, reason: '아직 편집 중', errors: [] };

  return { save: true, text };
}
