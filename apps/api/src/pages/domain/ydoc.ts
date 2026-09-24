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

function fromYNode(node: unknown): DocNode[] {
  if (node instanceof Y.XmlText) return fromYText(node);
  // **편집기가 만들지 않는 노드는 버린다** (P8 세 번째 검토 2). 우리 편집기는 `Y.XmlElement`·`Y.XmlText`만
  // 만들지만 **조작한 클라이언트는 `Y.XmlHook`·`Y.Text`·`Y.Map`을 넣을 수 있다.** 예전에는 "만드는 코드가 없으니
  // 올 수 없다"고 보고 좁히기만 했는데, 그런 노드 하나로 여기서 던져 **그 페이지의 자동 저장이 영영 실패했다.**
  // 그 노드는 정본 JSON에 뜻이 없다
  if (!(node instanceof Y.XmlElement)) return [];
  const el = node;
  // 편집기 쪽에서 온 `null` 기본값을 여기서 떨어뜨린다 (자체 점검 1·18)
  const attrs = Object.fromEntries(Object.entries(el.getAttributes() as Record<string, unknown>).filter(([, v]) => v !== null && v !== undefined));
  const content: DocNode[] = [];
  for (const child of el.toArray()) content.push(...fromYNode(child));

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
  for (const child of fragment.toArray()) content.push(...fromYNode(child));
  return { type: 'doc', attrs: { schemaVersion: DOCUMENT_SCHEMA_VERSION }, content };
}

/**
 * 문서의 **멘션 자리** — `@` 글자의 ID와 이름, 그리고 `@`부터 이름 끝까지 글자의 ID (P8_설계서_Mention C.2절, FR-900).
 *
 * 걷는 규칙은 `extractText`와 **같아야 한다** — 한쪽이 찾은 멘션을 다른 쪽이 못 찾으면 그 멘션은 조용히
 * "모름"이 된다. 테스트가 둘의 일치를 강제한다. 마지막 정리(빈 줄 줄이기·앞뒤 공백)는 하지 않는다 — 멘션
 * 판정은 그 정리 앞뒤로 같고(`@` 앞의 공백은 공백으로 남는다), 하면 글자와 ID의 짝이 어긋난다.
 *
 * 자리를 **글자의 ID**로 가리는 이유: 위치(몇 번째 글자)는 앞에 누가 치기만 해도 바뀐다. ID는 그 글자가
 * 지워지기 전까지 그대로다. 멘션 규칙(무엇이 멘션인가)은 알림 쪽이 들고 있어 `scan`으로 받는다.
 *
 * `Y.XmlText`의 조각 사슬(`_start` → `right`)을 직접 걷는다 — `toDelta()`는 글자의 ID를 버리고, 부를 때마다
 * 정리 트랜잭션을 일으킨다. 지운 조각·서식 조각·끼워 넣기(embed)는 글자가 아니므로 건너뛴다.
 * 비용은 한 번 걷기다 — 4.5만~6.2만 자·멘션 1,000~1,500개 문서에서 3~6ms (`P8_검증기록_Mention` 2절).
 */
export function mentionSites(
  ydoc: Y.Doc,
  scan: (text: string) => readonly { name: string; start: number; end: number }[],
): { key: string; name: string; span: [number, number][] }[] {
  const parts: string[] = [];
  /** 글자마다 `client`·`clock`. 구조 글자(줄바꿈)는 -1 */
  const clients: number[] = [];
  const clocks: number[] = [];
  const pushBreak = (): void => {
    parts.push('\n');
    clients.push(-1);
    clocks.push(-1);
  };
  const walk = (node: unknown): void => {
    if (node instanceof Y.XmlText) {
      for (let item = node._start; item; item = item.right) {
        if (item.deleted || !(item.content instanceof Y.ContentString)) continue;
        const str = item.content.str;
        parts.push(str);
        for (let k = 0; k < str.length; k++) {
          clients.push(item.id.client);
          clocks.push(item.id.clock + k);
        }
      }
      return;
    }
    // **편집기가 만들지 않는 노드는 글자가 아니다** — `docFromYDoc`도 버린다. 여기서 던지면 장부가 고장 나 그 방의
    // 멘션이 전부 모름이 된다 (처음에는 방의 중계가 멈췄다 — P8 세 번째 검토 2, T-035)
    if (!(node instanceof Y.XmlElement)) return;
    // `extractText`와 같은 순서·같은 규칙이다: 줄바꿈 노드 → 자식 → 블록 끝 줄바꿈
    if (node.nodeName === 'hardBreak') {
      pushBreak();
      return;
    }
    for (const child of node.toArray()) walk(child);
    if (BLOCK_NODES.has(node.nodeName)) pushBreak();
  };
  for (const child of ydoc.getXmlFragment(COLLAB_FIELD).toArray()) walk(child);

  const out: { key: string; name: string; span: [number, number][] }[] = [];
  for (const hit of scan(parts.join(''))) {
    if (clients[hit.start] === undefined || clients[hit.start] < 0) continue;
    // `@`부터 이름 끝까지 글자의 ID — 누가 들여왔는지를 이것으로 묻는다 (C.2절)
    const span: [number, number][] = [];
    for (let i = hit.start; i < hit.end; i++) span.push([clients[i], clocks[i]]);
    out.push({ key: `${clients[hit.start]}:${clocks[hit.start]}`, name: hit.name, span });
  }
  return out;
}
