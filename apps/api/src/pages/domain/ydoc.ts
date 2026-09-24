import { BLOCK_NODES, DOCUMENT_SCHEMA_VERSION, type DocMark, type DocNode } from '@workfluence/shared';
import * as Y from 'yjs';

/**
 * 실시간 상태(Y.Doc)와 정본 JSON 사이의 변환 (A등급, P6_설계서_Collab C.1절).
 *
 * **이 변환이 틀리면 조용히 내용이 사라진다.** 저장은 성공하고 버전도 생기는데 안에 든
 * 것이 다르다 — 사람이 며칠 뒤 문서를 열고서야 안다. 그래서 테스트의 축이 왕복이다.
 *
 * **서버에 ProseMirror를 들이지 않는다.** `y-prosemirror`의 변환 함수는 한쪽 방향에
 * ProseMirror 스키마를 요구하는데, 그러면 "서버는 JSON만 받는다"(0.2절)는 경계가
 * 흐려지고 편집기 라이브러리가 서버 의존성이 된다. 매핑은 80줄이고 규칙도 단순하다:
 * **요소는 `Y.XmlElement`, 글자는 `Y.XmlText`, 마크는 그 글자의 서식.**
 */

/** TipTap `Collaboration` 확장의 기본 필드 이름. 클라이언트와 **같아야 한다** */
export const COLLAB_FIELD = 'default';

/** 마크를 Yjs 서식으로. 속성이 없는 마크도 키는 있어야 해서 `{}`를 넣는다 */
function marksToAttributes(marks: DocMark[] | undefined): Record<string, unknown> | null {
  if (!marks?.length) return null;
  const out: Record<string, unknown> = {};
  // 마크 속성도 **빈 값은 떨어뜨린다.** 편집기의 링크는 `title: null`을 늘 달고 온다
  for (const m of marks) out[m.type] = Object.fromEntries(Object.entries(m.attrs ?? {}).filter(([, v]) => v !== null && v !== undefined));
  return out;
}

function attributesToMarks(attrs: Record<string, unknown> | undefined): DocMark[] | undefined {
  if (!attrs) return undefined;
  const marks: DocMark[] = [];
  for (const [type, value] of Object.entries(attrs)) {
    if (value === null || value === undefined) continue;
    const a = value as Record<string, unknown>;
    marks.push(Object.keys(a).length ? { type, attrs: a } : { type });
  }
  return marks.length ? marks : undefined;
}

/**
 * 자식들을 Yjs 노드로 바꾼다. **연속된 글자 노드는 `Y.XmlText` 하나로 묶는다.**
 *
 * 처음에는 글자 노드마다 `Y.XmlText`를 따로 만들었다. 그러면 편집기(y-prosemirror)가
 * 보는 구조와 달라져, **각 클라이언트의 첫 편집이 문단을 통째로 다시 쓴다** — 둘이
 * 겹치면 Yjs가 둘 다 살려 `"Hello worldworld"`처럼 글자가 복제된다. 다른 문단만
 * 고쳐도 일어난다 (자체 점검 2, 실측으로 재현됐다).
 *
 * 편집기가 만드는 모양과 **같게** 만드는 것이 이 함수의 일이다 — 서버가 만든 문서를
 * 편집기가 손대지 않아야 한다.
 */
function toYChildren(nodes: readonly DocNode[]): (Y.XmlElement | Y.XmlText)[] {
  const out: (Y.XmlElement | Y.XmlText)[] = [];
  let run: Y.XmlText | null = null;
  // **넣은 길이를 직접 센다.** 문서에 붙기 전 `Y.XmlText.length`는 0이라, 그것을 쓰면
  // 모든 조각이 맨 앞에 꽂혀 **글자 순서가 뒤집힌다** (테스트가 바로 잡았다)
  let offset = 0;
  for (const node of nodes) {
    if (node.type === 'text') {
      if (!run) {
        run = new Y.XmlText();
        offset = 0;
        out.push(run);
      }
      const text = node.text ?? '';
      if (text) {
        // **서식을 항상 명시한다.** 생략하면 Yjs가 **앞 글자의 서식을 물려준다** —
        // 굵은 글자 뒤의 평범한 글자가 같이 굵어진다 (테스트가 잡았다)
        run.insert(offset, text, marksToAttributes(node.marks) ?? {});
        offset += text.length;
      }
      continue;
    }
    run = null;
    out.push(toYNode(node));
  }
  return out;
}

/**
 * 요소 하나. **글자 노드는 오지 않는다** — `toYChildren`이 묶어서 처리하므로 여기까지
 * 닿을 길이 없다. 처음에는 여기에도 글자 분기를 뒀는데 호출되는 자리가 없어 지웠다
 * (`diff.ts`·`fromYNode`와 같은 판단: 닿지 않는 가지를 남기지 않는다).
 */
function toYNode(node: DocNode): Y.XmlElement {
  const el = new Y.XmlElement(node.type);
  for (const [k, v] of Object.entries(node.attrs ?? {})) {
    // **빈 값은 넣지 않는다.** `undefined`는 Yjs가 문자열 `"undefined"`로 굳히고,
    // `null`은 편집기가 기본값으로 채워 보내는 것이라 뜻이 없다 — 남겨 두면 REST로
    // 저장한 문서와 협업으로 저장한 문서가 **글자가 같은데 다르게** 보인다 (자체 점검 18)
    if (v === undefined || v === null) continue;
    el.setAttribute(k, v as never);
  }
  const kids = toYChildren(node.content ?? []);
  if (kids.length) el.push(kids);
  return el;
}

