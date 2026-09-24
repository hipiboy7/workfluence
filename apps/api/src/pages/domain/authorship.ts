/**
 * 실시간 편집의 **클라이언트 ID → 사용자** 대응표와 **남이 지운 흔적** (A등급, P8_설계서_Mention C.2절).
 *
 * Yjs는 글자마다 그것을 넣은 클라이언트의 ID를 들고 있다. 그 ID가 **누구인지**는 Yjs가 모른다 —
 * 브라우저가 문서를 열 때마다 무작위로 정하는 32비트 수일 뿐이다. 게이트웨이가 연결에서 받은
 * 변경을 보고 이 표를 채운다. 멘션 알림의 "누가 불렀다"가 이 표에서 나온다 (FR-900).
 *
 * **`null`은 "모른다"로 굳은 값이다.** 없는 것(`undefined`)과 다르다 — 없는 ID는 처음 쓰는
 * 사람이 차지하지만, 굳은 ID는 누구도 차지하지 못한다.
 *
 * 여기 있는 것은 판정과 모양뿐이다. 변경을 읽고 DB에 남기는 일은 게이트웨이가 한다.
 */

export type AuthorMap = Map<number, string | null>;
/** 남이 지운 글자의 ID 구간: 클라이언트 → `[clock, len]` (clock 순, 겹치거나 붙은 것은 합친다) */
export type StruckMap = Map<number, [number, number][]>;
export type Attribution = { authors: AuthorMap; struck: StruckMap };
/** 한 클라이언트의 시계 구간 `[from, to)` */
export type ClockRange = { from: number; to: number };

/** 굳힌다. **새로 굳혔으면** `true` */
function freeze(authors: AuthorMap, client: number): boolean {
  if (authors.get(client) === null) return false;
  authors.set(client, null);
  return true;
}

/**
 * 한 연결이 보낸 변경을 적용한 뒤 표를 고친다 (FR-904). **표를 제자리에서 바꾼다.**
 *
 * `sent` — 그 연결이 보낸 변경에 든 클라이언트별 시계 구간 (`Y.parseUpdateMeta`).
 * `integrated` — 그 변경을 적용하는 트랜잭션에서 **실제로 새로 들어간** 구간 (`beforeState` → `afterState`).
 *
 * 1. **보낸 구간 밖까지 들어온 ID는 굳힌다.** Yjs는 앞 조각이 없어 끼우지 못한 조각을 보류해 두었다가
 *    빈자리가 채워질 때 **그 트랜잭션에서** 함께 끼운다. 남이 내 ID로 앞선 시계의 조각을 미리 보내 두면
 *    **내가 평범하게 친 변경에 그 위조가 묻어 들어온다** (P8 자체 점검 1). 보낸 것보다 더 들어왔다는
 *    사실 말고는 그것을 가릴 길이 없다.
 * 2. **여러 ID가 한꺼번에 새로 들어오면 자기 것이 아닌 ID는 굳힌다.** 화면은 자기 ID 하나로만 글을 쓴다.
 *    여럿이 한 번에 들어오는 것은 옛 문서를 쥔 채 새 방에 통째로 보낸 경우이고, 그 안의 남의 조각을
 *    보낸 사람이 차지하면 안 된다 (P8 자체 점검 2).
 * 3. 하나만 들어왔으면: 처음 보는 ID는 그 사용자로 적고, **다른 사람으로 적힌 ID면 굳힌다** —
 *    누가 진짜인지 모르므로 둘 다 쓰지 않는다.
 *
 * 보냈지만 새로 들어가지 않은 ID는 보지 않는다 — 접속 직후의 "내 문서 전체"에는 **남이 쓴 조각이
 * 다 들어 있다.** 그것을 적으면 모든 글자가 방금 들어온 사람의 것이 된다.
 *
 * **이번에 새로 굳힌 ID를 돌려준다.** 정상 사용에서는 거의 생기지 않는 일이라(ID는 무작위 32비트)
 * 생기면 사칭 시도일 수 있다. 게이트웨이가 경고로 남긴다 — 이것이 없으면 그 일은
 * **"알림에 이름이 없다"는 증상 말고는 아무 흔적도 남기지 않는다.**
 */
export function claimAuthors(
  authors: AuthorMap,
  userId: string,
  sent: ReadonlyMap<number, ClockRange>,
  integrated: ReadonlyMap<number, ClockRange>,
): number[] {
  const frozen: number[] = [];
  const covered: number[] = [];
  for (const [client, got] of integrated) {
    const mine = sent.get(client);
    if (mine && mine.from <= got.from && got.to <= mine.to) covered.push(client);
    else if (freeze(authors, client)) frozen.push(client);
  }
  if (covered.length > 1) {
    for (const client of covered) if (authors.get(client) !== userId && freeze(authors, client)) frozen.push(client);
    return frozen;
  }
  for (const client of covered) {
    if (!authors.has(client)) authors.set(client, userId);
    else if (authors.get(client) !== userId && freeze(authors, client)) frozen.push(client);
  }
  return frozen;
}

