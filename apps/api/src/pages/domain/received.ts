import * as Y from 'yjs';

/**
 * **저장하고 보기로가 화면의 입력을 다 받았는가** (P13_설계서_Readiness D.7, FR-1462).
 *
 * 화면이 보낸 스냅숏(`Y.encodeSnapshot` — 상태 벡터와 지운 기록)에 방의 문서가 아직 받지 못한 것이 있으면 `true`다. 끊긴 줄 모르는
 * 연결에서 누르면 서버는 "이미 남아 있다"로 답하고 화면은 보기로 넘어가 그 입력을 잃는다(병합 전 자체 점검 8).
 *
 * - **상태 벡터만으로는 반쪽이다** (좁은 자체 점검 2). 상태 벡터는 넣은 조각의 시계만 센다 — 지우기는 지운 기록에만 남고 시계를 올리지
 *   않는다. 처음 판은 상태 벡터만 보아, 지우기만 한 입력(실수로 붙인 글을 지운 것)이 닿지 않아도 "받았다"였고 지운 글이 고칠 수 없는
 *   버전에 남았다
 * - 화면이 지운 구간은 서버에서도 **모두** 지워져 있어야 한다. 서버가 거둬 간 조각(`GC`)도 지운 것이다. 서버가 더 가진 것(동료의 편집)은
 *   상관없다
 * - **읽지 못하는 값은 보지 않는다**(`false`) — 조작한 값은 그 사람의 저장 판정만 흐린다. 크기는 DTO가 막는다
 *   (`COLLAB_LIMITS.maxFlushSnapshotChars`)
 */
export function screenIsAhead(doc: Y.Doc, screen: Uint8Array): boolean {
  try {
    const snap = Y.decodeSnapshot(screen);
    const server = Y.decodeStateVector(Y.encodeStateVector(doc));
    for (const [client, clock] of snap.sv) if (clock > (server.get(client) ?? 0)) return true;
    for (const [client, ranges] of snap.ds.clients) {
      const structs = doc.store.clients.get(client);
      const known = server.get(client) ?? 0;
      for (const { clock, len } of ranges) {
        if (len <= 0) continue;
        // 서버가 그 조각을 갖고 있지도 않다 — 조작한 값이거나 넣은 것도 닿지 않았다
        if (!structs || clock + len > known) return true;
        for (let i = Y.findIndexSS(structs, clock); i < structs.length && structs[i].id.clock < clock + len; i++) {
          if (!structs[i].deleted) return true;
        }
      }
    }
    return false;
  } catch {
    return false;
  }
}
