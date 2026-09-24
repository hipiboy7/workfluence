/**
 * 사람 표시(awareness) 프레임 — 읽기·거르기·다시 쓰기 (A등급, P9_설계서_Gate D.5, FR-1004).
 *
 * 프레임은 y-protocols의 모양이다: `[개수, (클라이언트 ID, 시계, 상태 JSON)…]`. 숫자는 lib0의 가변 길이 정수
 * (7비트씩, 작은 쪽부터), 문자열은 그 길이 뒤의 UTF-8이다. 화면은 y-protocols의 `applyAwarenessUpdate`로 받으므로
 * **다시 쓴 프레임이 y-protocols가 쓴 것과 바이트까지 같아야 한다** (테스트가 본다).
 *
 * 의존성을 더하지 않으려고 직접 읽는다 — 형식이 세 줄이다. lib0을 들이면 서버가 부르는 곳이 하나 늘 뿐이다.
 */

import { COLLAB_FIELD } from './ydoc';

export type PresenceEntry = { client: number; clock: number; state: Record<string, unknown> | null };

/**
 * **한 연결이 사람 표시로 묶을 수 있는 클라이언트 ID의 수** (D.5). 정상 화면은 한 연결에서 하나를 알린다 — 사람 표시의 ID는
 * 만들 때의 문서 ID로 정해지고 연결이 사는 동안 바뀌지 않는다(같은 문서로 다시 붙으면 이미 자기 것이다). 넉넉히 둔다.
 * 상한이 없으면 주인 없는 ID를 알림마다 하나씩 끝없이 묶어 표(`page_realtime.authors`와 함께 남는다)를 불릴 수 있다.
 */
export const MAX_PRESENCE_BINDS = 4;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

class Reader {
  private pos = 0;
  constructor(private readonly buf: Uint8Array) {}

  uint(): number {
    let num = 0;
    let mult = 1;
    while (this.pos < this.buf.length) {
      const b = this.buf[this.pos++];
      num += (b & 0x7f) * mult;
      if (b < 0x80) return num;
      mult *= 128;
      if (num > Number.MAX_SAFE_INTEGER) throw new Error('사람 표시의 숫자가 너무 크다');
    }
    throw new Error('사람 표시 프레임이 숫자 중간에서 끝났다');
  }

  string(): string {
    const len = this.uint();
    if (this.pos + len > this.buf.length) throw new Error('사람 표시의 문자열이 프레임보다 길다');
    const s = new TextDecoder('utf-8', { fatal: true }).decode(this.buf.subarray(this.pos, this.pos + len));
    this.pos += len;
    return s;
  }

  done(): boolean {
    return this.pos === this.buf.length;
  }
}

/** 사람 표시 프레임을 읽는다. **읽지 못하면 던진다** — 부르는 쪽이 그 연결을 끊는다 (D.6) */
export function readPresence(frame: Uint8Array): PresenceEntry[] {
  const r = new Reader(frame);
  const n = r.uint();
  const out: PresenceEntry[] = [];
  for (let i = 0; i < n; i++) {
    const client = r.uint();
    const clock = r.uint();
    const state: unknown = JSON.parse(r.string());
    if (state !== null && !isRecord(state)) throw new Error('사람 표시의 상태는 객체나 null이어야 한다');
    out.push({ client, clock, state });
  }
  if (!r.done()) throw new Error('사람 표시 프레임 끝에 바이트가 남았다');
  return out;
}

function writeUint(out: number[], n: number): void {
  let v = n;
  while (v > 0x7f) {
    out.push(0x80 | (v & 0x7f));
    v = Math.floor(v / 128);
  }
  out.push(v & 0x7f);
}

/** 다시 쓴다 — y-protocols `encodeAwarenessUpdate`와 같은 모양 */
export function writePresence(entries: readonly PresenceEntry[]): Uint8Array {
  const out: number[] = [];
  writeUint(out, entries.length);
  const enc = new TextEncoder();
  for (const e of entries) {
    writeUint(out, e.client);
    writeUint(out, e.clock);
    const bytes = enc.encode(JSON.stringify(e.state));
    writeUint(out, bytes.length);
    for (const b of bytes) out.push(b);
  }
  return Uint8Array.from(out);
}

/**
 * 캐럿(TipTap `CollaborationCaret`의 `isValidColor`)이 받는 색 — `#rrggbb`. 캐럿은 이 밖의 색을 투명으로 바꿔 그린다. 화면
 * (`CollabEditor.tsx`의 `colorFor`)도 이 모양으로 만든다 — 전에는 `hsl(…)`을 만들어 동료의 캐럿이 보이지 않았다 (두 번째 자체 점검 5)
 */
