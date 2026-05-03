import { WebSocketServer, WebSocket } from 'ws';
import type { IncomingMessage } from 'http';
import Docker from 'dockerode';
import { Readable } from 'stream';
import url from 'url';

const MAX_WS_BUFFERED_AMOUNT = 1 * 1024 * 1024; // 1 MB

type LogClients = {
  stream: Readable;
  clients: Set<WebSocket>;
  buffer: string[];
  maxBuffer: number;
};

export type LogManagerOptions = {
  /** WebSocket endpoint path (default: "/logs") */
  path?: string;
  /** Number of recent log lines to retrieve and buffer (default: 100) */
  bufferLines?: number;
};

export class LogManager {
  private docker: Docker;
  private path: string;
  private bufferLines: number;
  private logStreams = new Map<string, LogClients>();

  constructor(docker: Docker, opts: LogManagerOptions = {}) {
    this.docker = docker;
    this.path = opts.path ?? '/logs';
    this.bufferLines = Math.max(0, opts.bufferLines ?? 100);
  }

  attach(wss: WebSocketServer) {
    wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
      const parsed = url.parse(req.url || '', true);
      if (!parsed.pathname || parsed.pathname !== this.path) {
        ws.close(1008, 'Invalid WebSocket path');
        return;
      }
      const containerId = parsed.query.id as string | undefined;
      if (!containerId) {
        if (ws.readyState === ws.OPEN) {
          this.safeSend(ws, 'Missing container ID');
        }
        ws.close();
        return;
      }
      this.handleConnection(ws, containerId).catch(err => {
        try {
          if (ws.readyState === ws.OPEN) {
            this.safeSend(ws, `Error: ${err?.message ?? String(err)}`);
          }
        } finally {
          ws.close();
        }
      });
    });
  }

  buildLogsUrl(protocol: 'ws' | 'wss', host: string, containerId: string) {
    return `${protocol}://${host}${this.path}?id=${encodeURIComponent(containerId)}`;
  }

  // ----------------- Internals -----------------
  private safeSend(ws: WebSocket, data: string | Buffer): boolean {
    if (ws.readyState !== WebSocket.OPEN) {
      return false;
    }

    if (ws.bufferedAmount > MAX_WS_BUFFERED_AMOUNT) {
      ws.close(1013, 'Log stream too fast. Stopping to avoid crash.');
      return false;
    }

    ws.send(data);
    return true;
  }

  private async handleConnection(ws: WebSocket, containerId: string) {
    let entry = this.logStreams.get(containerId);

    if (!entry) {
      const container = this.docker.getContainer(containerId);
      const info = await container.inspect().catch(() => null);
      if (!info) {
        if (ws.readyState === ws.OPEN) this.safeSend(ws, 'Container not found');
        ws.close();
        return;
      }
      if (!info.State?.Running && ws.readyState === ws.OPEN) {
        this.safeSend(ws, `Container ${containerId} is not running. Logs may be incomplete.`);
      }

      container.logs(
        {
          follow: true,
          stdout: true,
          stderr: true,
          tail: this.bufferLines,
        },
        (err, stream) => {
          if (err || !stream) {
            try {
              if (ws.readyState === ws.OPEN) {
                this.safeSend(ws, `Error retrieving logs: ${err?.message || 'Unknown error'}`);
              }
            } finally {
              ws.close();
            }
            return;
          }

          const nodeStream = stream as Readable;
          const clientsSet = new Set<WebSocket>([ws]);

          const created: LogClients = {
            stream: nodeStream,
            clients: clientsSet,
            buffer: [],
            maxBuffer: this.bufferLines,
          };
          this.logStreams.set(containerId, created);

          nodeStream.on('data', (chunk: Buffer) => {
            const text = chunk.toString();
            for (const client of created.clients) {
              if (client.readyState === client.OPEN) {
                this.safeSend(client, text);
              }
            }
            this.pushToBuffer(created, text);
          });

          nodeStream.on('error', (e: Error) => {
            console.error('Log stream error:', e);
            for (const client of created.clients) {
              if (client.readyState === client.OPEN) {
                client.send(`Log stream error: ${e.message}`);
                client.close();
              }
            }
            created.stream.destroy();
            this.logStreams.delete(containerId);
          });

          nodeStream.on('end', () => {
            for (const client of created.clients) {
              if (client.readyState === client.OPEN) client.close();
            }
            this.logStreams.delete(containerId);
          });

          ws.on('close', () => this.detachClient(containerId, ws));
        }
      );
    } else {
      // replay buffer then join live
      for (const line of entry.buffer) {
        if (ws.readyState !== ws.OPEN) break;
        if (!this.safeSend(ws, line)) break;
      }
      entry.clients.add(ws);
      ws.on('close', () => this.detachClient(containerId, ws));
    }
  }

  private detachClient(containerId: string, ws: WebSocket) {
    const entry = this.logStreams.get(containerId);
    if (!entry) return;
    entry.clients.delete(ws);
    if (entry.clients.size === 0) {
      entry.stream.destroy();
      this.logStreams.delete(containerId);
    }
  }

  private pushToBuffer(entry: LogClients, chunk: string | Buffer) {
    const text = typeof chunk === 'string' ? chunk : chunk.toString();
    for (const line of text.split(/\r?\n/)) {
      if (!line) continue;
      entry.buffer.push(line);
      if (entry.buffer.length > entry.maxBuffer) entry.buffer.shift();
    }
  }
}
