/**
 * 멘션을 **만든** 사람 (A등급, P8_설계서_Mention C.2절, FR-900·904·907).
 *
 * 멘션 하나를 **`@` 글자의 ID + 이름**(`Site`)으로 가린다. 게이트웨이는 멤버의 변경이 끝날 때마다 문서의
 * 멘션 자리를 다시 훑어 장부(`Ledger`)를 고친다(`advance`). 새로 생긴 자리의 주인은 **그 변경을 보낸
 * 연결의 사용자 M**이다 — 다만 아래가 모두 참일 때만이고, 하나라도 아니면 모름이다.
 *
 * 1. 그 변경이 **보낸 것만큼만** 문서를 바꿨다 (`isFaithful`) — 보류된 위조가 묻어 들어오지 않았다
 * 2. `@`부터 이름 끝까지 **모든 글자를 M의 연결이 들여왔다** (`delivered`) — 남의 글을 내 공백 하나가
 *    멘션으로 완성하거나, 내 글을 남의 삭제가 멘션으로 만든 것이 아니다
 * 3. 다음 저장 전까지 **같은 이름이 남의 것으로 사라진 적이 없다** (`gone`) — 남의 멘션을 옮긴 것이 아니다
 *
 * **믿는 것은 서버가 직접 본 사실뿐이다** — 어느 연결이 어떤 변경을 보냈고 무엇을 들여왔나. 글자의 클라이언트
 * ID, Yjs가 적어 둔 이웃(`origin`·`rightOrigin`), 지운 흔적은 **전부 클라이언트가 정하는 값**이라 믿지 않는다.
 * 앞의 세 판은 그 값을 믿거나(첫 판·둘째 판) "생기게 한 변경"만 봤다가(셋째 판) 검토에서 뚫렸다
 * (`docs/internal/P8_검토서_Review.md`).
 *
 * 여기 있는 것은 판정과 모양뿐이다. 문서를 훑고 DB에 남기는 일은 게이트웨이가 한다.
 */

/** 멘션 자리. `key`는 `@` 글자의 Yjs ID(`client:clock`), `span`은 `@`부터 이름 끝까지 글자의 `[client, clock]` */
export type Site = { key: string; name: string; span: readonly (readonly [number, number])[] };
/** `key|name` → 그 멘션을 만든 사람. `null`은 모름 */
export type MakerMap = Map<string, string | null>;
/** 어느 연결이 어느 조각 구간을 들여왔나: 클라이언트 → `[from, to, userId | null]` (from 순, 같은 사람의 붙은 구간은 합친다) */
export type Delivered = Map<number, [number, number, string | null][]>;
/**
 * 장부. `gone`은 **다음 저장 전까지** 사라진 이름과 그 멘션을 만든 사람들이다 — 옮김을 가리는 데 쓴다.
 * 저장이 끝나면 비운다(`settle`). 저장된 멘션은 직전 버전에 있어 다시 알림이 되지 않는다.
 */
export type Ledger = { makers: MakerMap; delivered: Delivered; gone: Map<string, (string | null)[]> };
/** 한 클라이언트의 시계 구간 `[from, to)` */
export type ClockRange = { from: number; to: number };
/** 한 연결이 보낸 변경에 든 것: 클라이언트별 조각 구간과 삭제 구간(`[clock, len]`) */
export type SentChange = { structs: ReadonlyMap<number, ClockRange>; deletes: ReadonlyMap<number, readonly [number, number][]> };
/** 그 트랜잭션에서 지워진 조각. `parent`는 그 조각이 든 타입의 조각 ID(`client:clock`), 문서 최상위면 `null` */
export type DeletedItem = { client: number; clock: number; len: number; parent: string | null };

export const emptyLedger = (): Ledger => ({ makers: new Map(), delivered: new Map(), gone: new Map() });

const siteId = (s: Site): string => `${s.key}|${s.name}`;
const splitId = (id: string): [string, string] => {
  const bar = id.indexOf('|');
  return [id.slice(0, bar), id.slice(bar + 1)];
};

