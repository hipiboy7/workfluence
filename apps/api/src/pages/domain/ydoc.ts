import { DOCUMENT_SCHEMA_VERSION, type DocMark, type DocNode } from '@workfluence/shared';
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
  for (const m of marks) out[m.type] = m.attrs ?? {};
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

function toYNode(node: DocNode): Y.XmlElement | Y.XmlText {
  if (node.type === 'text') {
    const text = new Y.XmlText();
    text.insert(0, node.text ?? '', marksToAttributes(node.marks) ?? undefined);
    return text;
  }
  const el = new Y.XmlElement(node.type);
  for (const [k, v] of Object.entries(node.attrs ?? {})) {
    // `undefined`는 넣지 않는다 — Yjs가 문자열 `"undefined"`로 굳힌다
    if (v === undefined) continue;
    el.setAttribute(k, v as never);
  }
  const kids = (node.content ?? []).map(toYNode);
  if (kids.length) el.push(kids);
  return el;
}

/** 정본 JSON에서 실시간 상태를 만든다. 페이지를 **처음 열 때** 한 번 */
export function yDocFromDoc(doc: DocNode): Y.Doc {
  const ydoc = new Y.Doc();
  const fragment = ydoc.getXmlFragment(COLLAB_FIELD);
  const kids = (doc.content ?? []).map(toYNode);
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
  const attrs = el.getAttributes() as Record<string, unknown>;
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