/**
 * 방을 만들 때 **이미 문서에 있는** 클라이언트 중 표에 없는 것을 `null`로 굳힌다.
 *
 * 정본에서 만든 방의 글자는 서버의 클라이언트 ID로 들어가고, 저장된 상태에서 이은 방에는
 * 표에 없는 옛 ID가 있을 수 있다. 비워 두면 쓰기 권한이 있는 누군가가 그 ID로 조각을 보내
 * **먼저 차지할 수 있다** (C.2절).
 */
export function freezeUnknown(authors: AuthorMap, existing: Iterable<number>): void {
  for (const client of existing) if (!authors.has(client)) authors.set(client, null);
}

/**
 * **남이 지운 흔적**을 적는다 (P8 코드 리뷰 1). 지우는 트랜잭션이 끝나는 순간에 부른다.
 *
 * 지운 글자는 흔적만 남기고 내용이 사라진다. 그런데 **자기가 오타를 지우고 이어 친 것**과
 * **남이 뒷글자를 지워 새 이름을 만든 것**(`@kim.lee` → `@kim`)이 흔적만으로는 똑같이 보인다 —
 * 실측했다 (`P8_검증기록_Mention` 2절). 그래서 지우는 그 순간 **누가 누구의 글자를 지웠는지**를 적는다.
 *
 * 지운 사람이 그 글자의 주인이 아니면 적는다. **지운 사람을 모르거나 글자의 주인을 모르면
 * 남이 지운 것으로 친다** — 모르는 것을 "괜찮다"로 치면 그 틈으로 사칭이 들어온다.
 */
export function recordStruck(struck: StruckMap, authors: AuthorMap, deleterId: string | null, deleted: Iterable<[number, number, number]>): void {
  for (const [client, clock, len] of deleted) {
    if (len <= 0) continue;
    const owner = authors.get(client);
    if (deleterId !== null && owner === deleterId) continue;
    const list = struck.get(client) ?? [];
    list.push([clock, len]);
    list.sort((x, y) => x[0] - y[0]);
    // 겹치거나 붙은 구간을 합친다 — 표가 지운 글자 수만큼 자라지 않게
    const merged: [number, number][] = [];
    for (const [c, l] of list) {
      const last = merged[merged.length - 1];
      if (last && c <= last[0] + last[1]) last[1] = Math.max(last[1], c + l - last[0]);
      else merged.push([c, l]);
    }
    struck.set(client, merged);
  }
}

/** `[clock, clock+len)` 중 **한 글자라도** 남이 지운 것인가 */
export function isStruck(struck: StruckMap, client: number, clock: number, len: number): boolean {
  const list = struck.get(client);
  if (!list) return false;
  return list.some(([c, l]) => c < clock + len && clock < c + l);
}

/** `page_realtime.authors`에 넣는 모양. JSON 키는 문자열이다 */
export function attributionToJson(a: Attribution): { clients: Record<string, string | null>; struck: Record<string, [number, number][]> } {
  return {
    clients: Object.fromEntries([...a.authors.entries()].map(([k, v]) => [String(k), v])),
    struck: Object.fromEntries([...a.struck.entries()].map(([k, v]) => [String(k), v.map(([c, l]) => [c, l] as [number, number])])),
  };
}

const CLIENT_ID = /^(0|[1-9]\d{0,9})$/;
const MAX_CLIENT_ID = 0xffff_ffff;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function clientKey(k: string): number | null {
  if (!CLIENT_ID.test(k)) return null;
  const n = Number(k);
  return n > MAX_CLIENT_ID ? null : n;
}

const empty = (): Attribution => ({ authors: new Map(), struck: new Map() });
const isObject = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);

/**
 * DB에서 읽은 값을 표로.
 *
 * **사용자 항목은 모양이 맞지 않는 것만 버린다.** 버린 ID는 방을 만들 때 `freezeUnknown`이
 * `null`로 굳힌다 — 잃는 것은 "그 글자를 누가 쳤나"뿐이다.
 *
 * **지운 흔적은 하나라도 깨져 있으면 표 전체를 버린다.** 흔적을 잊으면 "남이 지웠다"를
 * "괜찮다"로 읽게 되어 사칭이 통한다. 전체를 버리면 모든 ID가 "모름"으로 굳어 안전한 쪽으로 간다.
 */
export function attributionFromJson(raw: unknown): Attribution {
  if (!isObject(raw) || !isObject(raw.clients) || !isObject(raw.struck)) return empty();
  const out = empty();
  for (const [k, list] of Object.entries(raw.struck)) {
    const client = clientKey(k);
    if (client === null || !Array.isArray(list)) return empty();
    const ranges: [number, number][] = [];
    for (const r of list) {
      if (!Array.isArray(r) || r.length !== 2 || !r.every((x) => Number.isSafeInteger(x)) || r[0] < 0 || r[1] <= 0) return empty();
      ranges.push([r[0] as number, r[1] as number]);
    }
    out.struck.set(client, ranges);
  }
  for (const [k, v] of Object.entries(raw.clients)) {
    const client = clientKey(k);
    if (client === null) continue;
    if (v === null) out.authors.set(client, null);
    else if (typeof v === 'string' && UUID.test(v)) out.authors.set(client, v);
  }
  return out;
}