/** `[from, to)`를 `who`가 들여왔다고 적는다. **제자리에서 바꾼다.** 같은 사람의 붙은 구간은 합친다 */
export function recordDelivered(delivered: Delivered, client: number, range: ClockRange, who: string | null): void {
  if (range.to <= range.from) return;
  const list = delivered.get(client) ?? [];
  const tail = list[list.length - 1];
  if (tail && tail[1] === range.from && tail[2] === who) tail[1] = range.to;
  else {
    list.push([range.from, range.to, who]);
    list.sort((a, b) => a[0] - b[0]);
  }
  delivered.set(client, list);
}

/** 그 글자를 들여온 사람. 모르면 `null` */
export function deliveredBy(delivered: Delivered, client: number, clock: number): string | null {
  for (const [from, to, who] of delivered.get(client) ?? []) if (from <= clock && clock < to) return who;
  return null;
}

/**
 * **그 연결이 만든 클라이언트**를 기억한다 (P8 세 번째 코드 리뷰 3). **제자리에서 바꾼다.**
 *
 * 화면은 자기 클라이언트 ID 하나로만 글자를 만들고, 그 클라이언트의 첫 글자는 시계 0이다. 그래서 **한 클라이언트만,
 * 시계 0부터** 새로 들어온 변경은 그 연결이 만든 것이다. 그 밖의 들여옴 — 남의 클라이언트를 이어 보낸 것, 옛 문서를
 * 통째로 다시 보내 여러 클라이언트가 한꺼번에 들어온 것 — 은 그 연결이 쓴 글자로 치지 않는다.
 */
export function claimOwn(own: Set<number>, integrated: ReadonlyMap<number, ClockRange>): void {
  if (integrated.size !== 1) return;
  const [[client, range]] = [...integrated];
  if (range.from === 0) own.add(client);
}

/** 겹치거나 붙은 구간을 합친다 */
function merge(ranges: readonly (readonly [number, number])[]): [number, number][] {
  const out: [number, number][] = [];
  for (const [c, l] of [...ranges].sort((a, b) => a[0] - b[0])) {
    const tail = out[out.length - 1];
    if (tail && c <= tail[0] + tail[1]) tail[1] = Math.max(tail[1], c + l - tail[0]);
    else out.push([c, l]);
  }
  return out;
}

/**
 * 그 변경이 **보낸 것만큼만** 문서를 바꿨나 (FR-904, P8 자체 점검 1 · 두 번째 검토 1 · 세 번째 코드 리뷰 4).
 *
 * Yjs는 앞 조각이 없어 끼우지 못한 조각과, 지울 글자가 아직 없는 삭제를 **보류해 두었다가 빈자리가 채워지는
 * 변경에서 함께 적용한다.** 남이 내 ID로 앞선 시계의 조각이나 삭제를 미리 보내 두면, 내가 평범하게 친 변경에서
 * **그 위조가 함께 일어난다** — 그 결과로 생긴 멘션을 내 이름으로 적으면 안 된다.
 *
 * - 새로 들어간 조각은 전부 **보낸 조각 구간 안**이어야 한다.
 * - 지워진 조각은 전부 **설명돼야** 한다. 설명되는 것은 둘이다: 보낸 삭제 구간 안, 그리고 **부모가 이 변경에서
 *   지워졌고 그 부모의 삭제가 설명되는** 조각(문단을 지우면 남이 방금 친 글자까지 딸려 지워진다 — 지운 사람은 그
 *   글자를 몰랐다).
 * - **"이 변경에서 들어와 곧바로 지워진 조각"은 설명으로 치지 않는다.** 보류 삭제 위조가 바로 그 모양이다 —
 *   내가 친 글자가 들어오는 순간 남이 미리 보내 둔 삭제가 그것을 지운다. 정상적으로 들어오자마자 지워지는 것은
 *   같은 속성을 둘이 동시에 바꿀 때 진 쪽 값뿐이고, 그것은 속성 값(맵 항목)이라 부르는 쪽이 넘기지 않는다.
 *   이미 지워진 문단 안으로 들어온 글자는 삭제로 나타나지 않는다(부모가 GC돼 있어 GC 조각으로 들어온다) — 실측.
 *
 * 부르는 쪽은 서식 조각과 속성 값(맵 항목)을 넘기지 않는다 — 글자를 바꾸지 않는다.
 */
