/**
 * 실시간 편집의 **클라이언트 ID → 사용자** 대응표 (A등급, P8_설계서_Mention C.2절).
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

/**
 * 한 연결이 보낸 변경을 적용한 뒤 표를 고친다 (FR-904). **표를 제자리에서 바꾼다.**
 *
 * `sent` — 그 연결이 보낸 변경에 들어 있던 클라이언트 ID.
 * `integrated` — 그 변경으로 **실제로 새로 들어간** 조각의 클라이언트 ID (Yjs `update` 이벤트).
 *
 * **둘 다에 있는 것만 적는다.**
 * - 보냈지만 새로 들어가지 않은 것 — 화면은 접속 직후 자기 문서 전체를 보내는데, 거기에는
 *   **남이 쓴 조각이 다 들어 있다.** 그것을 적으면 모든 글자가 방금 들어온 사람의 것이 된다.
 * - 새로 들어갔지만 보내지 않은 것 — Yjs는 앞 조각이 없어 끼우지 못한 변경을 보류해 두었다가
 *   **다른 사람의 변경이 빈자리를 채울 때 함께 끼운다.** 그 조각은 이 연결의 것이 아니다.
 *
 * 이미 **다른 사람**으로 적힌 ID를 주장하면 `null`로 굳힌다 — 누가 진짜인지 모르므로
 * 둘 다 쓰지 않는다. 사칭하려는 쪽이 얻는 최악은 남의 멘션을 "모름"으로 만드는 것이고,
 * 남의 이름으로 부르는 것은 되지 않는다.
 *
 * **이번에 새로 굳힌 ID를 돌려준다.** 정상 사용에서는 거의 생기지 않는 일이라(ID는 무작위
 * 32비트) 생기면 사칭 시도일 수 있다. 게이트웨이가 경고로 남긴다 — 이것이 없으면 그 일은
 * **"알림에 이름이 없다"는 증상 말고는 아무 흔적도 남기지 않는다.**
 */
export function claimAuthors(authors: AuthorMap, userId: string, sent: Iterable<number>, integrated: Iterable<number>): number[] {
  const mine = new Set(sent);
  const frozen: number[] = [];
  for (const client of integrated) {
    if (!mine.has(client)) continue;
    if (!authors.has(client)) {
      authors.set(client, userId);
      continue;
    }
    const owner = authors.get(client);
    if (owner !== null && owner !== userId) {
      authors.set(client, null);
      frozen.push(client);
    }
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

/** `page_realtime.authors`에 넣는 모양. JSON 키는 문자열이다 */
export function authorsToJson(authors: AuthorMap): Record<string, string | null> {
  return Object.fromEntries([...authors.entries()].map(([k, v]) => [String(k), v]));
}

const CLIENT_ID = /^(0|[1-9]\d{0,9})$/;
const MAX_CLIENT_ID = 0xffff_ffff;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * DB에서 읽은 값을 표로. **모양이 맞지 않는 항목은 버린다.**
 *
 * 파생 데이터라 버려도 잃는 것은 "그 글자를 누가 쳤나"뿐이다 — 버린 ID는 방을 만들 때
 * `freezeUnknown`이 `null`로 굳힌다. 믿지 못할 값을 사람 이름으로 쓰는 쪽이 더 나쁘다.
 */
export function authorsFromJson(raw: unknown): AuthorMap {
  const out: AuthorMap = new Map();
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!CLIENT_ID.test(k)) continue;
    const client = Number(k);
    if (client > MAX_CLIENT_ID) continue;
    if (v === null) out.set(client, null);
    else if (typeof v === 'string' && UUID.test(v)) out.set(client, v);
  }
  return out;
}
