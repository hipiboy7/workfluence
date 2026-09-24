/**
 * 사람 표시(awareness) 프레임 — 읽기·거르기·다시 쓰기 (A등급, P9_설계서_Gate D.5, FR-1004).
 *
 * 프레임은 y-protocols의 모양이다: `[개수, (클라이언트 ID, 시계, 상태 JSON)…]`. 숫자는 lib0의 가변 길이 정수
 * (7비트씩, 작은 쪽부터), 문자열은 그 길이 뒤의 UTF-8이다. 화면은 y-protocols의 `applyAwarenessUpdate`로 받으므로
 * **다시 쓴 프레임이 y-protocols가 쓴 것과 바이트까지 같아야 한다** (테스트가 본다).
 *
 * 의존성을 더하지 않으려고 직접 읽는다 — 형식이 세 줄이다. lib0을 들이면 서버가 부르는 곳이 하나 늘 뿐이다.
 */

export type PresenceEntry = { client: number; clock: number; state: Record<string, unknown> | null };

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
 * 거른다 (D.5). 보낸 사람이 주인인 몫과 주인 없는 몫만 남기고, **이름을 서버가 아는 표시 이름으로** 바꾼다.
 * 주인 없는 몫은 `bind`로 돌려준다 — 게이트웨이가 보낸 사람을 주인으로 적는다(D.4). 화면은 열자마자 자기 ID를
 * 알리므로, 그 알림을 처리하는 순간 묶으면 그 ID가 남에게 퍼지기 전에 주인이 정해진다.
 *
 * 남이 주인인 몫은 뺀다 — 정상 화면은 받은 남의 표시를 되돌려 보내고(메아리), 그것은 이미 퍼뜨린 것이다.
 */
export function screenPresence(
  entries: readonly PresenceEntry[],
  sender: string,
  owners: ReadonlyMap<number, string>,
  name: string,
): { keep: PresenceEntry[]; bind: number[] } {
  const keep: PresenceEntry[] = [];
  const bind: number[] = [];
  for (const e of entries) {
    const owner = owners.get(e.client);
    if (owner === undefined) bind.push(e.client);
    else if (owner !== sender) continue;
    if (e.state === null) {
      keep.push(e);
      continue;
    }
    const user = isRecord(e.state.user) ? e.state.user : {};
    keep.push({ ...e, state: { ...e.state, user: { ...user, name } } });
  }
  return { keep, bind };
}
