import { ALLOWED_CHILDREN, MARKS_IN, markProblems, nodeAttrProblems } from '@workfluence/shared';
import * as Y from 'yjs';
import { COLLAB_FIELD } from './ydoc';

/**
 * 실시간 편집의 **관문** (A등급, P9_설계서_Gate D.2~D.4, FR-1000~1003).
 *
 * 멤버가 보낸 변경을 **적용하기 전에** 서버 문서에 대어 보고, 편집기가 만들 수 있는 모양이 아니면 받지 않는다.
 * 규칙은 셋이고 이 순서로 본다.
 *
 * 1. **완결** — Yjs가 이 변경을 전부 곧바로 들일 수 있는가. 들이지 못한 조각·삭제는 서버에 보류됐다가 나중에 남의
 *    변경에 묻어 들어간다(보류 24 — 피해자의 입력이 서버에 닿지 않는다).
 * 2. **구조** — 새 조각마다 놓일 자리와 내용이 편집기가 만드는 것인가(보류 22·23). 속성·마크 값은 정본 검증과
 *    같은 함수로 본다(`nodeAttrProblems`·`markProblems`).
 * 3. **주인** — 새 조각이 든 클라이언트의 주인이 보낸 사람인가(보류 24 — 남의 클라이언트 ID로 먼저 쓰기).
 *
 * **판정만 한다.** 서버 문서를 읽기만 하고 고치지 않는다. 받지 않은 뒤의 일(끊기·기록)과 묶기(`bind`)는 게이트웨이가 한다.
 * 서버가 **이미 아는** 조각은 보지 않는다 — Yjs가 건너뛰고, 접속 직후의 전체 상태 재전송에는 그런 조각이 대부분이다.
 */

export type GateRule = 'structure' | 'complete' | 'owner';
export type GateVerdict = { ok: true; bind: number | null } | { ok: false; rule: GateRule; reason: string };

/** `Y.decodeUpdate`의 결과 — Yjs가 삭제 집합의 타입을 내보내지 않아 반환 타입을 그대로 쓴다 */
type Decoded = ReturnType<typeof Y.decodeUpdate>;
type IdLike = { client: number; clock: number };

/** 들이는 순서를 흉내 낼 조각 하나 — `deps`는 이 조각이 들어가려면 먼저 있어야 하는 ID(이웃·부모) */
export type Pending = { client: number; clock: number; length: number; deps: readonly IdLike[] };

/**
 * **Yjs가 들이는 순서를 흉내 낸다** (D.3). 들이지 못하고 남는 조각을 돌려준다.
 *
 * `known`은 클라이언트마다 이미 있는 시계다(그 시계 **미만**이 있다). 조각은 ① 자기 클라이언트의 시계가 이어지고
 * ② 이웃·부모가 이미 있을 때 들어간다. 더 들일 것이 없을 때까지 돈다 — 이웃이 변경 안에서 뒤에 나와도 들이고,
 * 서로를 기다리는 조각(순환)은 남긴다. **`known`을 제자리에서 고친다** — 다 돈 뒤의 상태로 삭제를 본다.
 */
export function integrable(structs: readonly Pending[], known: Map<number, number>): Pending[] {
  const queues = new Map<number, Pending[]>();
  for (const s of structs) {
    const q = queues.get(s.client);
    if (q) q.push(s);
    else queues.set(s.client, [s]);
  }
  for (const q of queues.values()) q.sort((a, b) => a.clock - b.clock);
  const has = (id: IdLike): boolean => id.clock < (known.get(id.client) ?? 0);
  let progress = true;
  while (progress) {
    progress = false;
    for (const [client, q] of queues) {
      while (q.length) {
        const s = q[0];
        // 시계가 비었다 — 이 클라이언트의 앞선 조각이 없다. 남의 조각으로는 채워지지 않는다
        if (s.clock > (known.get(client) ?? 0)) break;
        if (!s.deps.every(has)) break;
        known.set(client, Math.max(known.get(client) ?? 0, s.clock + s.length));
        q.shift();
        progress = true;
      }
    }
  }
  return [...queues.values()].flat();
}

