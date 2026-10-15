// WebSocket connection to the game server, with a wake-up ping for Render's
// free tier (the server sleeps when idle and takes a little while to start).
import { PROTOCOL_VERSION, type ClientMessage, type ServerMessage } from '@kelia/shared';
import { SERVER_HTTP, SERVER_URL } from '../config';
import { perf } from '../core/perf';

type Handler<T extends ServerMessage['t']> = (msg: Extract<ServerMessage, { t: T }>) => void;

export class Net {
  private ws: WebSocket | null = null;
  private handlers = new Map<string, Set<(m: ServerMessage) => void>>();
  /** serverTime ≈ Date.now() + clockOffset */
  clockOffset = 0;
  rtt = 0;
  private pingTimer = 0;
  onClose: ((reason: string) => void) | null = null;
  private closedByUs = false;

  on<T extends ServerMessage['t']>(type: T, fn: Handler<T>) {
    let set = this.handlers.get(type);
    if (!set) this.handlers.set(type, (set = new Set()));
    set.add(fn as (m: ServerMessage) => void);
    return () => set!.delete(fn as (m: ServerMessage) => void);
  }

  /** Wait for an HTTP 200 from /health, retrying while Render boots the server. */
  static async wake(onStatus: (msg: string) => void, signal?: AbortSignal): Promise<{ online: number; max: number } | null> {
    const started = Date.now();
    let attempt = 0;
    while (!signal?.aborted) {
      attempt++;
      try {
        const ctl = new AbortController();
        const timer = setTimeout(() => ctl.abort(), 8000);
        const res = await fetch(`${SERVER_HTTP}/health`, { signal: ctl.signal, cache: 'no-store' });
        clearTimeout(timer);
        if (res.ok) {
          const j = await res.json().catch(() => ({}));
          return { online: j.online ?? 0, max: j.max ?? 10 };
        }
      } catch {
        /* still asleep */
      }
      const waited = (Date.now() - started) / 1000;
      if (waited > 150) return null;
      onStatus(waited < 4 ? 'Reaching the realm…' : `Waking the realm… ${Math.round(waited)}s`);
      await new Promise((r) => setTimeout(r, Math.min(3000, 600 + attempt * 400)));
    }
    return null;
  }

  connect(token: string): Promise<Extract<ServerMessage, { t: 'welcome' }>> {
    return new Promise((resolve, reject) => {
      this.closedByUs = false;
      const ws = new WebSocket(`${SERVER_URL}/ws`);
      this.ws = ws;
      let welcomed = false;
      const offWelcome = this.on('welcome', (m) => {
        welcomed = true;
        offWelcome();
        offErr();
        resolve(m);
      });
      const offErr = this.on('error', (m) => {
        if (!welcomed) {
          offWelcome();
          offErr();
          reject(new Error(m.message));
        }
      });
      ws.onopen = () => {
        this.send({ t: 'hello', v: PROTOCOL_VERSION, token });
        this.startPing();
      };
      ws.onmessage = (ev) => {
        perf.netMessage((ev.data as string).length);
        perf.begin('network');
        try {
          this.dispatch(ev.data as string);
        } finally {
          perf.end('network');
        }
      };
      ws.onclose = () => {
        clearInterval(this.pingTimer);
        if (!welcomed) reject(new Error('Could not reach the server.'));
        else if (!this.closedByUs) this.onClose?.('Connection to the realm was lost.');
      };
      ws.onerror = () => {
        /* onclose follows */
      };
    });
  }

  private dispatch(data: string) {
    let msg: ServerMessage;
    try {
      msg = JSON.parse(data);
    } catch {
      return;
    }
    if (msg.t === 'pong') this.onPong(msg);
    const set = this.handlers.get(msg.t);
    if (set) for (const fn of [...set]) fn(msg);
  }

  send(msg: ClientMessage) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  get connected() {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  /** Estimated current server time (ms). */
  serverNow() {
    return Date.now() + this.clockOffset;
  }

  private startPing() {
    clearInterval(this.pingTimer);
    const ping = () => this.send({ t: 'ping', c: performance.now(), r: Math.round(this.rtt) });
    ping();
    this.pingTimer = window.setInterval(ping, 2000);
  }

  private onPong(m: Extract<ServerMessage, { t: 'pong' }>) {
    const now = performance.now();
    const rtt = now - m.c;
    this.rtt = this.rtt ? this.rtt * 0.8 + rtt * 0.2 : rtt;
    const offset = m.s + rtt / 2 - Date.now();
    this.clockOffset = this.clockOffset ? this.clockOffset * 0.85 + offset * 0.15 : offset;
  }

  close() {
    this.closedByUs = true;
    clearInterval(this.pingTimer);
    this.ws?.close();
    this.ws = null;
  }
}
