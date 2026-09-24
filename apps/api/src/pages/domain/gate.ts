import { ALLOWED_CHILDREN, MARKS_IN, MAX_DOCUMENT_DEPTH, markProblems, nodeAttrProblems } from '@workfluence/shared';
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
  const state = (client: number): number => known.get(client) ?? 0;
  // 대기열마다 **어디까지 들였나**만 센다
  const next = new Map<number, number>([...queues.keys()].map((c) => [c, 0]));
  // **기다리는 것이 풀릴 때만 깨운다** (P9 코드 리뷰 2). 전에는 한 바퀴에 하나씩 들이며 모든 대기열을 다시 돌아, 서로를
  // 거꾸로 기다리는 클라이언트 n개가 n²번 돌았다(2만 개 → 45초, 그동안 서버의 다른 일이 모두 멈췄다). 이제 조각마다
  // 모자란 의존성 하나에 줄을 서고, 그 클라이언트의 시계가 거기를 넘으면 깨어난다 — 줄은 필요한 시계가 작은 것부터 꺼낸다
  const waiting = new Map<number, MinHeap>();
  const ready: number[] = [...queues.keys()];
  const wake = (client: number): void => {
    const heap = waiting.get(client);
    if (!heap) return;
    const upTo = state(client);
    while (heap.size && heap.peekKey() < upTo) ready.push(heap.pop());
    if (!heap.size) waiting.delete(client);
  };
  while (ready.length) {
    const client = ready.pop()!;
    const q = queues.get(client)!;
    let i = next.get(client)!;
    let moved = false;
    while (i < q.length) {
      const s = q[i];
      // 시계가 비었다 — 이 클라이언트의 앞선 조각이 없다. 남의 조각으로는 채워지지 않는다
      if (s.clock > state(client)) break;
      const missing = s.deps.find((d) => d.clock >= state(d.client));
      if (missing) {
        let heap = waiting.get(missing.client);
        if (!heap) waiting.set(missing.client, (heap = new MinHeap()));
        heap.push(missing.clock, client);
        break;
      }
      known.set(client, Math.max(state(client), s.clock + s.length));
      i += 1;
      moved = true;
    }
    next.set(client, i);
    if (moved) wake(client);
  }
  return [...queues].flatMap(([client, q]) => q.slice(next.get(client)!));
}

/** 필요한 시계가 작은 것부터 꺼내는 대기열 (키 = 기다리는 시계, 값 = 기다리는 클라이언트) */
class MinHeap {
  private readonly keys: number[] = [];
  private readonly values: number[] = [];

  get size(): number {
    return this.keys.length;
  }

  peekKey(): number {
    return this.keys[0];
  }

  push(key: number, value: number): void {
    let i = this.keys.length;
    this.keys.push(key);
    this.values.push(value);
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.keys[parent] <= key) break;
      this.keys[i] = this.keys[parent];
      this.values[i] = this.values[parent];
      i = parent;
    }
    this.keys[i] = key;
    this.values[i] = value;
  }

  pop(): number {
    const top = this.values[0];
    const lastKey = this.keys.pop()!;
    const lastValue = this.values.pop()!;
    const n = this.keys.length;
    if (n) {
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        if (l >= n) break;
        const r = l + 1;
        const c = r < n && this.keys[r] < this.keys[l] ? r : l;
        if (this.keys[c] >= lastKey) break;
        this.keys[i] = this.keys[c];
        this.values[i] = this.values[c];
        i = c;
      }
      this.keys[i] = lastKey;
      this.values[i] = lastValue;
    }
    return top;
  }
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
/** `holder` — 부모 타입을 담은 조각. 최상위면 `null`. 깊이를 셀 때 이것을 따라 올라간다 */
type Located = { place: Place; parentSub: string | null; holder: Y.Item | null };