/** 이름·키는 조작한 클라이언트가 정한다 — 기록이 불어나지 않게 자른다 (D.2) */
const cut = (s: string): string => (s.length > 40 ? `${s.slice(0, 40)}…` : s);
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isId = (v: unknown): v is IdLike => typeof v === 'object' && v !== null && 'client' in v && 'clock' in v;

/** 조각이 놓이는 자리 */
type Place =
  | { kind: 'root'; name: string }
  | { kind: 'element'; name: string }
  | { kind: 'text'; holder: string | null }
  | { kind: 'other'; name: string }
  /** 서버에서 이미 치워진(GC) 조각 옆 — Yjs가 이 조각을 버린다. 보지 않는다 */
  | { kind: 'gone' };
type Located = { place: Place; parentSub: string | null };

/** 편집기가 만들지 않는 타입의 이름. **상속 순서대로** 본다 — XmlHook은 Map을, XmlText는 Text를, XmlElement는 XmlFragment를 잇는다 */
function typeName(t: unknown): string {
  if (t instanceof Y.XmlHook) return 'XmlHook';
  if (t instanceof Y.XmlElement) return 'XmlElement';
  if (t instanceof Y.XmlText) return 'XmlText';
  if (t instanceof Y.XmlFragment) return 'XmlFragment';
  if (t instanceof Y.Text) return 'Text';
  if (t instanceof Y.Map) return 'Map';
  if (t instanceof Y.Array) return 'Array';
  return 'unknown';
}

/** 편집기가 만들지 않는 내용이면 그 이름, 아니면 `null` */
function strangeContent(c: Y.Item['content']): string | null {
  if (c instanceof Y.ContentEmbed) return 'Embed';
  if (c instanceof Y.ContentBinary) return 'Binary';
  if (c instanceof Y.ContentJSON) return 'JSON';
  if (c instanceof Y.ContentDoc) return 'Doc';
  if (c instanceof Y.ContentString || c instanceof Y.ContentFormat || c instanceof Y.ContentAny || c instanceof Y.ContentType || c instanceof Y.ContentDeleted) {
    return null;
  }
  return 'unknown';
}

/** 서버 문서나 변경 안에서 조각을 찾는다. 완결 규칙을 지난 뒤에만 부른다 — 그때는 이웃·부모가 반드시 있다 */
class Lookup {
  private readonly byClient = new Map<number, Y.Item[]>();
  private readonly located = new Map<Y.Item, Located>();

  constructor(
    private readonly doc: Y.Doc,
    fresh: readonly Y.Item[],
  ) {
    for (const s of fresh) {
      const list = this.byClient.get(s.id.client);
      if (list) list.push(s);
      else this.byClient.set(s.id.client, [s]);
    }
    for (const list of this.byClient.values()) list.sort((a, b) => a.id.clock - b.id.clock);
  }

