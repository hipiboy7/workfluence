import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import {
  CHAT_CLOSE,
  encodeChatFrame,
  parseChatClientFrame,
  scopeAllows,
  type ApiTokenScope,
  type ChatMessageView,
  type ChatServerFrame,
} from '@workfluence/shared';
import { sql } from 'drizzle-orm';
import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type RawData, type WebSocket } from 'ws';
import { ApiTokensService } from '../api-tokens/api-tokens.service';
import { parseBearer } from '../api-tokens/domain/jwt';
import { RevocationBus } from '../common/revocation.bus';
import { logLine } from '../common/log-line';
import { APP_ENV, type AppEnvToken } from '../config/config.module';
import { DB, type Db } from '../db/db.module';
import { readClientIp, readSessionId } from '../pages/collab/session-auth';
import { SettingsService } from '../settings/settings.service';
import { UsersService } from '../users/users.service';
import { ChatHub } from './chat.hub';
import { ChatService } from './chat.service';
import { readChatWsPath, type ChatWsKind } from './domain/ws-path';

type Conn = {
  ws: WebSocket;
  userId: string;
  kind: ChatWsKind;
  /** 세션 연결 — 로그아웃은 그 세션의 연결만 끊는다 */
  sid: string | null;
  /** 토큰 연결 — 그 토큰이 폐기되면 끊는다 */
  tokenId: string | null;
  canWrite: boolean;
  alive: boolean;
  lastCheckedAt: number;
  openedAt: number;
  /** 이 연결의 프레임을 **받은 순서대로** 하나씩 처리하는 줄 — 한 클라이언트가 연달아 보낸 메시지가 뒤바뀌지 않게 */
  chain: Promise<void>;
};

/**
 * 채팅 WebSocket (P21_설계서_Chat C절). **한 연결이 참여한 모든 방의 새 메시지를 받는다.** 입구는 둘 — 화면(`/api/chat/ws`, 세션 쿠키 + 같은 출처)과
 * headless(`/api/v1/chat/ws`, `Authorization: Bearer`) — 이고 인증이 끝나면 같은 코드로 합쳐진다.
 *
 * **쓰기는 `ChatService.send` 한 곳이다.** 이 클래스는 메시지를 DB에 직접 쓰지 않고, `ChatHub`가 알리는 것을 연결로 내보낼 뿐이다.
 * 끊기: 세션을 모두 끊으면(비밀번호 변경·강제 종료·정지) 그 사용자의 연결 전부, 로그아웃은 그 세션의 연결만, 토큰 폐기는 그 토큰의 연결만 즉시 끊고
 * 그 밖의 변화(만료·권한)는 주기 재판정(`WF_CHAT_RECHECK_MS`)이 끊는다 — 실시간 편집(Phase 7)과 같은 두 겹이다.
 *
 * **켜져 있든 꺼져 있든 업그레이드 처리기를 붙인다.** 꺼져 있으면 채팅 경로를 404로 닫는다 — 편집 게이트웨이는 채팅 경로를 일부러 건드리지 않으므로 이쪽이
 * 닫지 않으면 응답 없이 열려 남는다(P6 자체 점검 13과 같은 사고)
 */