const COLOR = /^#[0-9a-fA-F]{6}$/;
const isUint = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;
const isId = (v: unknown): boolean => isRecord(v) && Object.keys(v).every((k) => k === 'client' || k === 'clock') && isUint(v.client) && isUint(v.clock);

const given = (x: unknown): boolean => x !== null && x !== undefined;

/**
 * 화면(y-tiptap의 커서 플러그인)이 만드는 **상대 위치**(`Y.RelativePosition`을 JSON으로 쓴 것)의 모양인가 (두 번째 보안 검토 1).
 * 화면은 늘 `type`(타입 ID)과 `tname`(최상위 이름) 중 **하나**를 적고, `item`(글자 ID)은 있거나 없다(`Y.createRelativePosition`).
 *
 * 셋이 다 비면 동료의 화면이 이 위치를 읽다 던진다(`Y.createAbsolutePositionFromRelativePosition` → Unexpected case). 커서는 남의
 * 변경을 받을 때마다 다시 그리므로 그 편집기는 남의 편집을 더 반영하지 못하고, 그 사람이 다음에 치는 순간 멈춘 화면이 문서가 되어
 * **동료들의 편집이 모두에게서 지워졌다**(브라우저에서 재현). 최상위 이름은 편집기의 것만 — 다른 이름을 읽으면 동료의 문서에 빈
 * 최상위 타입이 생긴다.
 */
function isRelPos(v: unknown): boolean {
  if (!isRecord(v) || Object.keys(v).some((k) => k !== 'type' && k !== 'tname' && k !== 'item' && k !== 'assoc')) return false;
  if (given(v.type) === given(v.tname)) return false;
  if (given(v.type) && !isId(v.type)) return false;
  if (given(v.tname) && v.tname !== COLLAB_FIELD) return false;
  if (given(v.item) && !isId(v.item)) return false;
  return !given(v.assoc) || Number.isSafeInteger(v.assoc);
}

/**
 * **화면이 만드는 모양만 남긴다** (P9 코드 리뷰 6 · 보안 검토 3 · 두 번째 보안 검토 1). 상태는
 * `{ user: { name, color }, cursor: { anchor, head } | null }`이다. 이름은 서버가 아는 표시 이름으로 바꾸고, 색은 캐럿이 받는
 * `#rrggbb`일 때만, 커서는 화면이 만드는 상대 위치 모양일 때만 남긴다 — 커서 플러그인이 동료의 화면에서 이 값을 읽는다.
 * 모르는 필드는 뺀다.
 */
function cleanState(state: Record<string, unknown>, name: string): Record<string, unknown> {
  const user = isRecord(state.user) ? state.user : {};
  const out: Record<string, unknown> = { user: typeof user.color === 'string' && COLOR.test(user.color) ? { name, color: user.color } : { name } };
  const cursor = state.cursor;
  if (cursor === null) out.cursor = null;
  else if (isRecord(cursor) && Object.keys(cursor).every((k) => k === 'anchor' || k === 'head') && isRelPos(cursor.anchor) && isRelPos(cursor.head)) {
    out.cursor = { anchor: cursor.anchor, head: cursor.head };
  }
  return out;
}

/**
 * 거른다 (D.5). 보낸 사람이 주인인 몫만 남기고 **상태를 화면이 만드는 모양으로** 고친다(이름은 서버가 정한다).
 *
 * 주인 없는 몫은 **한 항목짜리 프레임의 살아 있는 몫일 때만** `bind`로 돌려준다 — 화면은 열자마자 자기 ID 하나를 알린다(D.4).
 * 여럿인 프레임은 정상 화면이면 메아리(남의 몫)이고, 떠남(null)은 자기 ID를 알린 뒤에만 온다. 묶을 수 있는 수(`canBind`)도
 * 게이트웨이가 연결마다 정한다 — 한 프레임에 주인 없는 ID를 수십만 개 담아 표를 불리던 길 (P9 코드 리뷰 5·자체 점검 3).
 * 묶지 못한 주인 없는 몫은 뺀다.
 *
 * 남이 주인인 몫은 뺀다 — 정상 화면은 받은 남의 표시를 되돌려 보내고(메아리), 그것은 이미 퍼뜨린 것이다.
 */
export function screenPresence(
  entries: readonly PresenceEntry[],
  sender: string,
  owners: ReadonlyMap<number, string>,
  name: string,
  canBind = 1,
): { keep: PresenceEntry[]; bind: number[] } {
  const keep: PresenceEntry[] = [];
  const bind: number[] = [];
  for (const e of entries) {
    const owner = owners.get(e.client);
    if (owner === undefined) {
      if (entries.length !== 1 || e.state === null || bind.length >= canBind) continue;
      bind.push(e.client);
    } else if (owner !== sender) continue;
    keep.push(e.state === null ? e : { ...e, state: cleanState(e.state, name) });
  }
  return { keep, bind };
}