export function isFaithful(sent: SentChange, integrated: ReadonlyMap<number, ClockRange>, deleted: readonly DeletedItem[]): boolean {
  for (const [client, got] of integrated) {
    const mine = sent.structs.get(client);
    if (!mine || got.from < mine.from || got.to > mine.to) return false;
  }
  const sentDeletes = new Map<number, [number, number][]>();
  const inSentDeletes = (d: DeletedItem): boolean => {
    if (!sentDeletes.has(d.client)) sentDeletes.set(d.client, merge(sent.deletes.get(d.client) ?? []));
    return sentDeletes.get(d.client)!.some(([c, l]) => c <= d.clock && d.clock + d.len <= c + l);
  };
  const byKey = new Map(deleted.map((d) => [`${d.client}:${d.clock}`, d]));
  const memo = new Map<DeletedItem, boolean>();
  const explained = (d: DeletedItem, depth: number): boolean => {
    const known = memo.get(d);
    if (known !== undefined) return known;
    let ok = inSentDeletes(d);
    const parent = d.parent === null ? undefined : byKey.get(d.parent);
    if (!ok && parent && depth < deleted.length) ok = explained(parent, depth + 1);
    memo.set(d, ok);
    return ok;
  };
  return deleted.every((d) => explained(d, 0));
}

/**
 * 변경 하나를 적용한 뒤의 장부. 앞의 장부는 바꾸지 않는다(들여온 기록 `delivered`는 함께 쓴다).
 *
 * - **있던 자리는 그대로다.** 남이 다른 곳을 고쳐도, 서식을 걸었다 풀어도 그 멘션의 주인은 바뀌지 않는다.
 * - **사라진 자리는 표에서 빼고 `gone`에 적는다.** 다만 같은 `@`의 이름이 **자라기만** 했으면(`@kim` → `@kiml`)
 *   적지 않는다 — 치는 동안의 중간 이름이다.
 * - **새 자리는 `maker`**(그 변경을 보낸 사람, 믿을 수 없으면 `null`)다. 글자를 전부 그 사람이 들여왔고,
 *   같은 이름이 남의 것으로 사라진 적이 없을 때만이다. 아니면 모름.
 */
export function advance(ledger: Ledger, sites: readonly Site[], maker: string | null): Ledger {
  const present = new Set(sites.map(siteId));
  const namesAt = new Map<string, string[]>();
  for (const s of sites) {
    const list = namesAt.get(s.key);
    if (list) list.push(s.name);
    else namesAt.set(s.key, [s.name]);
  }
  const gone = new Map([...ledger.gone].map(([name, who]) => [name, [...who]]));
  for (const [id, who] of ledger.makers) {
    if (present.has(id)) continue;
    const [key, name] = splitId(id);
    const grew = (namesAt.get(key) ?? []).some((n) => n !== name && n.startsWith(name));
    if (grew) continue;
    const list = gone.get(name);
    if (list) list.push(who);
    else gone.set(name, [who]);
  }
  const makers: MakerMap = new Map();
  for (const s of sites) {
    const id = siteId(s);
    if (makers.has(id)) continue;
    if (ledger.makers.has(id)) {
      makers.set(id, ledger.makers.get(id) ?? null);
      continue;
    }
    let who = maker;
    if (who !== null && !s.span.every(([c, k]) => deliveredBy(ledger.delivered, c, k) === who)) who = null;
    const lost = gone.get(s.name);
    if (who !== null && lost && !lost.every((w) => w === who)) who = null;
    makers.set(id, who);
  }
  return { makers, delivered: ledger.delivered, gone };
}

