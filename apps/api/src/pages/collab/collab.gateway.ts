import { Inject, Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { type DocNode, type Principal } from '@workfluence/shared';
import { and, eq, isNull, sql } from 'drizzle-orm';
import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';
import * as Y from 'yjs';
import { AuditService } from '../../audit/audit.service';
import { APP_ENV, type AppEnvToken } from '../../config/config.module';
import { DB, type Db } from '../../db/db.module';
import { pageRealtime, pageVersions, pages } from '../../db/schema';
import { SpacesService } from '../../spaces/spaces.service';
import { UsersService } from '../../users/users.service';
import { MentionMailService } from '../../mail/mention-mail.service';
import type { MentionOutcome } from '../../notifications/notifications.service';
import { PagesService } from '../pages.service';
import { shouldSaveVersion } from '../domain/realtime';
import { docFromYDoc, yDocFromDoc } from '../domain/ydoc';
import { readPageId, readSessionId } from './session-auth';

/**
 * 실시간 편집 중계 (P6_설계서_Collab C.2절, FR-700~712).
 *
 * **`y-websocket`의 서버를 쓰지 않는다.** 연결 시점에 권한을 판정해야 하는데(FR-703)
 * 남의 서버 구현에 인증을 끼워 넣는 것보다 프로토콜을 우리가 다루는 편이 경계가 분명하다.
 *
 * 우리가 다루는 메시지는 둘뿐이고 앞 한 바이트가 종류다.
 *   0 = 문서 변경 — Yjs에 적용하고 같은 방에 퍼뜨린다. 유휴가 지나면 버전을 남긴다
 *   1 = 사람 표시 — **저장하지 않고 퍼뜨리기만** 한다. 커서 위치는 남길 값어치가 없다
 *
 * 변경 자체는 Yjs가 병합하므로 이 클래스는 **누가 무엇을 보냈는지 해석하지 않는다.**
 * 해석하지 않는 것이 이 설계의 값어치다 — 병합 규칙을 우리가 다시 쓰지 않는다.
 */

const MSG_UPDATE = 0;
const MSG_AWARENESS = 1;

type Member = { socket: WebSocket; principal: Principal; name: string };

type Room = {
  doc: Y.Doc;
  members: Set<Member>;
  /** 이 상태가 시작한 정본 버전 */
  versionNo: number;
  lastChangeAt: number;
  /** 마지막으로 바꾼 사람. 자동 저장의 `createdBy`가 된다 (FR-712) */
  lastActor: string | null;
  saving: boolean;
  /** 저장 중에 들어온 강제 저장 요청. 끝난 뒤 한 번 더 본다 */
  pendingForce: boolean;
  /** 사람이 고친 제목. 없으면 DB의 것을 쓴다 */
  title: string | null;
};

@Injectable()
export class CollabGateway implements OnModuleDestroy {
  private readonly log = new Logger('Collab');
  private readonly rooms = new Map<string, Room>();
  /**
   * 만드는 중인 방. **없으면 같은 페이지에 두 업그레이드가 동시에 와서 방이 둘 생기고,
   * 뒤의 것이 앞을 덮어 앞사람은 아무에게도 안 닿는 고아 방에서 편집한다** (자체 점검 5)
   */
  private readonly pending = new Map<string, Promise<Room>>();
  private wss?: WebSocketServer;
  private timer?: NodeJS.Timeout;

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(APP_ENV) private readonly env: AppEnvToken,
    private readonly spaces: SpacesService,
    private readonly users: UsersService,
    private readonly pagesSvc: PagesService,
    private readonly audit: AuditService,
    private readonly mentionMail: MentionMailService,
  ) {}

  /** `main.ts`가 부른다. HTTP 서버 하나에 붙어 같은 포트를 쓴다 — nginx 설정이 하나로 끝난다 */
  attach(server: Server): void {
    if (!this.env.WF_COLLAB_ENABLED) {
      this.log.log('실시간 편집이 꺼져 있다 (WF_COLLAB_ENABLED=false)');
      return;
    }
    this.wss = new WebSocketServer({ noServer: true });
    server.on('upgrade', (req, socket, head) => void this.upgrade(req, socket, head));
    // 유휴 저장은 **주기로 본다.** 변경마다 타이머를 걸면 타이머가 타이핑 수만큼 생긴다
    this.timer = setInterval(() => void this.sweep(), 1_000);
    this.log.log(`실시간 편집 켜짐 — 유휴 ${this.env.WF_COLLAB_IDLE_SAVE_MS}ms 뒤 저장`);
  }

  async onModuleDestroy(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    // **내려가기 전에 남긴다.** 순서를 뒤집으면 마지막 몇 초의 편집이 사라진다
    for (const pageId of [...this.rooms.keys()]) {
      await this.saveIfNeeded(pageId, true).catch((e: unknown) => this.log.error(`종료 중 저장 실패 ${pageId}: ${String(e)}`));
    }
    this.wss?.close();
  }

  /**
   * 업그레이드 — **여기가 권한의 입구다.**
   *
   * 실패를 **왜 실패했는지 알려 주지 않는다.** 권한이 없는 것과 페이지가 없는 것을
   * 구분해 주면 그것만으로 "그 페이지가 있다"가 새어 나간다 (7절 계정 열거 방지와 같은 판단).
   */
  private async upgrade(req: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    const pageId = readPageId(req.url);
    // **우리 경로가 아니면 닫는다.** 처음에는 "다른 처리기가 붙을 수 있으니 손대지
    // 않는다"로 두었는데, 처리기가 하나라도 있으면 Node는 기본 404를 주지 않는다 —
    // **아무도 응답하지 않아 소켓이 인증 없이 열린 채 남는다** (자체 점검 13).
    // 이 서버에 다른 업그레이드 처리기가 생기면 그때 경로로 갈라 쓴다
    if (!pageId || !this.wss) {
      socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }

    const deny = (): void => {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
    };

    try {
      const sid = readSessionId(req.headers.cookie, this.env.WF_SESSION_SECRET);
      if (!sid) return deny();

      const found = await this.db.execute<{ sess: { userId?: string } }>(
        sql`SELECT sess FROM sessions WHERE sid = ${sid} AND expire > now()`,
      );
      const userId = found.rows[0]?.sess?.userId;
      if (!userId) return deny();

      const user = await this.users.findById(userId);
      if (!user || user.status !== 'active' || user.mustChangePassword) return deny();
      const principal: Principal = { id: user.id, role: user.role as Principal['role'] };

      const page = await this.db.query.pages.findFirst({ where: and(eq(pages.id, pageId), isNull(pages.deletedAt)) });
      if (!page) return deny();
      // **쓰기 권한이다.** 읽기만 되는 사람은 실시간 편집에 들어오지 못한다 (FR-703)
      const ctx = await this.spaces.context(page.spaceId, principal);
      if (!ctx.access.canWrite) return deny();

      const room = await this.room(pageId, page.currentVersionNo);
      this.wss.handleUpgrade(req, socket, head, (ws) => {
        this.join(pageId, room, ws, principal, user.displayName);
      });
    } catch (e) {
      this.log.error(`업그레이드 실패 ${pageId}: ${String(e)}`);
      deny();
    }
  }

  /** 방을 얻는다. 없으면 저장된 실시간 상태에서, 그것도 없으면 **정본에서** 만든다 */
  private async room(pageId: string, versionNo: number): Promise<Room> {
    const existing = this.rooms.get(pageId);
    if (existing) return existing;
    const inflight = this.pending.get(pageId);
    if (inflight) return inflight;
    const p = this.createRoom(pageId, versionNo).finally(() => this.pending.delete(pageId));
    this.pending.set(pageId, p);
    return p;
  }

  private async createRoom(pageId: string, versionNo: number): Promise<Room> {

    const saved = await this.db.query.pageRealtime.findFirst({ where: eq(pageRealtime.pageId, pageId) });
    let doc: Y.Doc;
    if (saved && saved.versionNo === versionNo) {
      // 상태가 정본과 같은 버전에서 시작했을 때만 잇는다. 그 사이 REST로 저장됐으면
      // **정본이 앞서 있으므로** 옛 상태를 이어받으면 그 저장을 되돌리게 된다
      doc = new Y.Doc();
      Y.applyUpdate(doc, Uint8Array.from(saved.state));
    } else {
      const version = await this.db.query.pageVersions.findFirst({
        where: and(eq(pageVersions.pageId, pageId), eq(pageVersions.versionNo, versionNo)),
      });
      doc = yDocFromDoc((version?.contentJson as DocNode | undefined) ?? { type: 'doc', content: [] });
      if (saved) this.log.warn(`실시간 상태가 낡아 정본에서 다시 시작한다 (page=${pageId})`);
    }

    const room: Room = { doc, members: new Set(), versionNo, lastChangeAt: 0, lastActor: null, saving: false, pendingForce: false, title: null };
    this.rooms.set(pageId, room);
    return room;
  }

  private join(pageId: string, room: Room, socket: WebSocket, principal: Principal, name: string): void {
    const member: Member = { socket, principal, name };
    room.members.add(member);

    // 새로 들어온 사람에게 **지금 상태 전부**를 보낸다. 그다음부터는 변경만 오간다
    socket.send(this.frame(MSG_UPDATE, Y.encodeStateAsUpdate(room.doc)));

    socket.on('message', (data: Buffer) => {
      if (data.length < 1) return;
      const kind = data[0];
      const payload = data.subarray(1);
      if (kind === MSG_UPDATE) {
        try {
          Y.applyUpdate(room.doc, payload);
        } catch (e) {
          // 깨진 변경은 **버린다.** 방을 죽이지 않는다 — 한 사람의 잘못된 프레임이
          // 나머지의 편집을 끊으면 안 된다
          this.log.warn(`변경을 적용하지 못했다 (page=${pageId}): ${String(e)}`);
          return;
        }
        room.lastChangeAt = Date.now();
        room.lastActor = principal.id;
      } else if (kind !== MSG_AWARENESS) {
        return; // 모르는 종류는 버린다
      }
      this.broadcast(room, data, member);
    });

    socket.on('close', () => {
      room.members.delete(member);
      // **마지막 사람이 나가면 남기고 정리한다** (FR-710). 순서가 중요하다
      if (room.members.size === 0) void this.saveIfNeeded(pageId, true);
    });
    socket.on('error', () => socket.close());
  }

  private frame(kind: number, payload: Uint8Array): Buffer {
    return Buffer.concat([Buffer.of(kind), Buffer.from(payload)]);
  }

  private broadcast(room: Room, data: Buffer, from: Member): void {
    for (const m of room.members) {
      if (m === from) continue;
      if (m.socket.readyState === m.socket.OPEN) m.socket.send(data);
    }
  }

  private async sweep(): Promise<void> {
    for (const pageId of [...this.rooms.keys()]) {
      await this.saveIfNeeded(pageId, false).catch((e: unknown) => this.log.error(`자동 저장 실패 ${pageId}: ${String(e)}`));
    }
  }

  /**
   * 유휴가 지났으면 버전을 남긴다 (FR-706).
   *
   * 판정은 `shouldSaveVersion`(A등급)이 한다 — 이 메서드는 **시각과 문서를 모아 주기만**
   * 한다. 조건이 다섯이고 그 조합을 실제 연결로 시험하는 것은 느리고 불확실하기 때문이다.
   */
  private async saveIfNeeded(pageId: string, force: boolean): Promise<void> {
    const room = this.rooms.get(pageId);
    if (!room) return;
    if (room.saving) {
      // **저장 중에 온 강제 요청을 버리지 않는다.** 버리면 마지막 사람이 나간 것이
      // 아무에게도 전달되지 않아 방이 영영 남는다 (자체 점검 8)
      if (force) room.pendingForce = true;
      return;
    }
    // 아무도 아무것도 안 고쳤으면 볼 것도 없다
    if (!room.lastChangeAt && !force) return;

    room.saving = true;
    const changedAt = room.lastChangeAt;
    try {
      const next = docFromYDoc(room.doc);
      const current = await this.db.query.pages.findFirst({ where: eq(pages.id, pageId) });
      if (!current) {
        this.rooms.delete(pageId);
        return;
      }
      // **정본이 우리보다 앞서 있으면 저장하지 않는다.** 그 사이 누가 REST로 저장했거나
      // 이력에서 복원했다는 뜻이고, 우리가 들고 있는 것으로 덮으면 **그 저장을 되돌린다**
      // (자체 점검 7). 방을 버리면 다음에 열 때 정본에서 다시 시작한다
      if (current.currentVersionNo !== room.versionNo) {
        this.log.warn(`정본이 앞서 있어 협업 상태를 버린다 (page=${pageId}, 방 v${room.versionNo} < 정본 v${current.currentVersionNo})`);
        this.rooms.delete(pageId);
        for (const m of room.members) m.socket.close();
        await this.db.delete(pageRealtime).where(eq(pageRealtime.pageId, pageId));
        return;
      }
      const version = await this.db.query.pageVersions.findFirst({
        where: and(eq(pageVersions.pageId, pageId), eq(pageVersions.versionNo, current.currentVersionNo)),
      });
      const decision = shouldSaveVersion({
        next,
        previous: (version?.contentJson as DocNode | undefined) ?? null,
        idleMs: room.lastChangeAt ? Date.now() - room.lastChangeAt : Number.MAX_SAFE_INTEGER,
        idleThresholdMs: this.env.WF_COLLAB_IDLE_SAVE_MS,
        force,
      });

      if (!decision.save) {
        if (decision.errors.length) {
          // **버전을 만들지 않고 로그만 남긴다** (FR-708). 실시간 상태는 살아 있으므로
          // 사람이 화면에서 고칠 수 있다 — 여기서 저장하면 깨진 것이 정본이 된다
          this.log.warn(`검증 실패로 저장하지 않았다 (page=${pageId}): ${decision.errors.slice(0, 3).join(' / ')}`);
        }
        await this.rememberState(pageId, room, current.currentVersionNo);
        // **검증에 실패한 상태는 지우지 않는다.** 지우면 고칠 기회가 사라진다 —
        // 사람이 다시 열어 화면에서 고치면 다음 유휴에 저장된다 (자체 점검 6).
        // 방은 메모리에서 비우되 DB의 상태는 남긴다
        if (force) {
          if (decision.errors.length) this.rooms.delete(pageId);
          else await this.finish(pageId, room);
        }
        return;
      }

      const actor = room.lastActor ?? current.updatedBy;
      const collected: MentionOutcome[] = [];
      const actorName = (await this.users.findById(actor))?.displayName ?? '누군가';
      await this.db.transaction(async (tx) => {
        await this.pagesSvc.saveCollabVersion(pageId, room.title ?? current.title, next, actor, tx, (m) => collected.push(m));
        await this.audit.record(
          { action: 'page.collab.save', actorId: actor, targetType: 'page', targetId: pageId, detail: { versionNo: current.currentVersionNo + 1, force } },
          tx,
        );
      });
      // 메일은 **커밋 뒤에** 보낸다 (FR-754). 기다리지 않는다
      const mentions = collected[0];
      if (mentions?.count) void this.mentionMail.notify(mentions, actorName, room.title ?? current.title);
      room.versionNo = current.currentVersionNo + 1;
      // **저장하는 동안 들어온 변경은 그대로 둔다.** 무조건 0으로 밀면 그 변경은
      // 다음 타이핑이나 퇴장까지 저장되지 않는다 (자체 점검 12)
      if (room.lastChangeAt === changedAt) room.lastChangeAt = 0;
      await this.rememberState(pageId, room, room.versionNo);
      // **사람이 남아 있으면 방을 닫지 않는다.** 저장 버튼이 편집을 끊으면 안 된다
      if (force) await this.finish(pageId, room);
    } finally {
      room.saving = false;
    }
    if (room.pendingForce) {
      room.pendingForce = false;
      await this.saveIfNeeded(pageId, true);
    }
  }

  /** 실시간 상태를 남긴다. 프로세스가 죽어도 다음에 이어지도록 */
  private async rememberState(pageId: string, room: Room, versionNo: number): Promise<void> {
    const state = Buffer.from(Y.encodeStateAsUpdate(room.doc));
    await this.db
      .insert(pageRealtime)
      .values({ pageId, state, versionNo, updatedBy: room.lastActor })
      .onConflictDoUpdate({
        target: pageRealtime.pageId,
        set: { state, versionNo, updatedBy: room.lastActor, updatedAt: sql`now()` },
      });
  }

  /** 마지막 사람이 나갔다. 메모리에서 방을 지우고 저장된 상태도 치운다 (FR-710) */
  private async finish(pageId: string, room: Room): Promise<void> {
    if (room.members.size > 0) return; // 저장하는 사이에 누가 들어왔다
    this.rooms.delete(pageId);
    await this.db.delete(pageRealtime).where(eq(pageRealtime.pageId, pageId));
  }

  /**
   * **지금 바로 남긴다** (화면의 저장 버튼).
   *
   * 실시간 편집은 유휴를 기다려 저장하는데, 사람이 "저장하고 나가겠다"고 할 때까지
   * 기다리게 하면 **화면의 약속과 동작이 어긋난다.** 방이 없으면 남길 것도 없다 —
   * 그 경우 `false`를 돌려 호출부가 알게 한다.
   */
  async flush(pageId: string, title?: string): Promise<boolean> {
    const room = this.rooms.get(pageId);
    if (!room) return false;
    // **제목도 함께 남긴다.** 협업 모드에서도 제목은 평범한 입력칸이고, 그것을 안 보내면
    // 사람이 고친 제목이 조용히 버려진다 (자체 점검 3)
    if (title) room.title = title;
    await this.saveIfNeeded(pageId, true);
    return true;
  }

}
