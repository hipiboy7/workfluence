import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { type DocNode, type Principal } from '@workfluence/shared';
import { and, eq, isNull, sql } from 'drizzle-orm';
import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';
import * as Y from 'yjs';
import { AuditService } from '../../audit/audit.service';
import { APP_ENV, type AppEnvToken } from '../../config/config.module';
import { RevocationBus } from '../../common/revocation.bus';
import { DB, type Db } from '../../db/db.module';
import { pageRealtime, pageVersions, pages } from '../../db/schema';
import { SettingsService } from '../../settings/settings.service';
import { SpacesService } from '../../spaces/spaces.service';
import { UsersService } from '../../users/users.service';
import { MentionMailService } from '../../mail/mention-mail.service';
import type { MentionOutcome } from '../../notifications/notifications.service';
import { PagesService } from '../pages.service';
import { shouldSaveVersion, type SaveTrigger } from '../domain/realtime';
import { docFromYDoc, yDocFromDoc } from '../domain/ydoc';
import { dueForRecheck, revocationReason, shouldTerminate } from '../domain/liveness';
import { readPageId, readSessionId } from './session-auth';

/**
 * 실시간 편집 중계 (P6_설계서_Collab C.2절, FR-700~712 / P7_설계서_Hardening C.1~C.3).
 *
 * **`y-websocket`의 서버를 쓰지 않는다.** 연결 시점에 권한을 판정해야 하는데(FR-703)
 * 남의 서버 구현에 인증을 끼워 넣는 것보다 프로토콜을 우리가 다루는 편이 경계가 분명하다.
 *
 * 우리가 다루는 메시지는 둘뿐이고 앞 한 바이트가 종류다.
 *   0 = 문서 변경 — Yjs에 적용하고 같은 방에 퍼뜨린다. 유휴가 지나면 버전을 남긴다
 *   1 = 사람 표시 — **저장하지 않고 퍼뜨리기만** 한다. 커서 위치는 남길 값어치가 없다
 *
 * 변경 자체는 Yjs가 병합하므로 이 클래스는 **누가 무엇을 보냈는지 해석하지 않는다.**
 *
 * **Phase 7에서 더한 것.** 업그레이드 때 한 번 판정하고 마는 구조를 고쳤다 — 주기 재판정,
 * 하트비트, 세션 파기 즉시 반영, "접속만으로 작성자가 바뀌지 않게" 하는 것.
 */

const MSG_UPDATE = 0;
const MSG_AWARENESS = 1;

/** 권한을 잃어 끊을 때 쓰는 닫기 코드. 1008 = policy violation */
const CLOSE_REVOKED = 1008;

/** 아무도 없는 방을 이만큼 두고도 아무 일이 없으면 치운다 (고아 방 회수) */
const EMPTY_ROOM_TTL_MS = 60_000;

type Member = {
  socket: WebSocket;
  principal: Principal;
  name: string;
  /** 이 연결이 타고 들어온 세션. 주기 재판정이 이것을 다시 본다 (FR-800) */
  sid: string;
  spaceId: string;
  /** 직전 ping에 pong이 돌아왔는가 (FR-801) */
  alive: boolean;
  lastCheckedAt: number;
};

type Room = {
  doc: Y.Doc;
  members: Set<Member>;
  /** 업그레이드는 통과했지만 아직 `join`에 닿지 않은 연결의 수. 0이 아니면 방을 지우지 않는다 */
  joining: number;
  /** 이 상태가 시작한 정본 버전 */
  versionNo: number;
  lastChangeAt: number;
  /** 마지막으로 **실제로 문서를 바꾼** 사람. 자동 저장의 `createdBy`가 된다 (FR-712·802) */
  lastActor: string | null;
  /** 진행 중인 저장. 새 요청은 이 뒤에 줄을 선다 — `flush`가 거짓말하지 않으려면 필요하다 */
  saving: Promise<void> | null;
  /** 사람이 고친 제목. 없으면 DB의 것을 쓴다 */
  title: string | null;
  /** 아무도 없어진 시각. 고아 방 회수용 */
  emptyAt: number | null;
};

