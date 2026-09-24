/**
 * 멘션을 **생기게 한** 사람 (A등급, P8_설계서_Mention C.2절, FR-900·904·907).
 *
 * 멘션 하나를 **`@` 글자의 ID + 이름**(`Site`)으로 가린다. 게이트웨이는 멤버의 변경이 적용될 때마다 문서의
 * 멘션 자리를 다시 훑고, **그 변경으로 새로 생긴 자리**에 그 멤버를 적는다(`advanceMakers`).
 *
 * **왜 이렇게 하나.** 첫 판은 저장할 때 글자의 클라이언트 ID·Yjs가 적어 둔 이웃(`origin`·`rightOrigin`)·
 * 삭제 흔적을 보고 "누가 만들었나"를 거꾸로 추론했다. 그런데 그 값들은 **전부 클라이언트가 정한다.** 검토 두
 * 번이 여섯 가지 우회(지우기·끼워 넣기·보류 조각·보류 삭제·이웃 위조·흔적 앞 끼우기)와 정상 사용의 오판을
 * 찾았다 (`docs/internal/P8_검토서_Review.md`). 이 방식은 **인증된 연결**만 믿는다 — 이름이 붙을 수 있는
 * 사람은 **자기 연결로 그 멘션을 만든 사람뿐**이다.
 *
 * 여기 있는 것은 판정과 모양뿐이다. 문서를 훑고 DB에 남기는 일은 게이트웨이가 한다.
 */

/** 멘션 자리. `key`는 `@` 글자의 Yjs ID(`client:clock`) — 앞에 누가 치기만 해도 바뀌는 위치가 아니다 */
export type Site = { key: string; name: string };
/** `key|name` → 그 멘션을 만든 사람. `null`은 모름 */
export type MakerMap = Map<string, string | null>;
/** 한 클라이언트의 시계 구간 `[from, to)` */
export type ClockRange = { from: number; to: number };
/** 한 연결이 보낸 변경에 든 것: 클라이언트별 조각 구간과 삭제 구간(`[clock, len]`) */
export type SentChange = { structs: ReadonlyMap<number, ClockRange>; deletes: ReadonlyMap<number, readonly [number, number][]> };

const siteId = (s: Site): string => `${s.key}|${s.name}`;
const nameOf = (id: string): string => id.slice(id.indexOf('|') + 1);

/**
 * 변경 하나를 적용한 뒤의 표 (FR-900·907). 앞의 표는 바꾸지 않는다.
 *
 * - **있던 자리는 그대로다.** 남이 다른 곳을 고쳐도, 서식을 걸었다 풀어도 그 멘션의 주인은 바뀌지 않는다.
 * - **사라진 자리는 지운다.** 다시 생기면 그때 만든 사람이 만든 것이다. U가 `@kim.lee`를 친 뒤 X가 `.lee`를
 *   지워 `@kim`이 생기면 **X가 만든 것**이다 — U가 치는 동안 잠깐 있던 `@kim`은 이미 사라졌다.
 * - **새 자리는 이 변경을 보낸 사람**(`maker`)이다. 믿을 수 없는 변경이면 `maker`가 `null`이고 모름이 된다.
 * - **같은 변경에서 같은 이름이 사라지고 생기면 옮긴 것이다.** 편집기는 문단을 제목으로 바꾸거나 목록으로
 *   감쌀 때 글자를 새로 만든다. 사라진 쪽이 전부 이 사람이 만든 것이면 그대로 이 사람, 아니면 **모름**이다 —
 *   남의 멘션을 옮긴 사람이 부른 것도 아니고, 원래 사람의 이름을 옮겨 붙이는 길을 열어 두지도 않는다.
 */
export function advanceMakers(prev: ReadonlyMap<string, string | null>, sites: readonly Site[], maker: string | null): MakerMap {
  const present = new Set(sites.map(siteId));
  const gone = new Map<string, (string | null)[]>();
  for (const [id, who] of prev) {
    if (present.has(id)) continue;
    const name = nameOf(id);
    gone.set(name, [...(gone.get(name) ?? []), who]);
  }
  const next: MakerMap = new Map();
  for (const s of sites) {
    const id = siteId(s);
    if (next.has(id)) continue;
    if (prev.has(id)) {
      next.set(id, prev.get(id) ?? null);
      continue;
    }
    const lost = gone.get(s.name);
    next.set(id, lost ? (maker !== null && lost.every((w) => w === maker) ? maker : null) : maker);
  }
  return next;
}