@Injectable()
export class ChatGateway implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('ChatGateway');
  private wss?: WebSocketServer;
  private readonly conns = new Set<Conn>();
  private pingTimer?: NodeJS.Timeout;
  private recheckTimer?: NodeJS.Timeout;
  private readonly unsubscribers: (() => void)[] = [];

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(APP_ENV) private readonly env: AppEnvToken,
    private readonly chat: ChatService,
    private readonly hub: ChatHub,
    private readonly users: UsersService,
    private readonly tokens: ApiTokensService,
    private readonly settings: SettingsService,
    private readonly revocation: RevocationBus,
  ) {}

  onModuleInit(): void {
    this.unsubscribers.push(
      this.revocation.onRevoke((userId, sid) => this.closeWhere((c) => c.userId === userId && (sid === undefined || c.sid === sid), '세션 파기', userId)),
      this.revocation.onRevokeToken((tokenId) => this.closeWhere((c) => c.tokenId === tokenId, '토큰 폐기')),
      this.hub.onMessage((memberIds, m) => this.deliverMessage(memberIds, m)),
      this.hub.onRoom((userId, roomId, change) => this.send(userId, { type: 'room', roomId, change })),
    );
  }

  /** `main.ts`가 부른다 — 편집 게이트웨이와 같은 HTTP 서버에 붙는다(포트·nginx 설정을 늘리지 않는다) */
  attach(server: Server): void {
    if (this.env.WF_CHAT_ENABLED) {
      this.wss = new WebSocketServer({ noServer: true, maxPayload: this.env.WF_CHAT_MAX_FRAME_BYTES });
      this.pingTimer = setInterval(() => this.heartbeat(), this.env.WF_CHAT_PING_MS);
      this.recheckTimer = setInterval(() => void this.recheck(), Math.max(1_000, Math.min(this.env.WF_CHAT_RECHECK_MS, 30_000)));
      this.log.log(logLine('chat.enabled', '채팅 켜짐', { pingMs: this.env.WF_CHAT_PING_MS, recheckMs: this.env.WF_CHAT_RECHECK_MS }));
    } else {
      this.log.log(logLine('chat.disabled', '채팅이 꺼져 있다 (WF_CHAT_ENABLED=false)'));
    }
    server.on('upgrade', (req, socket, head) => void this.upgrade(req, socket, head));
  }

  async onModuleDestroy(): Promise<void> {
    if (this.pingTimer) clearInterval(this.pingTimer);
    if (this.recheckTimer) clearInterval(this.recheckTimer);
    for (const u of this.unsubscribers) u();
    for (const c of [...this.conns]) c.ws.close(1001, 'server shutdown');
    this.conns.clear();
    this.wss?.close();
  }

  /** 지금 열린 연결 수 — 시험과 운영 점검용 */
  get connectionCount(): number {
    return this.conns.size;
  }

  // ---- 연결 ----

  private async upgrade(req: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    const kind = readChatWsPath(req.url);
    if (!kind) return; // 편집 게이트웨이의 경로다
    // 원시 소켓의 error를 받아 둔다 — 상대가 먼저 끊으면 Node가 uncaught로 올린다
    socket.on('error', () => undefined);

    const refuse = (status: '401 Unauthorized' | '404 Not Found' | '403 Forbidden'): void => {
      socket.write(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`);
      socket.destroy();
    };
    if (!this.wss) return refuse('404 Not Found');

    try {
      const auth = kind === 'session' ? await this.authSession(req) : await this.authToken(req);
      if (!auth) return refuse('401 Unauthorized');
      if (!auth.canRead) return refuse('403 Forbidden');
      const roomIds = await this.chat.roomIdsOf(auth.userId);
      const ip = readClientIp(req.headers['x-forwarded-for'], req.socket.remoteAddress, this.env.WF_TRUST_PROXY);
      this.wss.handleUpgrade(req, socket, head, (ws) => this.join(ws, kind, auth, roomIds, ip));
    } catch (e) {
      this.log.error(logLine('chat.upgrade_failed', '채팅 연결 업그레이드 실패', { kind }, e));
      refuse('401 Unauthorized');
    }
  }

  /**
   * 화면 — 같은 출처 + 세션 쿠키. **호스트만 본다**(스킴은 보지 않는다 — 앞단이 TLS를 끝내면 스킴이 갈린다, 편집 게이트웨이 FR-806의 같은 판단).
   * 브라우저는 `Origin`을 반드시 붙인다
   */
  private async authSession(req: IncomingMessage): Promise<{ userId: string; sid: string; tokenId: null; canRead: true; canWrite: true } | null> {
    const origin = req.headers.origin;
    const host = req.headers.host;
    if (!origin || !host) return null;
    try {
      if (new URL(origin).host !== host) return null;
    } catch {
      return null;
    }
    const sid = readSessionId(req.headers.cookie, this.env.WF_SESSION_SECRET);
    if (!sid) return null;
    const live = await this.sessionState(sid);
    if (!live) return null;
    const user = await this.users.findById(live.userId);
    if (!user || user.status !== 'active' || user.mustChangePassword) return null;
    return { userId: user.id, sid, tokenId: null, canRead: true, canWrite: true };
  }

  /** headless — `Authorization: Bearer`. 토큰은 질의로 받지 않는다(주소는 로그에 남는다). `Origin`은 보지 않는다 — 브라우저가 아니다 */
  private async authToken(req: IncomingMessage): Promise<{ userId: string; sid: null; tokenId: string; canRead: boolean; canWrite: boolean } | null> {
    const jwt = parseBearer(req.headers.authorization);
    if (!jwt) return null;
    const r = await this.tokens.authenticate(jwt);
    if (!r.ok) return null;
    const scopes: ApiTokenScope[] = r.scopes;
    return { userId: r.user.id, sid: null, tokenId: r.tokenId, canRead: scopeAllows(scopes, ['read']), canWrite: scopeAllows(scopes, ['write']) };
  }

  /** 절대 타임아웃까지 본다 — HTTP 가드와 판정이 갈리지 않게 (편집 게이트웨이 FR-808) */
  private async sessionState(sid: string): Promise<{ userId: string } | null> {
    const found = await this.db.execute<{ sess: { userId?: string; createdAt?: number } }>(sql`SELECT sess FROM sessions WHERE sid = ${sid} AND expire > now()`);
    const sess = found.rows[0]?.sess;
    if (!sess?.userId) return null;
    const policy = await this.settings.get();
    if (!sess.createdAt || Date.now() - sess.createdAt > policy.sessionAbsoluteHours * 3_600_000) return null;
    return { userId: sess.userId };
  }

  private join(
    ws: WebSocket,
    kind: ChatWsKind,
    auth: { userId: string; sid: string | null; tokenId: string | null; canWrite: boolean },
    roomIds: string[],
    ip: string | null,
  ): void {
    const now = Date.now();
    const conn: Conn = {
      ws,
      userId: auth.userId,
      kind,
      sid: auth.sid,
      tokenId: auth.tokenId,
      canWrite: auth.canWrite,
      alive: true,
      lastCheckedAt: now,
      openedAt: now,
      chain: Promise.resolve(),
    };
    // 한 사용자의 동시 연결 상한 — 넘으면 **가장 오래된** 연결을 닫는다(재접속을 되풀이하는 클라이언트가 쌓이지 않게, NFR-241)
    const mine = [...this.conns].filter((c) => c.userId === auth.userId).sort((a, b) => a.openedAt - b.openedAt);
    while (mine.length >= this.env.WF_CHAT_MAX_CONNECTIONS_PER_USER) {
      const oldest = mine.shift()!;
      this.log.log(logLine('chat.evicted', '연결 상한으로 가장 오래된 채팅 연결을 닫았다', { targetUserId: auth.userId, kind: oldest.kind }));
      this.drop(oldest, CHAT_CLOSE.evicted, 'too many connections');
    }
    this.conns.add(conn);
    ws.on('pong', () => (conn.alive = true));
    ws.on('close', () => this.conns.delete(conn));
    ws.on('error', () => this.conns.delete(conn));
    ws.on('message', (data, isBinary) => {
      conn.chain = conn.chain.then(() => this.onFrame(conn, data, isBinary, ip)).catch(() => undefined);
    });
    this.sendTo(conn, { type: 'hello', userId: auth.userId, roomIds });
    // 인증과 이 자리 사이에 세션·토큰이 폐기됐으면 알림을 놓쳤다 — 지금 한 번 더 본다(보안 검토 6)
    void this.verify(conn);
  }

  // ---- 받기 ----

  private async onFrame(conn: Conn, data: RawData, isBinary: boolean, ip: string | null): Promise<void> {
    // **끊은(또는 끊기는) 연결의 프레임은 처리하지 않는다.** `ws.close()`는 닫기 핸드셰이크가 끝날 때까지(최대 30초) 받기를 멈추지 않고, 처리 줄에 이미 쌓인 프레임도 있다 —
    // 세션·토큰이 죽어 끊은 연결이 그 뒤로도 메시지를 쓰지 못하게 한다 (코드 리뷰 3 · 보안 검토 1)
    if (!this.conns.has(conn) || conn.ws.readyState !== conn.ws.OPEN) return;
    if (isBinary) return this.reject(conn, 'binary_frame', ip);
    const parsed = parseChatClientFrame(data.toString(), this.env.WF_CHAT_MAX_MESSAGE_CHARS);
    if (!parsed.ok) {
      if ('recoverable' in parsed) {
        // 그 메시지만 거절한다 — 연결은 둔다
        this.sendTo(conn, { type: 'error', code: parsed.code, roomId: parsed.roomId, ...(parsed.clientMsgId !== undefined ? { clientMsgId: parsed.clientMsgId } : {}) });
        return;
      }
      return this.reject(conn, parsed.code, ip);
    }
    const f = parsed.frame;
    const echo = f.clientMsgId !== undefined ? { clientMsgId: f.clientMsgId } : {};
    if (!conn.canWrite) {
      this.sendTo(conn, { type: 'error', code: 'INSUFFICIENT_SCOPE', roomId: f.roomId, ...echo });
      return;
    }
    try {
      const r = await this.chat.send({ id: conn.userId }, f.roomId, { body: f.body, ...(f.clientMsgId !== undefined ? { clientMsgId: f.clientMsgId } : {}) });
      this.sendTo(conn, { type: 'ack', clientMsgId: f.clientMsgId ?? null, roomId: f.roomId, seq: r.message.seq, createdAt: r.message.createdAt });
    } catch (e) {
      const code = (e as { response?: { code?: string } }).response?.code;
      if (code === 'RATE_LIMITED') this.log.warn(logLine('chat.rate_limited', '채팅 보내기 한도를 넘었다', { targetUserId: conn.userId, kind: conn.kind }));
      if (code) this.sendTo(conn, { type: 'error', code, roomId: f.roomId, ...echo });
      else {
        this.log.error(logLine('chat.send_failed', '채팅 보내기 실패', { kind: conn.kind }, e));
        this.sendTo(conn, { type: 'error', code: 'INTERNAL', roomId: f.roomId, ...echo });
      }
    }
  }

  /** 조작·고장 — 어떤 프레임이었는지는 로그에 남기지 않는다(본문일 수 있다). 까닭의 종류만 */
  private reject(conn: Conn, reason: string, ip: string | null): void {
    this.log.warn(logLine('chat.rejected', '채팅 프레임을 받지 않고 연결을 닫았다', { targetUserId: conn.userId, kind: conn.kind, reason, ip }));
    this.drop(conn, CHAT_CLOSE.badFrame, 'bad frame');
  }

  // ---- 보내기 ----

  private sendTo(conn: Conn, frame: ChatServerFrame): void {
    if (conn.ws.readyState === conn.ws.OPEN) conn.ws.send(encodeChatFrame(frame));
  }

  private send(userId: string, frame: ChatServerFrame): void {
    for (const c of this.conns) if (c.userId === userId) this.sendTo(c, frame);
  }

  private deliverMessage(memberIds: string[], m: ChatMessageView): void {
    const to = new Set(memberIds);
    const frame: ChatServerFrame = { type: 'message', roomId: m.roomId, seq: m.seq, senderId: m.senderId, body: m.body, createdAt: m.createdAt };
    for (const c of this.conns) if (to.has(c.userId)) this.sendTo(c, frame);
  }

  // ---- 끊기·재판정 ----

  private drop(conn: Conn, code: number, reason: string): void {
    this.conns.delete(conn);
    try {
      conn.ws.close(code, reason);
    } catch {
      conn.ws.terminate();
    }
  }

  private closeWhere(pred: (c: Conn) => boolean, why: string, targetUserId?: string): void {
    let n = 0;
    for (const c of [...this.conns]) {
      if (!pred(c)) continue;
      this.drop(c, CHAT_CLOSE.revoked, why);
      n += 1;
    }
    if (n) this.log.log(logLine('chat.revoked', '채팅 연결을 끊었다', { ...(targetUserId ? { targetUserId } : {}), count: n, reason: why }));
  }

  private heartbeat(): void {
    for (const c of [...this.conns]) {
      if (!c.alive) {
        c.ws.terminate();
        this.conns.delete(c);
        continue;
      }
      c.alive = false;
      c.ws.ping();
    }
  }

  /** 이 연결의 세션·토큰이 지금도 살아 있는가 — 아니면 끊는다. 판정을 못 하면 끊지 않는다(다음 주기에 다시 본다) */
  private async verify(conn: Conn): Promise<void> {
    try {
      const live =
        conn.kind === 'session'
          ? (await this.sessionState(conn.sid!)) !== null && (await this.activeUser(conn.userId))
          : await this.tokens.isLive(conn.userId, conn.tokenId!);
      if (!live) this.closeWhere((x) => x === conn, '재판정', conn.userId);
    } catch (e) {
      this.log.warn(logLine('chat.recheck_failed', '채팅 연결 재판정 실패', { targetUserId: conn.userId }, e));
    }
  }

  /** 주기 재판정 — 버스가 닿지 않는 변화(만료·정지)를 잡는다. 연결마다 마지막 판정 시각을 들고 주기가 지난 것만 본다 */
  private async recheck(): Promise<void> {
    const now = Date.now();
    for (const c of [...this.conns]) {
      if (now - c.lastCheckedAt < this.env.WF_CHAT_RECHECK_MS) continue;
      c.lastCheckedAt = now;
      await this.verify(c);
    }
  }

  private async activeUser(userId: string): Promise<boolean> {
    const u = await this.users.findById(userId);
    return !!u && u.status === 'active' && !u.mustChangePassword;
  }
}