@Injectable()
export class CollabGateway implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('Collab');
  private readonly rooms = new Map<string, Room>();
  /**
   * 만드는 중인 방. **없으면 같은 페이지에 두 업그레이드가 동시에 와서 방이 둘 생기고,
   * 뒤의 것이 앞을 덮어 앞사람은 아무에게도 안 닿는 고아 방에서 편집한다** (자체 점검 5)
   */
  private readonly pending = new Map<string, Promise<Room>>();
  private wss?: WebSocketServer;
  private timer?: NodeJS.Timeout;
  private pingTimer?: NodeJS.Timeout;
  private unsubscribeRevoke?: () => void;

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(APP_ENV) private readonly env: AppEnvToken,
    private readonly spaces: SpacesService,
    private readonly users: UsersService,
    private readonly pagesSvc: PagesService,
    private readonly audit: AuditService,
    private readonly mentionMail: MentionMailService,
    private readonly settings: SettingsService,
    private readonly revocation: RevocationBus,
  ) {}

  onModuleInit(): void {
    // **세션을 끊는 동작은 즉시 전달받는다** (FR-805). 주기 재판정만으로는 관리자가
    // 강제 종료를 눌러도 최대 `WF_COLLAB_RECHECK_MS`만큼 그 사람이 계속 쓴다
    this.unsubscribeRevoke = this.revocation.onRevoke((userId) => this.closeFor(userId, '세션 파기'));
  }

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
    this.pingTimer = setInterval(() => this.heartbeat(), this.env.WF_COLLAB_PING_MS);
    this.log.log(
      `실시간 편집 켜짐 — 유휴 ${this.env.WF_COLLAB_IDLE_SAVE_MS}ms 뒤 저장, ` +
        `ping ${this.env.WF_COLLAB_PING_MS}ms, 권한 재판정 ${this.env.WF_COLLAB_RECHECK_MS}ms`,
    );
  }

  async onModuleDestroy(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.unsubscribeRevoke?.();
    // **내려가기 전에 남긴다.** 순서를 뒤집으면 마지막 몇 초의 편집이 사라진다
    for (const pageId of [...this.rooms.keys()]) {
      await this.saveIfNeeded(pageId, 'shutdown').catch((e: unknown) => this.log.error(`종료 중 저장 실패 ${pageId}: ${String(e)}`));
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
    // **원시 소켓에 error를 붙여 둔다.** 안 붙이면 상대가 먼저 끊었을 때 Node가
    // 그 'error'를 uncaught로 올린다 (P6 코드 리뷰 21)
    socket.on('error', () => undefined);

    const pageId = readPageId(req.url);
    // **우리 경로가 아니면 닫는다.** 처음에는 "다른 처리기가 붙을 수 있으니 손대지
    // 않는다"로 두었는데, 처리기가 하나라도 있으면 Node는 기본 404를 주지 않는다 —
    // **아무도 응답하지 않아 소켓이 인증 없이 열린 채 남는다** (자체 점검 13).
    if (!pageId || !this.wss) {
      socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }

    const deny = (): void => {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
    };

    let room: Room | undefined;
    try {
      // **`Origin`을 본다** (FR-806). 이 앱의 CSRF 방어는 `SameSite` + 커스텀 헤더 두 겹인데
      // **WebSocket은 헤더를 붙일 수 없어 한 겹뿐**이다. 남은 한 겹을 여기서 채운다
      if (!this.sameOrigin(req)) return deny();

      const sid = readSessionId(req.headers.cookie, this.env.WF_SESSION_SECRET);
      if (!sid) return deny();

      const live = await this.sessionState(sid);
      if (!live) return deny();

      const user = await this.users.findById(live.userId);
      if (!user || user.status !== 'active' || user.mustChangePassword) return deny();
      const principal: Principal = { id: user.id, role: user.role as Principal['role'] };

      const page = await this.db.query.pages.findFirst({ where: and(eq(pages.id, pageId), isNull(pages.deletedAt)) });
      if (!page) return deny();
      // **쓰기 권한이다.** 읽기만 되는 사람은 실시간 편집에 들어오지 못한다 (FR-703)
      const ctx = await this.spaces.context(page.spaceId, principal);
      if (!ctx.access.canWrite) return deny();

      room = await this.room(pageId, page.currentVersionNo);
      // **방이 지워지지 않게 표를 걸어 둔다.** `handleUpgrade`의 콜백은 한 틱 뒤에 오는데,
      // 그 사이에 마지막 사람이 나가 `finish()`가 방을 지우면 이 연결은 **맵에 없는 방**에
      // 붙어 아무에게도 안 닿고 저장도 되지 않는다 (P6 코드 리뷰 3)
      room.joining += 1;
      const joined = room;
      this.wss.handleUpgrade(req, socket, head, (ws) => {
        joined.joining -= 1;
        this.join(pageId, joined, ws, principal, user.displayName, sid, page.spaceId);
      });
    } catch (e) {
      if (room) room.joining = Math.max(0, room.joining - 1);
      this.log.error(`업그레이드 실패 ${pageId}: ${String(e)}`);
      deny();
    }
  }

  /** 요청이 이 서버에서 온 것인가 (FR-806) */
  private sameOrigin(req: IncomingMessage): boolean {
    const origin = req.headers.origin;
    // 브라우저는 WebSocket 핸드셰이크에 `Origin`을 **반드시** 붙인다. 없으면 브라우저가 아니다
    if (!origin) return false;
    const host = req.headers.host;
    if (!host) return false;
    try {
      return new URL(origin).host === host;
    } catch {
      return false;
    }
  }

  /**
   * 세션이 지금도 살아 있는가. **절대 타임아웃까지 본다** (FR-808).
   *
   * `expire > now()`만 보면 HTTP 가드와 판정이 갈린다 — 가드는 `createdAt` 기준으로
   * 12시간을 끊는데 여기는 안 끊어, **같은 세션이 HTTP로는 401인데 WebSocket으로는
   * 글을 쓸 수 있는** 상태가 된다 (P6 코드 리뷰 9).
   */
  private async sessionState(sid: string): Promise<{ userId: string } | null> {
    const found = await this.db.execute<{ sess: { userId?: string; createdAt?: number } }>(
      sql`SELECT sess FROM sessions WHERE sid = ${sid} AND expire > now()`,
    );
    const sess = found.rows[0]?.sess;
    if (!sess?.userId) return null;
    const policy = await this.settings.get();
    if (!sess.createdAt || Date.now() - sess.createdAt > policy.sessionAbsoluteHours * 3_600_000) return null;
    return { userId: sess.userId };
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

    const room: Room = {
      doc,
      members: new Set(),
      joining: 0,
      versionNo,
      lastChangeAt: 0,
      lastActor: null,
      saving: null,
      title: null,
      emptyAt: Date.now(),
    };

    /**
     * **작성자는 Yjs에게 묻는다** (FR-802).
     *
     * 전에는 `MSG_UPDATE`를 받았다는 사실만으로 `lastActor`를 바꿨다. 그런데 화면은
     * 접속 직후 자기 문서 전체를 한 번 보낸다(빈 문서다). 그래서 **아무것도 고치지 않고
     * 열기만 해도 그 사람이 다음 버전의 작성자가 됐다.**
     *
     * Yjs의 `update` 이벤트는 **실제로 문서가 바뀔 때만** 온다. 이미 아는 상태를
     * 되돌려받으면 오지 않는다. 상태 벡터를 비교하는 방법도 있지만 그쪽은 **순수 삭제를
     * 놓친다** — 지우기만 한 편집이 저장되지 않는다 (`P7_검증기록_Hardening` 2절).
     */
    doc.on('update', (_update: Uint8Array, origin: unknown) => {
      if (!origin || typeof origin !== 'object' || !('principal' in origin)) return;
      room.lastChangeAt = Date.now();
      room.lastActor = (origin as Member).principal.id;
    });

    this.rooms.set(pageId, room);
    return room;
  }

  private join(pageId: string, room: Room, socket: WebSocket, principal: Principal, name: string, sid: string, spaceId: string): void {
    const member: Member = { socket, principal, name, sid, spaceId, alive: true, lastCheckedAt: Date.now() };
    room.members.add(member);
    room.emptyAt = null;

    // 새로 들어온 사람에게 **지금 상태 전부**를 보낸다. 그다음부터는 변경만 오간다
    socket.send(this.frame(MSG_UPDATE, Y.encodeStateAsUpdate(room.doc)));
    socket.on('pong', () => {
      member.alive = true;
    });

    socket.on('message', (data: Buffer) => {
      if (data.length < 1) return;
      const kind = data[0];
      const payload = data.subarray(1);
      if (kind === MSG_UPDATE) {
        try {
          // **오리진으로 멤버를 실어 보낸다.** 위의 `update` 관찰자가 이것을 보고
          // "실제로 바뀐 경우에만" 작성자를 고친다
          Y.applyUpdate(room.doc, payload, member);
        } catch (e) {
          // 깨진 변경은 **버린다.** 방을 죽이지 않는다 — 한 사람의 잘못된 프레임이
          // 나머지의 편집을 끊으면 안 된다
          this.log.warn(`변경을 적용하지 못했다 (page=${pageId}): ${String(e)}`);
          return;
        }
      } else if (kind !== MSG_AWARENESS) {
        return; // 모르는 종류는 버린다
      }
      this.broadcast(room, data, member);
    });

    socket.on('close', () => {
      room.members.delete(member);
      if (room.members.size === 0) {
        room.emptyAt = Date.now();
        // **마지막 사람이 나가면 남기고 정리한다** (FR-710).
        // **`void`로 두면 안 된다** — 저장이 실패하면 처리되지 않은 거부가 되어
        // Node가 프로세스를 죽인다. 창을 닫는 순간 서버가 내려간다 (P6 코드 리뷰 1)
        void this.saveIfNeeded(pageId, 'leave').catch((e: unknown) => this.log.error(`퇴장 저장 실패 ${pageId}: ${String(e)}`));
      }
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

  /** 30초마다 살아 있는지 묻는다 (FR-801). 브라우저는 pong을 자동으로 돌려준다 */
  private heartbeat(): void {
    for (const room of this.rooms.values()) {
      for (const m of room.members) {
        if (shouldTerminate(m.alive)) {
          // 답이 없는 연결은 **`close()`가 아니라 `terminate()`다.** 상대가 이미
          // 사라졌으면 닫기 핸드셰이크의 답도 오지 않는다
          m.socket.terminate();
          continue;
        }
        m.alive = false;
        m.socket.ping();
      }
    }
  }

  /** 그 사용자의 열린 편집 연결을 모두 끊는다 (FR-805) */
  private closeFor(userId: string, why: string): void {
    let n = 0;
    for (const room of this.rooms.values()) {
      for (const m of room.members) {
        if (m.principal.id !== userId) continue;
        m.socket.close(CLOSE_REVOKED, why);
        n += 1;
      }
    }
    if (n) this.log.log(`${why} — 편집 연결 ${n}개를 끊었다 (user=${userId})`);
  }

  private async sweep(): Promise<void> {
    const now = Date.now();
    for (const [pageId, room] of [...this.rooms.entries()]) {
      await this.recheck(room).catch((e: unknown) => this.log.warn(`권한 재판정 실패 ${pageId}: ${String(e)}`));

      // **아무도 없고 남길 것도 없는 방은 치운다.** 업그레이드는 통과했는데 연결이
      // 곧바로 끊겨 `join`에 닿지 못한 방이 여기 남는다 (P6 코드 리뷰 14)
      if (room.members.size === 0 && room.joining === 0 && !room.lastChangeAt && room.emptyAt && now - room.emptyAt > EMPTY_ROOM_TTL_MS) {
        if (this.rooms.get(pageId) === room) this.rooms.delete(pageId);
        continue;
      }

      // **아직 편집 중이면 DB를 건드리지 않는다.** 전에는 매초 방마다 질의를 두 번
      // 돌린 **뒤에야** "아직 편집 중"을 판정했다 — 동시 편집자가 늘면 그만큼 연결
      // 풀을 먹는다 (P6 코드 리뷰 13, T-026과 같은 자리)
      if (!room.lastChangeAt || now - room.lastChangeAt < this.env.WF_COLLAB_IDLE_SAVE_MS) continue;

      await this.saveIfNeeded(pageId, 'idle').catch((e: unknown) => this.log.error(`자동 저장 실패 ${pageId}: ${String(e)}`));
    }
  }

  /**
   * 열린 연결의 권한을 다시 본다 (FR-800).
   *
   * **오류가 나면 끊지 않는다.** DB가 잠깐 흔들렸다고 편집을 끊으면 그쪽이 더 나쁘다 —
   * 다음 주기에 다시 본다.
   */
  private async recheck(room: Room): Promise<void> {
    const now = Date.now();
    for (const m of [...room.members]) {
      if (!dueForRecheck(m.lastCheckedAt, now, this.env.WF_COLLAB_RECHECK_MS)) continue;
      m.lastCheckedAt = now;
      const live = await this.sessionState(m.sid);
      const user = live ? await this.users.findById(live.userId) : null;
      let canWrite = false;
      if (user && user.status === 'active') {
        try {
          canWrite = (await this.spaces.context(m.spaceId, { id: user.id, role: user.role as Principal['role'] })).access.canWrite;
        } catch {
          // 스페이스가 사라졌거나 읽기조차 안 된다 — `context`가 404를 던진다
          canWrite = false;
        }
      }
      const reason = revocationReason({
        sessionAlive: live !== null,
        userActive: user?.status === 'active',
        mustChangePassword: user?.mustChangePassword === true,
        canWrite,
      });
      if (!reason) continue;
      this.log.log(`편집 연결을 끊는다 — ${reason} (user=${m.principal.id})`);
      m.socket.close(CLOSE_REVOKED, reason);
    }
  }

  /**
   * 저장 요청을 **줄 세운다**.
   *
   * 전에는 저장 중에 온 요청을 `pendingForce` 깃발 하나로 기억하고 즉시 돌아갔다.
   * 그래서 화면의 저장 버튼이 **아직 만들어지지 않은 버전 번호를 받아 갔다**
   * (P6 코드 리뷰 11). 돌려주는 약속이 실제 저장이 끝날 때 풀리게 한다.
   */
  private saveIfNeeded(pageId: string, trigger: SaveTrigger): Promise<void> {
    const room = this.rooms.get(pageId);
    if (!room) return Promise.resolve();
    const prior = room.saving ?? Promise.resolve();
    const next = prior.then(() => this.runSave(pageId, room, trigger));
    // 사슬은 삼킨 것으로 잇는다 — 한 번 실패했다고 다음 저장까지 막히면 안 된다
    room.saving = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  /** 유휴가 지났으면 버전을 남긴다 (FR-706). 판정은 `shouldSaveVersion`(A등급)이 한다 */
  private async runSave(pageId: string, room: Room, trigger: SaveTrigger): Promise<void> {
    // 줄을 서 있는 사이에 방이 사라졌을 수 있다
    if (this.rooms.get(pageId) !== room) return;
    if (!room.lastChangeAt && trigger === 'idle') return;

    const changedAt = room.lastChangeAt;
    const next = docFromYDoc(room.doc);
    const current = await this.db.query.pages.findFirst({ where: eq(pages.id, pageId) });
    if (!current) {
      this.drop(pageId, room);
      return;
    }
    // **정본이 우리보다 앞서 있으면 저장하지 않는다.** 그 사이 누가 REST로 저장했거나
    // 이력에서 복원했다는 뜻이고, 우리가 들고 있는 것으로 덮으면 **그 저장을 되돌린다**
    if (current.currentVersionNo !== room.versionNo) {
      this.log.warn(`정본이 앞서 있어 협업 상태를 버린다 (page=${pageId}, 방 v${room.versionNo} < 정본 v${current.currentVersionNo})`);
      this.drop(pageId, room);
      for (const m of room.members) m.socket.close();
      await this.db.delete(pageRealtime).where(eq(pageRealtime.pageId, pageId));
      return;
    }
    const version = await this.db.query.pageVersions.findFirst({
      where: and(eq(pageVersions.pageId, pageId), eq(pageVersions.versionNo, current.currentVersionNo)),
    });
    const title = room.title ?? current.title;
    const decision = shouldSaveVersion({
      next,
      previous: (version?.contentJson as DocNode | undefined) ?? null,
      nextTitle: title,
      previousTitle: current.title,
      idleMs: room.lastChangeAt ? Date.now() - room.lastChangeAt : Number.MAX_SAFE_INTEGER,
      idleThresholdMs: this.env.WF_COLLAB_IDLE_SAVE_MS,
      trigger,
    });

    if (!decision.save) {
      if (decision.errors.length) {
        // **버전을 만들지 않고 로그만 남긴다** (FR-708). 실시간 상태는 살아 있으므로
        // 사람이 화면에서 고칠 수 있다 — 여기서 저장하면 깨진 것이 정본이 된다
        this.log.warn(`검증 실패로 저장하지 않았다 (page=${pageId}): ${decision.errors.slice(0, 3).join(' / ')}`);
      }
      await this.rememberState(pageId, room, current.currentVersionNo);
      // **검증에 실패한 상태는 지우지 않는다.** 지우면 고칠 기회가 사라진다 (자체 점검 6)
      if (trigger !== 'idle') {
        if (decision.errors.length) this.drop(pageId, room);
        else await this.finish(pageId, room);
      }
      return;
    }

    const actor = room.lastActor ?? current.updatedBy;
    const collected: MentionOutcome[] = [];
    let savedVersionNo = current.currentVersionNo + 1;
    await this.db.transaction(async (tx) => {
      const saved = await this.pagesSvc.saveCollabVersion(pageId, title, next, actor, tx, (m) => collected.push(m));
      // **락 안에서 만들어진 번호를 쓴다.** 밖에서 계산한 `+1`은 REST 저장과 겹치면
      // 실제와 다른 번호가 감사로그에 남는다 (P6 코드 리뷰 16)
      savedVersionNo = saved.currentVersionNo;
      await this.audit.record(
        { action: 'page.collab.save', actorId: actor, targetType: 'page', targetId: pageId, detail: { versionNo: savedVersionNo, trigger } },
        tx,
      );
    });
    // 메일은 **커밋 뒤에** 보낸다 (FR-754). 기다리지 않는다.
    // **이름을 넘기지 않는다** — 자동 저장의 actor는 "마지막으로 키를 누른 사람"이라
    // 그 이름을 적으면 틀린 사람이 적힌다 (P6 코드 리뷰 6)
    const mentions = collected[0];
    if (mentions?.count) void this.mentionMail.notify(mentions, null, title, actor);
    room.versionNo = savedVersionNo;
    // **저장하는 동안 들어온 변경은 그대로 둔다.** 무조건 0으로 밀면 그 변경은
    // 다음 타이핑이나 퇴장까지 저장되지 않는다 (자체 점검 12)
    if (room.lastChangeAt === changedAt) room.lastChangeAt = 0;
    room.title = null;
    await this.rememberState(pageId, room, room.versionNo);
    // **사람이 남아 있으면 방을 닫지 않는다.** 저장 버튼이 편집을 끊으면 안 된다
    if (trigger !== 'idle') await this.finish(pageId, room);
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

  /** 맵에서 **그 방이 아직 그 방일 때만** 지운다 — 새로 만들어진 방을 지우면 안 된다 */
  private drop(pageId: string, room: Room): void {
    if (this.rooms.get(pageId) === room) this.rooms.delete(pageId);
  }

  /** 마지막 사람이 나갔다. 메모리에서 방을 지우고 저장된 상태도 치운다 (FR-710) */
  private async finish(pageId: string, room: Room): Promise<void> {
    // 저장하는 사이에 누가 들어왔거나, 들어오는 중이다
    if (room.members.size > 0 || room.joining > 0) return;
    this.drop(pageId, room);
    await this.db.delete(pageRealtime).where(eq(pageRealtime.pageId, pageId));
  }

  /**
   * **지금 바로 남긴다** (화면의 저장 버튼).
   *
   * 실시간 편집은 유휴를 기다려 저장하는데, 사람이 "저장하고 나가겠다"고 할 때까지
   * 기다리게 하면 **화면의 약속과 동작이 어긋난다.** 방이 없으면 남길 것도 없다 —
   * 그 경우 `false`를 돌려 호출부가 알게 한다.
   *
   * **저장이 끝난 뒤에 돌아온다.** 그래야 호출부가 읽는 버전 번호가 실제와 맞는다.
   */
  async flush(pageId: string, title?: string): Promise<boolean> {
    const room = this.rooms.get(pageId);
    if (!room) return false;
    // **제목도 함께 남긴다.** 협업 모드에서도 제목은 평범한 입력칸이고, 그것을 안 보내면
    // 사람이 고친 제목이 조용히 버려진다 (자체 점검 3)
    if (title) room.title = title;
    await this.saveIfNeeded(pageId, 'manual');
    return true;
  }
}