/** 이름마다, **나온 곳마다** 만든 사람 (문서 순서). 표에 없는 자리는 모름이다 */
export function makersFor(makers: ReadonlyMap<string, string | null>, sites: readonly Site[]): Map<string, (string | null)[]> {
  const out = new Map<string, (string | null)[]>();
  for (const s of sites) out.set(s.name, [...(out.get(s.name) ?? []), makers.get(siteId(s)) ?? null]);
  return out;
}

/** 겹치거나 붙은 구간을 합친다 */
function merge(ranges: readonly [number, number][]): [number, number][] {
  const out: [number, number][] = [];
  for (const [c, l] of [...ranges].sort((a, b) => a[0] - b[0])) {
    const tail = out[out.length - 1];
    if (tail && c <= tail[0] + tail[1]) tail[1] = Math.max(tail[1], c + l - tail[0]);
    else out.push([c, l]);
  }
  return out;
}

/**
 * 그 변경이 **보낸 것만큼만** 문서를 바꿨나 (FR-904, P8 자체 점검 1 · 두 번째 검토 1).
 *
 * Yjs는 앞 조각이 없어 끼우지 못한 조각과, 지울 글자가 아직 없는 삭제를 **보류해 두었다가 빈자리가 채워지는
 * 변경에서 함께 적용한다.** 남이 내 ID로 앞선 시계의 조각이나 삭제를 미리 보내 두면, 내가 평범하게 친 변경에서
 * **그 위조가 함께 일어난다** — 그 결과로 생긴 멘션을 내 이름으로 적으면 안 된다.
 *
 * - `integrated` — 그 트랜잭션에서 실제로 새로 들어간 조각 구간 (`beforeState` → `afterState`)
 * - `deleted` — 그 트랜잭션에서 실제로 지워진 **글자** (서식 조각 정리는 글자를 바꾸지 않으므로 넣지 않는다)
 *
 * 둘 다 보낸 것 안에 있어야 믿는다. 화면은 받은 변경을 되돌려 보내지 않고 로컬 트랜잭션에서는 Yjs가 보류분을
 * 끼우지 않으므로(실측, `P8_검증기록_Mention` 2절), 정상 사용에서는 늘 믿을 수 있다.
 */
export function isFaithful(sent: SentChange, integrated: ReadonlyMap<number, ClockRange>, deleted: readonly [number, number, number][]): boolean {
  for (const [client, got] of integrated) {
    const mine = sent.structs.get(client);
    if (!mine || got.from < mine.from || got.to > mine.to) return false;
  }
  const merged = new Map<number, [number, number][]>();
  for (const [client, clock, len] of deleted) {
    if (!merged.has(client)) merged.set(client, merge(sent.deletes.get(client) ?? []));
    if (!merged.get(client)!.some(([c, l]) => c <= clock && clock + len <= c + l)) return false;
  }
  return true;
}

/** `page_realtime.authors`에 넣는 모양 */
export function makersToJson(makers: ReadonlyMap<string, string | null>): { makers: [number, number, string, string | null][] } {
  return {
    makers: [...makers.entries()].map(([id, who]) => {
      const [client, clock] = id.slice(0, id.indexOf('|')).split(':').map(Number);
      return [client, clock, nameOf(id), who];
    }),
  };
}

const MAX_CLIENT_ID = 0xffff_ffff;
/** `usernameSchema`와 같은 규칙 — 멘션 후보 이름이 이것을 지난다 (`mention.ts`) */
const USERNAME = /^[a-z0-9._-]{2,64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * DB에서 읽은 값을 표로. **모양이 맞지 않는 항목은 버린다.**
 *
 * 버린 자리는 방을 만들 때 "모름"이 된다 — 잃는 것은 "그 멘션을 누가 만들었나"뿐이고, 믿지 못할 값을 사람
 * 이름으로 쓰는 쪽이 더 나쁘다. 파생 데이터다.
 */
export function makersFromJson(raw: unknown): MakerMap {
  const out: MakerMap = new Map();
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  const list = (raw as { makers?: unknown }).makers;
  if (!Array.isArray(list)) return out;
  for (const e of list) {
    if (!Array.isArray(e) || e.length !== 4) continue;
    const [client, clock, name, who] = e as unknown[];
    if (!Number.isSafeInteger(client) || (client as number) < 0 || (client as number) > MAX_CLIENT_ID) continue;
    if (!Number.isSafeInteger(clock) || (clock as number) < 0) continue;
    if (typeof name !== 'string' || !USERNAME.test(name)) continue;
    if (who !== null && (typeof who !== 'string' || !UUID.test(who))) continue;
    out.set(`${client as number}:${clock as number}|${name}`, who as string | null);
  }
  return out;
}