/**
 * 편집기가 만들지 않는 타입의 이름. **상속 순서대로** 본다 — XmlHook은 Map을 잇는다. 편집기가 만드는 둘(`XmlElement`·`XmlText`,
 * 각각 XmlFragment·Text를 잇는다)은 부르는 쪽이 먼저 거른다
 */
function typeName(t: unknown): string {
  if (t instanceof Y.XmlHook) return 'XmlHook';
  if (t instanceof Y.XmlFragment) return 'XmlFragment';
  if (t instanceof Y.Text) return 'Text';
  if (t instanceof Y.Map) return 'Map';
  if (t instanceof Y.Array) return 'Array';
  return 'unknown';
}

/** 편집기가 만들지 않는 내용이면 그 이름, 아니면 `null`. 지운 조각(`ContentDeleted`)은 부르는 쪽이 먼저 거른다 */
function strangeContent(c: Y.Item['content']): string | null {
  if (c instanceof Y.ContentString || c instanceof Y.ContentFormat || c instanceof Y.ContentAny || c instanceof Y.ContentType) return null;
  if (c instanceof Y.ContentEmbed) return 'Embed';
  if (c instanceof Y.ContentBinary) return 'Binary';
  if (c instanceof Y.ContentDoc) return 'Doc';
  // 남은 것은 옛 인코딩의 `ContentJSON`이다 (Yjs 13의 내용은 이 아홉이 전부다)
  return 'JSON';
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

  /** 서버에 이미 들어간 조각인가 — 부모가 풀려 있다(타입). 변경 안의 조각은 부모가 ID·이름·없음이다 */
  private integrated(item: Y.Item): boolean {
    return item.id.clock < Y.getState(this.doc.store, item.id.client) && !(isId(item.parent) || typeof item.parent === 'string' || item.parent === null);
  }

  /**
   * 조각이 나타내는 노드의 **깊이** — 정본 JSON에서의 깊이와 같다(문서 0, 맨 위 블록 1, 그 안 2 …). 부모를 담은 조각을 따라
   * 최상위까지 올라간다. 한도를 넘으면 더 세지 않는다 (P9 코드 리뷰 3·자체 점검 1)
   */
  depthOf(item: Y.Item): number {
    let depth = 0;
    let cur: Y.Item | null = item;
    while (cur && depth <= MAX_DOCUMENT_DEPTH) {
      depth += 1;
      cur = this.integrated(cur) ? ((cur.parent as Y.AbstractType<unknown>)._item ?? null) : this.locate(cur).holder;
    }
    return depth;
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
    // **타입을 담지 않은 부모**(지워져 내용이 치워진 요소 — `ContentDeleted`)면 Yjs는 부모를 찾지 못해 이 조각을 버린다
    // (`Item.getMissing` → `parent = content.type` = 없음). 지워진 빈 문단 안에 막 첫 글자를 친 동료의 정상 편집이 이 모양이라,
    // 보지 않는다 — 전에는 거절해 그 사람을 끊었다 (P9 코드 리뷰 1)
    if (!(item.content instanceof Y.ContentType)) return { kind: 'gone' };
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
      if (this.integrated(cur)) {
        const parent = cur.parent as Y.AbstractType<unknown>;
        found = { place: this.describeIntegrated(parent), parentSub: cur.parentSub, holder: parent._item };
        break;
      }
      chain.push(cur);
      if (typeof cur.parent === 'string') {
        found = { place: { kind: 'root', name: cur.parent }, parentSub: cur.parentSub, holder: null };
        break;
      }
      if (isId(cur.parent)) {
        const holder = this.find(cur.parent);
        found = { place: this.describeHolderItem(holder), parentSub: cur.parentSub, holder: holder instanceof Y.Item ? holder : null };
        break;
      }
      const neighborId = cur.origin ?? cur.rightOrigin;
      const neighbor = neighborId ? this.find(neighborId) : undefined;
      if (!neighbor || neighbor instanceof Y.GC) {
        found = { place: { kind: 'gone' }, parentSub: null, holder: null };
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
    if (!fits) return `'${cut(here)}' 안에 올 수 없는 '${cut(child)}'`;
    // **깊이도 정본 검증과 같게 본다.** 자리마다 맞는 인용을 65겹 쌓으면 관문은 지나도 저장이 영영 멈췄다 (P9 코드 리뷰 3)
    return lookup.depthOf(item) > MAX_DOCUMENT_DEPTH ? `중첩 깊이 ${MAX_DOCUMENT_DEPTH} 초과` : null;
  }
  if (place.kind !== 'text') return `'${cut(here)}' 안에 올 수 없는 ${c instanceof Y.ContentFormat ? '서식' : c instanceof Y.ContentString ? '글자' : '값'}`;
  if (c instanceof Y.ContentString) return null;
  if (c instanceof Y.ContentFormat) {
    // 서식 끝(`null`)은 마크가 아니다
    if (c.value === null) return null;
    if (!isRecord(c.value)) return `마크 '${cut(c.key)}'의 속성은 객체`;
    const problems = markProblems(c.key, c.value);
    if (problems.length) return problems[0];
    const holder = place.holder ?? '';
    const allowed = Object.hasOwn(MARKS_IN, holder) ? MARKS_IN[holder] : [];
    return allowed.includes(c.key) ? null : `'${cut(holder)}' 안의 글자는 마크 '${c.key}'를 받지 않는다`;
  }
  return `'text' 안에 올 수 없는 값`;
}

/** 인코딩된 변경의 맨 앞 숫자 — 클라이언트 덩어리 수 (Yjs 1판 인코딩, `readClientsStructRefs`) */
function blockCount(encoded: Uint8Array): number {
  let n = 0;
  let mult = 1;
  // 읽을 수 있었던 변경에만 부른다 — 숫자를 끝내는 바이트(0x80 미만)가 반드시 있다
  for (const b of encoded) {
    n += (b & 0x7f) * mult;
    if (b < 0x80) break;
    mult *= 128;
  }
  return n;
}

/**
 * **클라이언트마다 한 덩어리인가.** `Y.decodeUpdate`는 덩어리를 전부 돌려주지만 `Y.applyUpdate`는 같은 클라이언트의 **마지막
 * 덩어리만** 들인다 — 되풀이된 변경이면 관문이 본 조각과 Yjs가 들이는 조각이 달라진다 (P9 보안 검토 2). 정상 인코더는 클라이언트마다
 * 한 덩어리로 쓴다. 떨어져 다시 나오는 것은 풀어 낸 조각만으로 알고, 붙어 되풀이된 것은 인코딩의 덩어리 수와 대조해 안다.
 */
function repeatsClient(decoded: Decoded, encoded?: Uint8Array): boolean {
  const seen = new Set<number>();
  let current: number | null = null;
  let runs = 0;
  for (const s of decoded.structs) {
    const c = s.id.client;
    if (c === current) continue;
    if (seen.has(c)) return true;
    seen.add(c);
    current = c;
    runs += 1;
  }
  return encoded !== undefined && blockCount(encoded) !== runs;
}

/**
 * 변경 하나를 판정한다 (D.2~D.4). `owners`는 클라이언트 ID → 주인(P8 `owners`를 넓힌 것, D.4). `encoded`는 그 변경의 바이트다 —
 * 주면 클라이언트 덩어리 수까지 대조한다(게이트웨이는 늘 준다).
 * 지나면 `bind`에 **새로 묶을 클라이언트**를 준다 — 새 조각이 든 클라이언트가 하나이고 주인이 없을 때만.
 */
export function inspectUpdate(decoded: Decoded, doc: Y.Doc, sender: string, owners: ReadonlyMap<number, string>, encoded?: Uint8Array): GateVerdict {
  const store = doc.store;
  if (repeatsClient(decoded, encoded)) return { ok: false, rule: 'structure', reason: '같은 클라이언트가 두 번 나온 변경' };
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
    const upTo = known.get(client)!;
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
