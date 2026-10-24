import type { Core } from '@strapi/strapi';
/**
 * DM WebSocket 服务器：attach 到 Strapi 的底层 http.Server。
 *
 * - 用 ws 库 noServer 模式：自己处理 'upgrade' 事件，按路径 '/dm/socket' 拦截，
 *   非 DM 路径放行（避免影响未来其它 WS 端点）。
 * - 鉴权走 ticket 模式（见 ws-auth.ts）；不接受 query 里直接传 JWT。
 * - 心跳：服务端每 25s ping，30s 没收到 pong 则关闭——防止僵尸连接占内存。
 *
 * Strapi v5 的 strapi.server.httpServer 在 bootstrap 阶段已存在但未 listen。
 * 我们在 bootstrap 里 attach upgrade listener 即可，listen() 由 Strapi 完成。
 */
import { WebSocketServer, WebSocket } from 'ws';
import type { IncomingMessage } from 'http';
import type { Socket } from 'net';
import { addWsConnection, publishToUser } from './ws-bus';
import { verifyTicket } from './ws-auth';
import { publishDmTyping } from './dm-typing';

/** WS 路径——不要与 SSE 的 /knock/stream 混用 */
const WS_PATH = '/dm/socket';

/** 心跳间隔（服务端发 ping） */
const HEARTBEAT_MS = 25_000;

/** 客户端最大空闲时间：超过则视为断线，主动 terminate */
const IDLE_TIMEOUT_MS = 60_000;

/** 单条消息最大字节数（防 OOM） */
const MAX_MESSAGE_BYTES = 8 * 1024;

let wss: WebSocketServer | null = null;
let started = false;

/**
 * 在 Strapi bootstrap 阶段调用一次。
 * 多次调用幂等。
 */
export const startWsServer = (strapi: Core.Strapi): void => {
  if (started) return;

  const httpServer = strapi?.server?.httpServer;
  if (!httpServer) {
    strapi?.log?.warn?.('[dm-ws] strapi.server.httpServer not available, ws disabled');
    return;
  }

  wss = new WebSocketServer({ noServer: true });

  httpServer.on('upgrade', (req: IncomingMessage, socket: Socket, head: Buffer) => {
    if (!req.url) return socket.destroy();

    let url: URL;
    try {
      url = new URL(req.url, 'http://placeholder');
    } catch {
      return socket.destroy();
    }

    // 仅拦截 DM 路径，其它路径让其它 upgrade handler 处理
    if (url.pathname !== WS_PATH) return;

    const ticket = url.searchParams.get('ticket');
    if (!ticket) {
      writeUpgradeError(socket, 401, 'ticket required');
      return;
    }

    // 异步验证 ticket
    void verifyTicket(ticket).then((userId) => {
      if (!userId) {
        writeUpgradeError(socket, 401, 'invalid ticket');
        return;
      }
      // socket 仍然存活才能继续 handshake
      if (socket.destroyed) return;
      wss!.handleUpgrade(req, socket, head, (ws) => {
        handleConnection(ws, userId, strapi);
      });
    }).catch((err) => {
      strapi?.log?.warn?.('[dm-ws] ticket verify error', err);
      writeUpgradeError(socket, 500, 'auth error');
    });
  });

  started = true;
  strapi?.log?.info?.(`[dm-ws] WebSocket server listening on ${WS_PATH}`);
};

/**
 * 单连接的生命周期管理：
 * - 注册到 ws-bus（per-user 多连接）
 * - 启心跳（ping / pong + 空闲超时 terminate）
 * - 接收客户端消息：仅处理 ping / typing / subscribe；其余忽略并送 error
 * - 关闭时清理
 */
const handleConnection = (ws: WebSocket, userId: number, strapi: Core.Strapi): void => {
  const remove = addWsConnection(userId, ws);

  // 标记最近一次活跃时间，pong / 任何客户端消息都会刷新
  let lastActivity = Date.now();

  const heartbeat = setInterval(() => {
    if (ws.readyState !== ws.OPEN) {
      clearInterval(heartbeat);
      return;
    }
    if (Date.now() - lastActivity > IDLE_TIMEOUT_MS) {
      // 长时间无任何活跃 → 主动断开（terminate 不发关闭帧，立即释放）
      try { ws.terminate(); } catch { /* noop */ }
      clearInterval(heartbeat);
      return;
    }
    try { ws.ping(); } catch { /* noop */ }
  }, HEARTBEAT_MS);

  ws.on('pong', () => {
    lastActivity = Date.now();
  });

  ws.on('message', (raw, isBinary) => {
    lastActivity = Date.now();
    if (isBinary) return; // 我们只处理文本帧
    // ws RawData 是 Buffer | ArrayBuffer | Buffer[]，统一转 Buffer 后取 length
    const buf = Buffer.isBuffer(raw)
      ? raw
      : Array.isArray(raw)
        ? Buffer.concat(raw)
        : Buffer.from(raw as ArrayBuffer);
    if (buf.length > MAX_MESSAGE_BYTES) {
      sendEvent(ws, { type: 'error', data: { reason: 'message too large' }, at: nowIso() });
      return;
    }

    let msg: any;
    try {
      msg = JSON.parse(buf.toString('utf8'));
    } catch {
      sendEvent(ws, { type: 'error', data: { reason: 'invalid json' }, at: nowIso() });
      return;
    }

    if (!msg || typeof msg.type !== 'string') return;

    switch (msg.type) {
      case 'ping': {
        sendEvent(ws, { type: 'pong', at: nowIso() });
        return;
      }
      case 'typing': {
        // 客户端节流上送 typing 状态；服务端只把它转发给会话内其它在线成员。
        // 本基础设施层不知道会话语义，所以把转发延后到 message controller 提供的
        // 工具函数（见后续 broadcastTyping）。这里只做轻量校验。
        if (typeof msg.conversationId !== 'string' || !msg.conversationId) return;
        // 异步：避免阻塞 ws.message 回调
        publishDmTyping(strapi, msg.conversationId, userId).catch((err) => {
          strapi?.log?.warn?.('[dm-ws] publishDmTyping failed', err);
        });
        return;
      }
      case 'subscribe':
      case 'unsubscribe': {
        // 当前实现：所有事件都按 user 维度推，subscribe/unsubscribe 是一个
        // 性能优化空间——比如只对当前打开的会话推 typing。MVP 不实现，但保留协议位。
        return;
      }
      default:
        sendEvent(ws, {
          type: 'error',
          data: { reason: `unknown type: ${msg.type}` },
          at: nowIso(),
        });
    }
  });

  const cleanup = () => {
    clearInterval(heartbeat);
    remove();
  };

  ws.on('close', cleanup);
  ws.on('error', cleanup);

  // hello 帧：让前端确认握手成功
  sendEvent(ws, { type: 'hello', data: { userId }, at: nowIso() });
};

const writeUpgradeError = (socket: Socket, code: number, reason: string): void => {
  try {
    socket.write(`HTTP/1.1 ${code} ${reason}\r\nConnection: close\r\n\r\n`);
  } catch {
    /* noop */
  }
  socket.destroy();
};

const sendEvent = (ws: WebSocket, event: { type: string; data?: unknown; at: string; conversationId?: string; messageId?: string }): void => {
  try {
    if (ws.readyState === 1) ws.send(JSON.stringify(event));
  } catch {
    /* noop */
  }
};

const nowIso = () => new Date().toISOString();