/** 정본 JSON에서 실시간 상태를 만든다. 페이지를 **처음 열 때** 한 번 */
export function yDocFromDoc(doc: DocNode): Y.Doc {
  const ydoc = new Y.Doc();
  const fragment = ydoc.getXmlFragment(COLLAB_FIELD);
  const kids = toYChildren(doc.content ?? []);
  if (kids.length) fragment.push(kids);
  return ydoc;
}

function fromYText(text: Y.XmlText): DocNode[] {
  const out: DocNode[] = [];
  for (const d of text.toDelta() as { insert?: unknown; attributes?: Record<string, unknown> }[]) {
    if (typeof d.insert !== 'string' || !d.insert) continue;
    const marks = attributesToMarks(d.attributes);
    out.push(marks ? { type: 'text', text: d.insert, marks } : { type: 'text', text: d.insert });
  }
  return out;
}

function fromYNode(node: Y.XmlElement | Y.XmlText | Y.XmlHook): DocNode[] {
  if (node instanceof Y.XmlText) return fromYText(node);
  // `Y.XmlHook`은 **우리가 만들지 않는다.** 만드는 코드가 없으므로 여기 올 수 없다 —
  // 타입에는 있으니 좁히기는 하되, 닿지 않는 분기를 남겨 두지 않는다 (`diff.ts`와 같은 판단)
  const el = node as Y.XmlElement;
  // 편집기 쪽에서 온 `null` 기본값을 여기서 떨어뜨린다 (자체 점검 1·18)
  const attrs = Object.fromEntries(Object.entries(el.getAttributes() as Record<string, unknown>).filter(([, v]) => v !== null && v !== undefined));
  const content: DocNode[] = [];
  for (const child of el.toArray()) content.push(...fromYNode(child as Y.XmlElement | Y.XmlText));

  const out: DocNode = { type: el.nodeName };
  if (Object.keys(attrs).length) out.attrs = attrs;
  if (content.length) out.content = content;
  return [out];
}

/**
 * 실시간 상태에서 정본 JSON을 뽑는다. **저장할 때마다** 부른다.
 *
 * 최상위에 `schemaVersion`을 다시 찍는다 — 실시간 상태에는 그것이 없고, 저장되는 문서는
 * 스스로 어느 스키마인지 말해야 한다 (6절).
 */
export function docFromYDoc(ydoc: Y.Doc): DocNode {
  const fragment = ydoc.getXmlFragment(COLLAB_FIELD);
  const content: DocNode[] = [];
  for (const child of fragment.toArray()) content.push(...fromYNode(child as Y.XmlElement | Y.XmlText));
  return { type: 'doc', attrs: { schemaVersion: DOCUMENT_SCHEMA_VERSION }, content };
}

/**
 * 글자마다 **넣은 사람**을 붙인 본문 (P8_설계서_Mention C.3절, FR-900).
 *
 * `text`는 `extractText(docFromYDoc(ydoc))`와 **마지막 정리(빈 줄 줄이기·앞뒤 공백)만 빼고 같다.**
 * 멘션 판정은 그 정리의 앞뒤로 같으므로(`@` 앞의 공백은 공백으로 남는다) 정리는 하지 않는다 —
 * 하면 글자 위치와 `authors`의 짝이 어긋난다. 걷는 규칙을 `extractText`와 맞추는 것이 이 함수의
 * 일이고, 테스트가 둘의 일치를 강제한다. 한쪽이 찾은 멘션을 다른 쪽이 못 찾으면 그 멘션은
 * **조용히 "모름"이 된다.**
 *
 * `authors[i]`는 `text[i]`(UTF-16 단위)를 넣은 클라이언트를 `authorOf`로 바꾼 것이다.
 * 줄바꿈처럼 **아무도 치지 않은 글자는 `null`**이다.
 *
 * `Y.XmlText`의 조각 사슬(`_start` → `right`)을 직접 걷는다. `toDelta()`는 글자를 서식별로
 * 묶어 줄 뿐 **누가 넣었는지는 버린다.** 서식 조각(`ContentFormat`)과 끼워 넣기(embed)는 글자가
 * 아니므로 건너뛴다 — `docFromYDoc`도 문자열이 아닌 것은 버린다.
 */
export function attributedText(ydoc: Y.Doc, authorOf: (client: number) => string | null): { text: string; authors: (string | null)[] } {
  const parts: string[] = [];
  const authors: (string | null)[] = [];
  const push = (s: string, who: string | null): void => {
    parts.push(s);
    for (let i = 0; i < s.length; i++) authors.push(who);
  };
  const walk = (node: Y.XmlElement | Y.XmlText): void => {
    if (node instanceof Y.XmlText) {
      for (let item = node._start; item; item = item.right) {
        if (item.deleted || !(item.content instanceof Y.ContentString)) continue;
        push(item.content.str, authorOf(item.id.client));
      }
      return;
    }
    // `extractText`와 같은 순서·같은 규칙이다: 줄바꿈 노드 → 자식 → 블록 끝 줄바꿈
    if (node.nodeName === 'hardBreak') {
      push('\n', null);
      return;
    }
    for (const child of node.toArray()) walk(child as Y.XmlElement | Y.XmlText);
    if (BLOCK_NODES.has(node.nodeName)) push('\n', null);
  };
  for (const child of ydoc.getXmlFragment(COLLAB_FIELD).toArray()) walk(child as Y.XmlElement | Y.XmlText);
  return { text: parts.join(''), authors };
}
