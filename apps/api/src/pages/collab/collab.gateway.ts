import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { COLLAB_CLOSE_REFUSED, COLLAB_MSG, type CollabStatus, type DocNode, type Principal } from '@workfluence/shared';
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
import { scanMentions, type MentionOutcome } from '../../notifications/notifications.service';
import { PagesService } from '../pages.service';
import { blockedReason, saveBlockedReason, shouldSaveVersion, type SaveDecision, type SaveTrigger } from '../domain/realtime';
import { docFromYDoc, mentionSites, yDocFromDoc } from '../domain/ydoc';
import {
  advance,
  claimOwn,
  emptyLedger,
  isFaithful,
  ledgerFromJson,
  ledgerToJson,
  makersFor,
  recordDelivered,
  settle,
  type ClockRange,
  type DeletedItem,
  type Ledger,
  type SentChange,
  type Site,
} from '../domain/makers';
import { dueForRecheck, revocationReason, shouldTerminate } from '../domain/liveness';
import { inspectUpdate, type GateRule } from '../domain/gate';
import { MAX_PRESENCE_BINDS, readPresence, screenPresence, unwrittenBindsLeft, writePresence } from '../domain/presence';
import { readClientIp, readPageId, readSessionId } from './session-auth';

/**
 * 실시간 편집 중계 (P6_설계서_Collab C.2절, FR-700~712 / P7_설계서_Hardening C.1~C.3).
 *
 * **`y-websocket`의 서버를 쓰지 않는다.** 연결 시점에 권한을 판정해야 하는데(FR-703)
 * 남의 서버 구현에 인증을 끼워 넣는 것보다 프로토콜을 우리가 다루는 편이 경계가 분명하다.
 *
 * 메시지는 셋이고 앞 한 바이트가 종류다 (`COLLAB_MSG`).
 *   0 = 문서 변경 — 관문을 지나면 Yjs에 적용하고 같은 방에 퍼뜨린다. 유휴가 지나면 버전을 남긴다
 *   1 = 사람 표시 — 걸러서 **퍼뜨리기만** 한다(저장하지 않는다). 커서 위치는 남길 값어치가 없다
 *   2 = 저장 상태 — **서버만 보낸다.** 자동 저장이 멈췄는지 알린다 (P9 FR-1011). 화면이 보낸 것은 버린다
 *
 * 변경의 병합은 Yjs가 한다. 이 클래스가 변경의 내용을 보는 것은 **누가 무엇을 보냈나**(Phase 8)와 **받아도 되는
 * 모양인가**(Phase 9, 관문)뿐이다 — 아래.
 *
 * **Phase 7에서 더한 것.** 업그레이드 때 한 번 판정하고 마는 구조를 고쳤다 — 주기 재판정,
 * 하트비트, 세션 파기 즉시 반영, "접속만으로 작성자가 바뀌지 않게" 하는 것.
 *
 * **Phase 8에서 더한 것.** 멘션을 만든 사람을 가리려고 **누가 무엇을 보냈는지는 본다** — 보낸 변경의 조각·삭제 구간
 * (`sentChange`), 그것이 보낸 것만큼만 문서를 바꿨나(`isFaithful`), 그 연결이 들여온 글자와 새로 생긴 멘션 자리
 * (`advance`). 변경의 병합은 여전히 Yjs가 한다 (P8_설계서_Mention C.2절).
 *
 * **`room.doc`에 관찰자를 더하면 그 안에서 던지지 않게 한다.** Yjs는 관찰자의 예외를 변경을 **적용한 뒤**
 * `Y.applyUpdate` 밖으로 올린다 — 길목의 예외가 편집 전체를 막았다 (T-035).
 *
 * **Phase 9에서 더한 것 — 관문.** 멤버가 보낸 변경을 **적용하기 전에** 서버 문서에 대어 보고(`inspectUpdate`), 편집기가
 * 만들 수 있는 모양이 아니면 받지 않고 그 연결을 끊는다(완결·구조·주인 규칙). 사람 표시도 읽고 걸러 다시 쓴다
 * (`screenPresence` — 남의 몫을 빼고, 이름은 서버가 정하고, 색·커서는 화면이 만드는 모양만 남긴다). 관문을 지난 변경은
 * **받은 그대로** 퍼뜨린다 (P9_설계서_Gate D.1, 보류 22·23·24). 자동 저장이 검증에 걸리면 방의 화면에 알린다 (D.9).
 */

/** 권한을 잃어 끊을 때 쓰는 닫기 코드. 1008 = policy violation */
const CLOSE_REVOKED = 1008;

/**
 * 저장이 던졌을 때(정본 읽기·저장 트랜잭션·상태 남기기) 방에 알리는 까닭 (P9 D.9, 세 번째 코드 리뷰 3). 실시간 상태는 살아 있고 다음 유휴에 다시 한다 —
 * 알리지 않으면 화면은 저장되는 줄 안다
 */