  /** 서버에 있으면 서버의 조각, 아니면 변경 안의 조각 */
  find(id: IdLike): Y.Item | Y.GC | undefined {
    if (id.clock < Y.getState(this.doc.store, id.client)) return Y.getItem(this.doc.store, Y.createID(id.client, id.clock)) as Y.Item | Y.GC;
    const list = this.byClient.get(id.client) ?? [];
    let lo = 0;
    let hi = list.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const s = list[mid];
      if (id.clock < s.id.clock) hi = mid - 1;
      else if (id.clock >= s.id.clock + s.length) lo = mid + 1;
      else return s;
    }
    return undefined;
  }

  /** 들어간 타입(서버 쪽)이 어떤 자리인가 */
  private describeIntegrated(parent: unknown): Place {
    if (parent instanceof Y.AbstractType && parent._item === null) return { kind: 'root', name: Y.findRootTypeKey(parent) };
    if (parent instanceof Y.XmlHook) return { kind: 'other', name: 'XmlHook' };
    if (parent instanceof Y.XmlElement) return { kind: 'element', name: parent.nodeName };
    if (parent instanceof Y.XmlText) {
      const holder = parent._item?.parent;
      return { kind: 'text', holder: holder instanceof Y.XmlElement ? holder.nodeName : null };
    }
    return { kind: 'other', name: typeName(parent) };
  }

  /** 타입을 담은 조각(`ContentType`)이 자식에게 어떤 자리인가 — 서버의 것이든 변경 안의 것이든 */
  private describeHolderItem(item: Y.Item | Y.GC | undefined): Place {
    if (!item || item instanceof Y.GC) return { kind: 'gone' };
    if (!(item.content instanceof Y.ContentType)) return { kind: 'other', name: 'content' };
    const t = item.content.type;
    if (t instanceof Y.XmlHook) return { kind: 'other', name: 'XmlHook' };
    if (t instanceof Y.XmlElement) return { kind: 'element', name: t.nodeName };
    if (t instanceof Y.XmlText) {
      const at = this.locate(item);
      return { kind: 'text', holder: at.place.kind === 'element' ? at.place.name : null };
    }
    return { kind: 'other', name: typeName(t) };
  }

  /**
   * 조각이 놓일 자리 — **Yjs가 적용할 때와 같게** 찾는다. 부모가 적혀 있으면 그것, 없으면 이웃(`origin` → `rightOrigin`)의
   * 부모와 `parentSub`을 물려받는다. 이웃이 치워진(GC) 조각이면 Yjs는 이 조각을 버린다(`gone`).
   * 이웃 사슬이 길 수 있어(큰 붙여 넣기) 재귀하지 않고 따라간다.
   */
  locate(item: Y.Item): Located {
    const cached = this.located.get(item);
    if (cached) return cached;
    const chain: Y.Item[] = [];
    let cur: Y.Item = item;
    let found: Located | undefined;
    for (;;) {
      const hit = this.located.get(cur);
      if (hit) {
        found = hit;
        break;
      }
      // 서버에 이미 들어간 조각은 부모가 풀려 있다
      if (cur.id.clock < Y.getState(this.doc.store, cur.id.client) && !(isId(cur.parent) || typeof cur.parent === 'string' || cur.parent === null)) {
        found = { place: this.describeIntegrated(cur.parent), parentSub: cur.parentSub };
        break;
      }
      chain.push(cur);
      if (typeof cur.parent === 'string') {
        found = { place: { kind: 'root', name: cur.parent }, parentSub: cur.parentSub };
        break;
      }
      if (isId(cur.parent)) {
        found = { place: this.describeHolderItem(this.find(cur.parent)), parentSub: cur.parentSub };
        break;
      }
      const neighborId = cur.origin ?? cur.rightOrigin;
      const neighbor = neighborId ? this.find(neighborId) : undefined;
      if (!neighbor || neighbor instanceof Y.GC) {
        found = { place: { kind: 'gone' }, parentSub: null };
        break;
      }
      cur = neighbor;
    }
    for (const c of chain) this.located.set(c, found);
    return found;
  }
}

/** 새 조각 하나가 편집기가 만드는 것인가. 아니면 그 까닭 */
function structureProblem(item: Y.Item, lookup: Lookup): string | null {
  const c = item.content;
  if (c instanceof Y.ContentDeleted) return null;
  const strange = strangeContent(c);
  if (strange) return `편집기가 만들지 않는 내용 '${strange}'`;
  if (c instanceof Y.ContentType && !(c.type instanceof Y.XmlElement) && !(c.type instanceof Y.XmlText)) {
    return `편집기가 만들지 않는 타입 '${typeName(c.type)}'`;
  }
  const { place, parentSub } = lookup.locate(item);
  if (place.kind === 'gone') return null;
  if (place.kind === 'root' && place.name !== COLLAB_FIELD) return `최상위 타입 '${cut(place.name)}'`;
  const here = place.kind === 'root' ? 'doc' : place.kind === 'element' ? place.name : place.kind === 'text' ? 'text' : place.name;

  // 속성(맵 항목) — 요소에만, 값 하나(`ContentAny`)로
  if (parentSub !== null) {
    if (place.kind === 'text') return '글자 조각에 속성';
    if (place.kind !== 'element') return `'${cut(here)}'에 속성`;
    if (!(c instanceof Y.ContentAny) || c.arr.length !== 1) return `'${cut(here)}'의 속성 자리에 올 수 없는 내용`;
    const problems = nodeAttrProblems(place.name, { [parentSub]: c.arr[0] }, { partial: true });
    return problems.length ? `${problems[0]} (${cut(place.name)})` : null;
  }

  // 목록의 자식
  if (c instanceof Y.ContentType) {
    const child = c.type instanceof Y.XmlText ? 'text' : (c.type as Y.XmlElement).nodeName;
    const kids = place.kind === 'root' || place.kind === 'element' ? (Object.hasOwn(ALLOWED_CHILDREN, here) ? ALLOWED_CHILDREN[here] : []) : [];
    // `text`는 글자(`Y.XmlText`)의 자리다 — 이름이 `text`인 요소가 아니다
    const fits = c.type instanceof Y.XmlText ? kids.includes('text') : child !== 'text' && child !== 'doc' && kids.includes(child);
    return fits ? null : `'${cut(here)}' 안에 올 수 없는 '${cut(child)}'`;
  }
  if (place.kind !== 'text') return `'${cut(here)}' 안에 올 수 없는 ${c instanceof Y.ContentFormat ? '서식' : c instanceof Y.ContentString ? '글자' : '값'}`;
  if (c instanceof Y.ContentString) return null;
  if (c instanceof Y.ContentFormat) {
    // 서식 끝(`null`)은 마크가 아니다
    if (c.value === null) return null;
    if (!isRecord(c.value)) return `마크 '${cut(c.key)}'의 속성은 객체`;
    const problems = markProblems(c.key, c.value);
    if (problems.length) return problems[0].replace(c.key, cut(c.key));
    const holder = place.holder ?? '';
    const allowed = Object.hasOwn(MARKS_IN, holder) ? MARKS_IN[holder] : [];
    return allowed.includes(c.key) ? null : `'${cut(holder)}' 안의 글자는 마크 '${c.key}'를 받지 않는다`;
  }
  return `'text' 안에 올 수 없는 값`;
}