/** 저장이 끝났다 — 옮김을 가리려고 들고 있던 `gone`을 비운다 */
export function settle(ledger: Ledger): Ledger {
  return { makers: ledger.makers, delivered: ledger.delivered, gone: new Map() };
}

/** 이름마다, **나온 곳마다** 만든 사람 (문서 순서). 표에 없는 자리는 모름이다 */
export function makersFor(makers: ReadonlyMap<string, string | null>, sites: readonly Site[]): Map<string, (string | null)[]> {
  const out = new Map<string, (string | null)[]>();
  for (const s of sites) {
    const who = makers.get(siteId(s)) ?? null;
    const list = out.get(s.name);
    if (list) list.push(who);
    else out.set(s.name, [who]);
  }
  return out;
}

/** `page_realtime.authors`에 넣는 모양 */
export function ledgerToJson(ledger: Ledger): {
  makers: [number, number, string, string | null][];
  delivered: [number, number, number, string | null][];
  gone: [string, (string | null)[]][];
} {
  return {
    makers: [...ledger.makers.entries()].map(([id, who]) => {
      const [key, name] = splitId(id);
      const [client, clock] = key.split(':').map(Number);
      return [client, clock, name, who];
    }),
    delivered: [...ledger.delivered.entries()].flatMap(([client, list]) => list.map(([from, to, who]) => [client, from, to, who] as [number, number, number, string | null])),
    gone: [...ledger.gone.entries()].map(([name, who]) => [name, [...who]]),
  };
}

const MAX_CLIENT_ID = 0xffff_ffff;
/** `usernameSchema`와 같은 규칙 — 멘션 후보 이름이 이것을 지난다 (`mention.ts`) */
const USERNAME = /^[a-z0-9._-]{2,64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isClient = (x: unknown): x is number => Number.isSafeInteger(x) && (x as number) >= 0 && (x as number) <= MAX_CLIENT_ID;
const isClock = (x: unknown): x is number => Number.isSafeInteger(x) && (x as number) >= 0;
const isWho = (x: unknown): x is string | null => x === null || (typeof x === 'string' && UUID.test(x));

/**
 * DB에서 읽은 값을 장부로. **모양이 맞지 않는 항목은 버린다.**
 *
 * 버린 자리·구간은 "모름"이 된다 — 잃는 것은 "그 멘션을 누가 만들었나"뿐이고, 믿지 못할 값을 사람 이름으로
 * 쓰는 쪽이 더 나쁘다. 파생 데이터다.
 */
export function ledgerFromJson(raw: unknown): Ledger {
  const out = emptyLedger();
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  const { makers, delivered, gone } = raw as { makers?: unknown; delivered?: unknown; gone?: unknown };
  for (const e of Array.isArray(makers) ? makers : []) {
    if (!Array.isArray(e) || e.length !== 4) continue;
    const [client, clock, name, who] = e as unknown[];
    if (!isClient(client) || !isClock(clock) || typeof name !== 'string' || !USERNAME.test(name) || !isWho(who)) continue;
    out.makers.set(`${client}:${clock}|${name}`, who);
  }
  for (const e of Array.isArray(delivered) ? delivered : []) {
    if (!Array.isArray(e) || e.length !== 4) continue;
    const [client, from, to, who] = e as unknown[];
    if (!isClient(client) || !isClock(from) || !isClock(to) || to <= from || !isWho(who)) continue;
    recordDelivered(out.delivered, client, { from, to }, who);
  }
  for (const e of Array.isArray(gone) ? gone : []) {
    if (!Array.isArray(e) || e.length !== 2) continue;
    const [name, who] = e as unknown[];
    if (typeof name !== 'string' || !USERNAME.test(name) || !Array.isArray(who) || !who.every(isWho)) continue;
    out.gone.set(name, [...(who as (string | null)[])]);
  }
  return out;
}