export const SAVE_FAILED_REASON = '서버가 버전을 남기지 못했다 — 잠시 뒤 다시 한다';

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
  /**
   * 권한을 잃어 끊기로 한 연결.
   *
   * **`close()`는 즉시 끊지 않는다.** close 프레임을 보내고 상대의 답을 최대 30초 기다리며,
   * 그동안 `ws`는 들어온 메시지를 그대로 올린다. 답하지 않는 클라이언트는 **끊기로 한 뒤에도
   * 30초 동안 문서를 계속 고칠 수 있었다** (P7 보안 검토 F2). 이 표시를 보고 되돌아 나온다.
   */
  revoked: boolean;
  lastCheckedAt: number;
  /**
   * 지금 적용 중인 변경에 든 조각·삭제 구간. `Y.applyUpdate` 동안만 채워진다.
   * 트랜잭션 관찰자가 이것과 "실제로 일어난 것"을 맞춰, 그 변경을 믿을지 정한다 (P8 C.2절)
   */
  sending: SentChange | null;
  /**
   * 이 연결의 클라이언트 ID — 이 연결이 시계 0부터 만든 것, 또는 같은 사람이 전에 만들어 이어받은 것(`owners`, 같은 Y.Doc
   * 재접속) (P8 C.2절, `claimOwn`). 여럿일 수 있다 — Yjs는 남이 같은 ID를 쓰는 것을 보면 스스로 새 ID로 바꾼다.
   * 이 연결이 들여온 글자 중 이 클라이언트들의 것만 이 사람이 쓴 글자로 친다
   */
  own: Set<number>;
  /** 연결한 사람의 주소 — 거절을 감사로그에 남길 때 쓴다 (P9 D.6). HTTP의 `req.ip`와 같은 규칙으로 구한다 */
  ip: string | null;
  /**
   * 이 연결이 사람 표시로 묶은 클라이언트 ID. `MAX_PRESENCE_BINDS`개까지다 (P9 D.5). 나가도 풀지 않는다 — 사람마다의 상한은
   * `unwrittenBindsLeft`가 본다 (세 번째 코드 리뷰 2)
   */
  presenceBound: number[];
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
  /**
   * 멘션을 **만든** 사람의 장부 — 멘션 자리마다 만든 사람, 어느 연결이 어느 글자를 들여왔나, 옮김을 가리는
   * 사라진 이름 (P8_설계서_Mention C.2절, FR-900·903). 멤버의 변경마다 고친다. 실시간 상태와 함께
   * `page_realtime.authors`에 남는다
   */
  ledger: Ledger;
  /** 마지막으로 훑은 멘션 자리. 저장 때 다시 훑지 않고 이것을 쓴다 */
  sites: Site[];
  /**
   * 장부를 고치다 예외가 났다. 그 뒤로 이 방의 멘션은 전부 모름이다 — 장부가 문서와 어긋났을 수 있고,
   * 어긋난 장부로 이름을 붙이는 것보다 비우는 쪽이 낫다 (P8 세 번째 검토 2)
   */
  attributionBroken: boolean;
  /** 진행 중인 저장. 새 요청은 이 뒤에 줄을 선다 — `flush`가 거짓말하지 않으려면 필요하다 */
  saving: Promise<void> | null;
  /** 사람이 고친 제목. 없으면 DB의 것을 쓴다 */
  title: string | null;
  /** 아무도 없어진 시각. 고아 방 회수용 */
  emptyAt: number | null;
  /**
   * 자동 저장이 멈춘 까닭 — 마지막 판정이 검증에 실패했다. 방의 모두에게 알렸고, 새로 들어오는 사람에게도 알린다.
   * 검증을 지난 판정이 나면 `null`로 돌아간다 (P9 FR-1011)
   */
  saveBlocked: string | null;
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
  /** 마지막 저장 판정. `flush`가 "정말 남았는가"를 답하는 데 쓴다 (P7 자체 점검 3) */
  private readonly lastDecision = new Map<string, SaveDecision>();
  private wss?: WebSocketServer;
  private timer?: NodeJS.Timeout;
  private pingTimer?: NodeJS.Timeout;
  private unsubscribeRevoke?: () => void;
  /**
   * **떠 있는 뒷일.** 퇴장 저장·유휴 저장·메일은 아무도 기다리지 않는 `void` 호출이다.
   * 그대로 두면 프로세스가 내려갈 때 **진행 중인 저장이 잘린다** — 마지막 몇 초의 편집이
   * 사라지는 바로 그 경우다. 여기 모아 두고 종료 때 기다린다.
   * (테스트에서도 같은 값을 한다 — 안 기다리면 다음 파일의 DB 정리와 겹친다. T-028과 같은 자리)
   */
  private readonly pendingWork = new Set<Promise<unknown>>();

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

  /** 뒷일을 기록해 둔다. 끝나면 스스로 빠진다 */
  private track(work: Promise<unknown>): void {
    const p = work.catch(() => undefined);
    this.pendingWork.add(p);
    void p.finally(() => this.pendingWork.delete(p));
  }

  /** 떠 있는 뒷일이 전부 끝날 때까지 기다린다. 뒷일이 또 뒷일을 낳을 수 있어 비워질 때까지 돈다 */
  private async drain(): Promise<void> {
    for (let i = 0; i < 20 && this.pendingWork.size > 0; i++) {
      await Promise.allSettled([...this.pendingWork]);
    }
  }

  onModuleInit(): void {
    // **세션을 끊는 동작은 즉시 전달받는다** (FR-805). 주기 재판정만으로는 관리자가
    // 강제 종료를 눌러도 최대 `WF_COLLAB_RECHECK_MS`만큼 그 사람이 계속 쓴다
    this.unsubscribeRevoke = this.revocation.onRevoke((userId, sid) => this.closeFor(userId, '세션 파기', sid));
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
    await this.drain();
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
      // **표를 반드시 되돌려 놓는다.** `ws`의 `handleUpgrade`는 클라이언트가 이미 끊었거나
      // 핸드셰이크 헤더가 불량하면 **콜백을 부르지 않고** 소켓만 파괴한다. 그러면 표가
      // 영영 걸린 채 남아 그 방을 아무도 지우지 못한다 (P7 자체 점검 1).
      // 원시 소켓의 `close`로 한 번, 콜백에서 한 번 — 먼저 오는 쪽이 되돌린다
      let released = false;
      const release = (): void => {
        if (released) return;
        released = true;
        joined.joining -= 1;
      };
      socket.once('close', release);
      const ip = readClientIp(req.headers['x-forwarded-for'], req.socket.remoteAddress, this.env.WF_TRUST_PROXY);
      this.wss.handleUpgrade(req, socket, head, (ws) => {
        release();
        this.join(pageId, joined, ws, principal, user.displayName, sid, page.spaceId, ip);
      });
    } catch (e) {
      if (room) room.joining = Math.max(0, room.joining - 1);
      this.log.error(`업그레이드 실패 ${pageId}: ${String(e)}`);
      deny();
    }
  }

  /**
   * 요청이 이 서버에서 온 것인가 (FR-806).
   *
   * **호스트만 본다. 스킴은 보지 않는다.** 한 번 넣었다가 뺐다 — 기대하는 스킴을 알려면
   * `X-Forwarded-Proto`를 믿어야 하는데, **앞단에 장비가 하나 더 있어 거기서 TLS를 끝내고
   * nginx에 http로 넘기면** 브라우저 Origin은 https이고 그 헤더는 http라 **모든 실시간
   * 편집이 막힌다.** T-032와 똑같은 함정의 다른 얼굴이다. 이 앱이 놓인 앞단 구성을
   * 우리가 알지 못하는 한, **배치에 따라 전면 장애가 되는 검사를 심층 방어로 넣지 않는다.**
   *
   * 스킴을 빼도 막으려던 것은 막힌다 — 공격자 페이지의 Origin은 **호스트가 다르다.**
   * 같은 호스트·같은 포트에 http로 응답하는 무언가가 있어야 하는데, 운영은 nginx가
   * 그 포트를 혼자 듣고 TLS만 받는다.
   */
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
    let ledger: Ledger = emptyLedger();
    if (saved && saved.versionNo === versionNo) {
      // 상태가 정본과 같은 버전에서 시작했을 때만 잇는다. 그 사이 REST로 저장됐으면
      // **정본이 앞서 있으므로** 옛 상태를 이어받으면 그 저장을 되돌리게 된다
      doc = new Y.Doc();
      Y.applyUpdate(doc, Uint8Array.from(saved.state));
      // **장부도 함께 잇는다** (FR-903). 재기동 전에 쳤지만 아직 저장되지 않은 멘션의
      // "누가"가 여기서 살아남는다
      ledger = ledgerFromJson(saved.authors);
    } else {
      const version = await this.db.query.pageVersions.findFirst({
        where: and(eq(pageVersions.pageId, pageId), eq(pageVersions.versionNo, versionNo)),
      });
      doc = yDocFromDoc((version?.contentJson as DocNode | undefined) ?? { type: 'doc', content: [] });
      if (saved) this.log.warn(`실시간 상태가 낡아 정본에서 다시 시작한다 (page=${pageId})`);
    }

    // **장부를 지금 문서에 맞춘다.** 표에 있는 자리는 그대로, 없는 자리는 모름이다 — 정본에서 만든 방의
    // 멘션은 전부 직전 버전에 이미 있어 새 알림이 되지 않는다(이름 차이 비교, C.3절)
    const sites = mentionSites(doc, scanMentions);
    ledger = advance(ledger, sites, null);

    const room: Room = {
      doc,
      members: new Set(),
      joining: 0,
      versionNo,
      lastChangeAt: 0,
      lastActor: null,
      ledger,
      sites,
      attributionBroken: false,
      saving: null,
      title: null,
      emptyAt: Date.now(),
      // **방을 열 때도 저장할 수 있는 상태인지 본다** (P9 D.9, 두 번째 코드 리뷰 4·자체 점검 1). 알림은 방의 메모리에만 있어, 다시
      // 만든 방(재기동 뒤·모두 나간 뒤 남은 실시간 상태, Phase 9 전의 정본)은 첫 판정까지 몰랐다 — 들어오는 사람이 곧바로 안다
      saveBlocked: saveBlockedReason(docFromYDoc(doc)),
    };

    /**
     * **작성자는 Yjs에게 묻는다** (FR-802).
     *
     * 전에는 문서 변경(`COLLAB_MSG.update`)을 받았다는 사실만으로 `lastActor`를 바꿨다. 그런데 화면은
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

    /**
     * **멘션을 만든 사람을 적는다** (P8_설계서_Mention C.2절, FR-900·904·907).
     *
     * 멤버의 변경이 끝나는 순간 두 가지를 한다.
     * 1. **그 연결이 무엇을 들여왔는지** 적는다(`delivered`) — 그 연결이 만든 클라이언트(`claimOwn`)의 글자만
     *    그 사람의 것으로, 믿을 수 있는 변경일 때만.
     * 2. 문서의 멘션 자리를 다시 훑어 **새로 생긴 자리에 그 사람을** 적는다(`advance`) — 멘션의 글자를 전부 그
     *    사람이 들여왔고, 같은 이름이 남의 것으로 사라진 적이 없을 때만.
     *
     * 믿는 것은 서버가 본 사실(어느 연결이 무엇을 보냈나)뿐이다. 글자의 클라이언트 ID나 Yjs가 적어 둔 이웃은
     * 클라이언트가 정하는 값이라 보지 않는다. 그래서 이름이 붙을 수 있는 사람은 **자기 연결로 그 멘션의 글자를
     * 들여오고 그 멘션을 생기게 한 사람뿐**이다.
     *
     * 그 변경이 **보낸 것보다 문서를 더 바꿨으면** 믿지 않는다(`isFaithful`) — Yjs가 보류해 둔 남의 조각·삭제가
     * 묻어 들어온 것이다. 연결이 아닌 쪽의 트랜잭션(서버가 직접 고치는 것)도 모름이다.
     *
     * **트랜잭션이 끝나는 순간**에 본다. 새로 들어간 구간은 `beforeState` → `afterState`에 있고, 지운 조각은
     * 이 순간이 지나면 내용이 사라져(GC) 서식 조각과 글자를 가릴 수 없다.
     */
    doc.on('afterTransaction', (tr: Y.Transaction) => {
      if (room.attributionBroken) return;
      // **여기서 던지지 않는다.** Yjs는 이 관찰자의 예외를 **변경을 이미 적용한 뒤** `Y.applyUpdate` 밖으로 올린다.
      // 처음에는 받은 쪽이 그것을 "적용하지 못했다"로 알고 퍼뜨리지 않아, 그 뒤 모두의 변경이 중계되지 않았다
      // (P8 세 번째 검토 2, T-035). 지금은 받은 쪽도 퍼뜨리지만, 반쯤 고친 장부로는 그 뒤의 판정을 믿을 수 없다.
      // 장부는 부가 기능이다: 실패하면 그 방의 멘션을 모름으로 두고 편집은 계속 흐르게 한다
      try {
        this.attribute(room, tr, pageId);
      } catch (e) {
        room.attributionBroken = true;
        this.log.error(`멘션 장부를 고치지 못했다 — 이 방의 멘션은 이제 "모름"이다 (page=${pageId}): ${String(e)}`);
      }
    });

    this.rooms.set(pageId, room);
    return room;
  }

  /** 트랜잭션 하나를 장부에 반영한다 (위 관찰자가 부른다) */
  private attribute(room: Room, tr: Y.Transaction, pageId: string): void {
    const doc = room.doc;
    const member = tr.origin && typeof tr.origin === 'object' && 'sending' in tr.origin ? (tr.origin as Member) : null;
    const integrated = new Map<number, ClockRange>();
    for (const [client, after] of tr.afterState) {
      const before = tr.beforeState.get(client) ?? 0;
      if (after > before) integrated.set(client, { from: before, to: after });
    }
    // **자기 클라이언트는 먼저, 따로 알아본다** (네 번째 검토 1·6). 변경을 믿을 수 없어도, 들어온 조각이 이미 지워진
    // 문단 안이라 문서가 바뀌지 않았어도 — 여기서 놓치면 그 연결이 끝까지 모름이 된다
    if (member?.sending) claimOwn(member.own, room.ledger.owners, member.principal.id, member.sending, integrated);
    // 아무것도 안 바뀐 트랜잭션(접속 직후 이미 아는 전체 상태, 저장 때의 정리)은 더 볼 것이 없다
    if (tr.changed.size === 0 && tr.deleteSet.clients.size === 0) return;
    let maker: string | null = null;
    if (member?.sending) {
      // 서식 조각과 속성 값(맵 항목)은 글자를 바꾸지 않는다 — Yjs가 스스로 지우기도 하므로 세지 않는다
      const deleted: DeletedItem[] = [];
      Y.iterateDeletedStructs(tr, tr.deleteSet, (struct) => {
        if (!(struct instanceof Y.Item) || struct.content instanceof Y.ContentFormat || struct.parentSub !== null) return;
        const holder = (struct.parent as Y.AbstractType<unknown> | null)?._item ?? null;
        deleted.push({ client: struct.id.client, clock: struct.id.clock, len: struct.length, parent: holder ? `${holder.id.client}:${holder.id.clock}` : null });
      });
      if (isFaithful(member.sending, integrated, deleted)) {
        maker = member.principal.id;
        // **한 클라이언트짜리 변경의, 그 연결이 만든 클라이언트의 글자만** 그 사람이 들여온 것으로 적는다
        if (integrated.size === 1) {
          for (const [client, range] of integrated) if (member.own.has(client)) recordDelivered(room.ledger.delivered, client, range, maker);
        }
      } else {
        // **흔적을 남긴다.** 보내지 않은 조각이나 삭제가 이 변경에서 일어났다 — 누가 미리 보내 둔 위조일 수 있다
        // (FR-904). 이 로그가 없으면 "알림에 이름이 없다" 말고는 아무것도 남지 않는다 (운영가이드 7.22절).
        // `user=`는 이 변경을 보낸 연결이다 — 위조를 보낸 사람이 아니라 **피해자**일 수 있다
        this.log.warn(`변경이 보낸 것보다 문서를 더 바꿨다 — 이 변경으로 생긴 멘션은 "모름"으로 둔다 (page=${pageId}, user=${member.principal.id})`);
      }
    }
    room.sites = mentionSites(doc, scanMentions);
    // 이 변경에서 새로 들어온 구간을 함께 넘긴다 — 옮김은 멘션이 통째로 생길 때만 따진다
    room.ledger = advance(room.ledger, room.sites, maker, integrated);
  }

  private join(pageId: string, room: Room, socket: WebSocket, principal: Principal, name: string, sid: string, spaceId: string, ip: string | null = null): void {
    const member: Member = {
      socket,
      principal,
      name,
      sid,
      spaceId,
      alive: true,
      revoked: false,
      lastCheckedAt: Date.now(),
      sending: null,
      own: new Set(),
      ip,
      presenceBound: [],
    };
    room.members.add(member);
    room.emptyAt = null;

    // 새로 들어온 사람에게 **지금 상태 전부**를 보낸다. 그다음부터는 변경만 오간다
    socket.send(this.frame(COLLAB_MSG.update, Y.encodeStateAsUpdate(room.doc)));
    // 자동 저장이 멈춰 있으면 **들어오자마자** 안다 — 모르면 저장되는 줄 알고 쓴다 (FR-1011)
    if (room.saveBlocked !== null) socket.send(this.statusFrame(room));
    socket.on('pong', () => {
      member.alive = true;
    });

    socket.on('message', (data: Buffer) => {
      // **끊기로 한 연결의 말은 듣지 않는다** (P7 보안 검토 F2)
      if (member.revoked) return;
      if (data.length < 1) return;
      const kind = data[0];
      const payload = data.subarray(1);
      if (kind === COLLAB_MSG.update) {
        let decoded: ReturnType<typeof Y.decodeUpdate>;
        try {
          decoded = Y.decodeUpdate(payload);
        } catch {
          // **읽을 수 없는 변경도 거절이다** (P9 D.1). 정상 화면은 그런 것을 보내지 않는다. 방의 다른 사람은 아무 일도 겪지 않는다
          this.refuse(pageId, room, member, 'structure', '읽을 수 없는 변경');
          return;
        }
        // **적용하기 전에 본다** (P9 D.1). 적용한 뒤 고치는 길은 남이 차지한 시계 구간을 되돌리지 못한다(보류 24).
        // 받은 바이트도 넘긴다 — 같은 클라이언트의 덩어리가 되풀이됐는지는 읽은 것만으로 가릴 수 없다 (D.2)
        const verdict = inspectUpdate(decoded, room.doc, member.principal.id, room.ledger.owners, payload);
        if (!verdict.ok) {
          this.refuse(pageId, room, member, verdict.rule, verdict.reason);
          return;
        }
        if (verdict.bind !== null) room.ledger.owners.set(verdict.bind, member.principal.id);
        // 보낸 것에 든 조각·삭제 구간 — 관찰자가 그 변경을 믿을지 정할 때 쓴다 (P8 C.2절). DB는 건드리지 않는다 (NFR-80)
        member.sending = this.sentChange(decoded);
        try {
          // **오리진으로 멤버를 실어 보낸다.** 위의 `update` 관찰자가 이것을 보고
          // "실제로 바뀐 경우에만" 작성자를 고친다
          Y.applyUpdate(room.doc, payload, member);
        } catch (e) {
          // **읽을 수 있었던 변경이 던졌으면 이미 적용된 것이다** — Yjs는 관찰자의 예외를 변경을 적용한 **뒤에** 올린다.
          // 예전에는 여기서 돌아가 퍼뜨리지 않았고, 서버 문서만 바뀐 채 모두의 화면이 조용히 갈렸다 (네 번째 코드 리뷰 5).
          // 퍼뜨린다 — 받은 쪽도 같은 변경을 적용한다
          this.log.error(`변경을 적용하는 중 예외가 났다 — 퍼뜨린다 (page=${pageId}): ${String(e)}`);
        } finally {
          // **반드시 비운다.** 남아 있으면 이 연결과 무관한 다음 변경(서버가 직접 고치는 것)에
          // 이 연결이 보낸 ID 목록이 묻어 간다
          member.sending = null;
        }
      } else if (kind === COLLAB_MSG.awareness) {
        this.relayPresence(pageId, room, member, payload);
        return;
      } else {
        return; // 모르는 종류는 버린다 — 저장 상태(`COLLAB_MSG.status`)도 서버만 보내는 것이라 여기로 온다
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
        this.track(this.saveIfNeeded(pageId, 'leave').catch((e: unknown) => this.log.error(`퇴장 저장 실패 ${pageId}: ${String(e)}`)));
      }
    });
    socket.on('error', () => socket.close());
  }

  /**
   * 사람 표시를 걸러 퍼뜨린다 (P9_설계서_Gate D.5, FR-1004). **남의 몫은 빼고, 이름은 서버가 아는 표시 이름으로 바꾸고, 색·커서는
   * 화면이 만드는 모양만 남긴다.** 주인 없는 클라이언트 ID는 보낸 사람에게 묶는다 — 화면은 열자마자 자기 ID를 알리므로, 여기서
   * 묶으면 그 ID가 남에게 퍼지기 전에 주인이 정해진다(D.4). 한 연결이 묶는 수는 `MAX_PRESENCE_BINDS`까지, 한 사람이 방에 쓰지 않고 쥔 수는
   * `MAX_UNWRITTEN_PRESENCE_BINDS`까지다. **나가도 풀지 않는다** (세 번째 코드 리뷰 2). 읽지 못하면 거절이다.
   */
  private relayPresence(pageId: string, room: Room, member: Member, payload: Uint8Array): void {
    let entries: ReturnType<typeof readPresence>;
    try {
      entries = readPresence(payload);
    } catch {
      this.refuse(pageId, room, member, 'presence', '읽을 수 없는 사람 표시');
      return;
    }
    const owners = room.ledger.owners;
    const user = member.principal.id;
    // 사람마다의 상한은 **묶을 후보가 있을 때만** 센다 — 주인 표를 훑으므로 커서가 움직일 때마다 세지 않는다
    const unowned = entries.length === 1 && !owners.has(entries[0].client);
    const canBind = unowned
      ? Math.min(MAX_PRESENCE_BINDS - member.presenceBound.length, unwrittenBindsLeft(owners, user, (c) => Y.getState(room.doc.store, c) > 0))
      : 0;
    const { keep, bind } = screenPresence(entries, user, owners, member.name, canBind);
    for (const client of bind) owners.set(client, user);
    member.presenceBound.push(...bind);
    if (keep.length) this.broadcast(room, this.frame(COLLAB_MSG.awareness, writePresence(keep)), member);
  }

  /**
   * **관문이 받지 않았다** (P9_설계서_Gate D.6, FR-1005·1006). 적용도 중계도 하지 않고, 기록하고, 그 연결을 닫는다.
   *
   * 기록에는 규칙과 까닭(이름·키 수준)만 남긴다 — 글자·속성 값은 남기지 않는다(7절). 닫기는 `revoke`와 같은 순서다:
   * 표시 → 방에서 뺌 → 닫기. 닫은 뒤에 온 말은 듣지 않는다.
   */
  private refuse(pageId: string, room: Room, member: Member, rule: GateRule | 'presence', reason: string): void {
    if (member.revoked) return;
    this.log.warn(`관문이 변경을 받지 않았다 — ${reason} (page=${pageId}, user=${member.principal.id}, rule=${rule})`);
    this.track(
      this.audit
        .record({ action: 'page.collab.reject', actorId: member.principal.id, targetType: 'page', targetId: pageId, detail: { rule, reason }, ip: member.ip ?? undefined })
        .catch((e: unknown) => this.log.error(`거절을 감사로그에 남기지 못했다 (page=${pageId}): ${String(e)}`)),
    );
    this.revoke(room, member, '받지 않은 변경', COLLAB_CLOSE_REFUSED);
  }

  /** 한 연결이 보낸 변경에 든 조각·삭제 구간 (P8 C.2절). 관문이 읽은 것을 그대로 받는다 */
  private sentChange(decoded: ReturnType<typeof Y.decodeUpdate>): SentChange {
    const structs = new Map<number, ClockRange>();
    for (const s of decoded.structs) {
      if (!(s instanceof Y.Item) && !(s instanceof Y.GC)) continue;
      const cur = structs.get(s.id.client);
      const from = s.id.clock;
      const to = s.id.clock + s.length;
      structs.set(s.id.client, cur ? { from: Math.min(cur.from, from), to: Math.max(cur.to, to) } : { from, to });
    }
    const deletes = new Map<number, [number, number][]>();
    for (const [client, items] of decoded.ds.clients) deletes.set(client, items.map((d) => [d.clock, d.len] as [number, number]));
    return { structs, deletes };
  }

  private frame(kind: number, payload: Uint8Array): Buffer {
    return Buffer.concat([Buffer.of(kind), Buffer.from(payload)]);
  }

  /** 방의 저장 상태 알림 (FR-1011) */
  private statusFrame(room: Room): Buffer {
    const status: CollabStatus = { saveBlocked: room.saveBlocked };
    return this.frame(COLLAB_MSG.status, Buffer.from(JSON.stringify(status), 'utf8'));
  }

  /**
   * **자동 저장이 멈췄는지 방의 모두에게 알린다** (P9_설계서_Gate D.9, FR-1011). 까닭이 바뀔 때만 보낸다.
   *
   * 멈춘 것을 로그로만 남기면 편집하는 사람은 저장되는 줄 알고 계속 쓴다 — 동료의 화면에는 보이니 더 그렇다. 나가면서
   * 사라지는 줄도 모른다. 까닭은 검증이 낸 문장이다: 자리와 노드·속성의 이름뿐이고 값은 없다 (7절).
   */
  private announceSave(room: Room, reason: string | null): void {
    if (room.saveBlocked === reason) return;
    room.saveBlocked = reason;
    const data = this.statusFrame(room);
    for (const m of room.members) if (m.socket.readyState === m.socket.OPEN) m.socket.send(data);
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

  /**
   * 그 사용자의 열린 편집 연결을 끊는다 (FR-805).
   *
   * `sid`를 주면 **그 세션의 연결만** 끊는다 — 로그아웃은 누른 브라우저 하나의 일이다.
   */
  private closeFor(userId: string, why: string, sid?: string): void {
    let n = 0;
    for (const room of this.rooms.values()) {
      for (const m of [...room.members]) {
        if (m.principal.id !== userId) continue;
        if (sid && m.sid !== sid) continue;
        this.revoke(room, m, why);
        n += 1;
      }
    }
    if (n) this.log.log(`${why} — 편집 연결 ${n}개를 끊었다 (user=${userId}${sid ? ', 이 세션만' : ''})`);
  }

  /**
   * 한 연결을 끊는다.
   *
   * **순서가 중요하다.** 표시하고 → 방에서 빼고 → 닫는다. 닫기부터 하면 답하지 않는
   * 클라이언트가 30초 동안 계속 쓰고, 그 사이 `recheck`도 이미 본 것으로 여겨 다시 안 본다.
   */
  private revoke(room: Room, member: Member, why: string, code = CLOSE_REVOKED): void {
    member.revoked = true;
    room.members.delete(member);
    if (room.members.size === 0) room.emptyAt = Date.now();
    member.socket.close(code, why);
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
      // sweep 자체는 기다렸지만, 그 안에서 띄운 메일 같은 뒷일은 아직 떠 있을 수 있다
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
      if (!reason) {
        // **실제로 고치고 있는 사람의 세션은 이어 준다.**
        // `sessions.expire`는 HTTP 요청으로만 갱신된다. WebSocket으로만 30분 넘게 편집하면
        // 유휴 만료에 걸려 **작업 중에 쫓겨난다** (P7 자체 점검 13).
        // **열어만 둔 탭은 이어 주지 않는다** — 그러면 유휴 타임아웃이 뜻을 잃는다.
        // 직전 주기 안에 이 사람이 실제로 문서를 바꿨을 때만이다
        const typing = room.lastActor === m.principal.id && now - room.lastChangeAt < this.env.WF_COLLAB_RECHECK_MS;
        if (typing) {
          const idleMs = (await this.settings.get()).sessionIdleMinutes * 60_000;
          await this.db.execute(
            sql`UPDATE sessions SET expire = now() + make_interval(secs => ${Math.round(idleMs / 1000)}) WHERE sid = ${m.sid}`,
          );
        }
        continue;
      }
      this.log.log(`편집 연결을 끊는다 — ${reason} (user=${m.principal.id})`);
      this.revoke(room, m, reason);
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
    // **던지면 방에 알리고 다시 던진다** (P9 세 번째 코드 리뷰 3·자체 점검 1). 저장 트랜잭션만이 아니라 그 앞의 정본 읽기도 DB를
    // 탄다 — DB가 흔들리면 거기서 먼저 던진다. 전에는 아무 알림이 없어 옛 까닭이 남거나 화면이 아무것도 몰랐다
    const next = prior
      .then(() => this.runSave(pageId, room, trigger))
      .catch((e: unknown) => {
        if (this.rooms.get(pageId) === room) this.announceSave(room, SAVE_FAILED_REASON);
        throw e;
      });
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
    // **멘션을 만든 사람을 `next`와 같은 순간에 읽는다** (P8 C.3절). 아래 `await` 사이에 문서가
    // 더 바뀌면, 나중에 읽은 표는 저장되는 본문과 짝이 맞지 않는다. 자리는 마지막 변경 때 훑어 둔 것이다
    const mentionedBy = room.attributionBroken ? new Map<string, (string | null)[]>() : makersFor(room.ledger.makers, room.sites);
    const savedNames = new Set(room.sites.map((s) => s.name));
    const seqAtStart = room.ledger.seq;
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
    // 검증이 가장 먼저라 오류가 없는 판정은 전부 "검증을 지났다"다 — 내용이 그대로여도, 아직 편집 중이어도.
    // **저장하는 판정은 커밋한 뒤에 푼다** — 먼저 풀면 저장이 실패해도 화면은 다시 저장되는 줄 안다 (P9 두 번째 코드 리뷰 5)
    if (!decision.save) this.announceSave(room, blockedReason(decision.errors));

    if (!decision.save) {
      if (decision.errors.length) {
        // **버전을 만들지 않는다** (FR-708). 까닭은 위에서 방의 화면에 알렸고(FR-1011) 여기서는 로그에 남긴다. 실시간 상태는
        // 살아 있으므로 사람이 화면에서 고칠 수 있다 — 여기서 저장하면 깨진 것이 정본이 된다
        this.log.warn(`검증 실패로 저장하지 않았다 (page=${pageId}): ${decision.errors.slice(0, 3).join(' / ')}`);
      }
      await this.rememberState(pageId, room, current.currentVersionNo);
      // **바뀌지 않은 문서로 다시 판정하지 않는다.** 내용이 그대로이거나 검증에 실패한 것은 다음 변경이 오기 전까지 같은
      // 판정이 난다 — 그대로 두면 `sweep`이 매초 질의 둘과 상태 쓰기를 되풀이하고, 검증 실패는 매초 경고를 남긴다
      // (P8 FR-910 — P6 코드 리뷰 13이 "아직 편집 중"만 막았다). 판정하는 사이 들어온 변경은 그대로 둔다
      if (room.lastChangeAt === changedAt) room.lastChangeAt = 0;
      // **검증에 실패한 상태는 지우지 않는다.** 지우면 고칠 기회가 사라진다 (자체 점검 6).
      // **다만 사람이 남아 있으면 방도 지우지 않는다** — 지우면 그 사람들은 맵에 없는 방에서
      // 계속 편집하고 아무도 저장하지 않는다. 다음에 들어온 사람은 두 번째 방을 만들어
      // 둘이 갈린다. 사람이 누른 저장(`manual`)에서 실제로 일어난다 (P7 자체 점검 3)
      if (trigger !== 'idle' && room.members.size === 0 && room.joining === 0) {
        if (decision.errors.length) this.drop(pageId, room);
        else await this.finish(pageId, room);
      }
      this.lastDecision.set(pageId, decision);
      return;
    }

    this.lastDecision.set(pageId, decision);
    const actor = room.lastActor ?? current.updatedBy;
    const collected: MentionOutcome[] = [];
    let savedVersionNo = current.currentVersionNo + 1;
    await this.db.transaction(async (tx) => {
      const saved = await this.pagesSvc.saveCollabVersion(pageId, title, next, actor, tx, mentionedBy, (m) => collected.push(m));
      // **락 안에서 만들어진 번호를 쓴다.** 밖에서 계산한 `+1`은 REST 저장과 겹치면
      // 실제와 다른 번호가 감사로그에 남는다 (P6 코드 리뷰 16)
      savedVersionNo = saved.currentVersionNo;
      await this.audit.record(
        { action: 'page.collab.save', actorId: actor, targetType: 'page', targetId: pageId, detail: { versionNo: savedVersionNo, trigger } },
        tx,
      );
    });
    this.announceSave(room, null);
    // 메일은 **커밋 뒤에** 보낸다 (FR-754). 기다리지 않는다.
    // **기본 이름을 넘기지 않는다** — 자동 저장의 actor는 "마지막으로 키를 누른 사람"이라
    // 그 이름을 적으면 틀린 사람이 적힌다 (P6 코드 리뷰 6). 만든 사람을 아는 받는 사람에게는
    // `recipients[].calledBy`가 그 이름을 싣고 간다 (P8 FR-905)
    const mentions = collected[0];
    // **메일 감사의 "누가"도 마지막으로 키를 누른 사람이 아니다** (P8 코드 리뷰 3). 부른 사람이 한 사람이면
    // 그 사람, 여럿이거나 모르면 비운다 — 감사로그는 고칠 수 없으므로 틀린 이름보다 빈칸이 낫다
    if (mentions?.count) {
      const callers = new Set(mentions.recipients.map((r) => r.calledById));
      const caller = callers.size === 1 ? [...callers][0] : null;
      this.track(this.mentionMail.notify(mentions, null, title, caller ?? undefined));
    }
    room.versionNo = savedVersionNo;
    // **저장된 버전에 있는 이름은 옮김 기억에서 잊는다** (C.2절) — 다시 생겨도 새 멘션이 아니다. 다만 **저장을 시작한 뒤에**
    // 적힌 것은 이 버전에 없는 일이라 남긴다 (네 번째 코드 리뷰 1). 버전에 없는 이름도 그대로 둔다: 잘라낸 채 저장되고
    // 그 뒤에 붙여 넣는 것도 옮김이다
    room.ledger = settle(room.ledger, savedNames, seqAtStart);
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
    // **만든 사람 표를 상태와 같은 쓰기에서 남긴다** (FR-903). 따로 쓰면 둘 중 하나만 남는 순간이 생기고,
    // 그때 죽으면 상태에는 있는 멘션을 누가 만들었는지 표가 모른다
    const authors = ledgerToJson(room.ledger);
    await this.db
      .insert(pageRealtime)
      .values({ pageId, state, versionNo, updatedBy: room.lastActor, authors })
      .onConflictDoUpdate({
        target: pageRealtime.pageId,
        set: { state, versionNo, updatedBy: room.lastActor, authors, updatedAt: sql`now()` },
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
  async flush(pageId: string, title?: string): Promise<{ saved: boolean; reason: string }> {
    const room = this.rooms.get(pageId);
    if (!room) return { saved: false, reason: '편집 중인 사람이 없다' };
    // **제목도 함께 남긴다.** 협업 모드에서도 제목은 평범한 입력칸이고, 그것을 안 보내면
    // 사람이 고친 제목이 조용히 버려진다 (자체 점검 3)
    if (title) room.title = title;
    this.lastDecision.delete(pageId);
    await this.saveIfNeeded(pageId, 'manual');
    const d = this.lastDecision.get(pageId);
    this.lastDecision.delete(pageId);
    // **"방이 있었다"를 "남겼다"로 답하면 안 된다.** 검증에 실패했는데 화면이 보기로
    // 넘어가면 사람은 저장됐다고 믿는다 (P7 자체 점검 3)
    if (!d) return { saved: false, reason: '남길 것이 없다' };
    return d.save ? { saved: true, reason: '' } : { saved: false, reason: d.reason };
  }
}