/**
 * 변경 하나를 판정한다 (D.2~D.4). `owners`는 클라이언트 ID → 주인(P8 `owners`를 넓힌 것, D.4).
 * 지나면 `bind`에 **새로 묶을 클라이언트**를 준다 — 새 조각이 든 클라이언트가 하나이고 주인이 없을 때만.
 */
export function inspectUpdate(decoded: Decoded, doc: Y.Doc, sender: string, owners: ReadonlyMap<number, string>): GateVerdict {
  const store = doc.store;
  // 서버가 아직 모르는 조각만 본다 — 일부만 아는 조각도 본다
  const fresh = decoded.structs.filter((s) => !(s instanceof Y.Skip) && s.id.clock + s.length > Y.getState(store, s.id.client)) as (Y.Item | Y.GC)[];

  // 1. 완결 (D.3)
  const known = new Map<number, number>();
  const stateOf = (client: number): void => {
    if (!known.has(client)) known.set(client, Y.getState(store, client));
  };
  const pending: Pending[] = fresh.map((s) => {
    stateOf(s.id.client);
    const deps: IdLike[] = [];
    if (s instanceof Y.Item) {
      for (const d of [s.origin, s.rightOrigin, isId(s.parent) ? s.parent : null]) {
        if (!d) continue;
        stateOf(d.client);
        deps.push(d);
      }
    }
    return { client: s.id.client, clock: s.id.clock, length: s.length, deps };
  });
  if (integrable(pending, known).length) return { ok: false, rule: 'complete', reason: '서버에서 보류될 조각' };
  for (const [client, ranges] of decoded.ds.clients) {
    stateOf(client);
    const upTo = known.get(client) ?? 0;
    if (ranges.some((r) => r.clock + r.len > upTo)) return { ok: false, rule: 'complete', reason: '아직 없는 글자를 지우는 삭제' };
  }

  // 2. 구조 (D.2)
  const items = fresh.filter((s): s is Y.Item => s instanceof Y.Item);
  const lookup = new Lookup(doc, items);
  for (const item of items) {
    const problem = structureProblem(item, lookup);
    if (problem) return { ok: false, rule: 'structure', reason: problem };
  }

  // 3. 주인 (D.4)
  const clients = new Set(fresh.map((s) => s.id.client));
  for (const c of clients) {
    const owner = owners.get(c);
    if (owner !== undefined && owner !== sender) return { ok: false, rule: 'owner', reason: '남의 클라이언트 ID로 쓴 조각' };
  }
  const [only] = clients;
  return { ok: true, bind: clients.size === 1 && owners.get(only) === undefined ? only : null };
}
