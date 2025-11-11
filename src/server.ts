import express, { Request, Response } from 'express';
import http from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import Docker, { Container } from 'dockerode';
import url from 'url';
import { Readable } from 'stream';
import type { IncomingMessage } from 'http';
import { launchOptions, OptionConfig } from './config/launchOptions';
import cors from 'cors';

type LogClients = {
  stream: Readable,
  clients: Set<WebSocket>
};
const logStreams = new Map<string, LogClients>();

const sharedConfig: Partial<Docker.ContainerCreateOptions> = {
  Tty: true,
  HostConfig: {
    Privileged: true,
    NetworkMode: 'host',
    AutoRemove: false,
    Runtime: 'nvidia',
    IpcMode: 'host',
    Binds: [
        '/dev/serial/by-id:/dev/serial/by-id',
        '/dev/v4l/by-id:/dev/v4l/by-id',
        '/usr/local/zed:/usr/local/zed',
    ]
  }
};

const docker = new Docker({ socketPath: '/var/run/docker.sock' });
const app = express();
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'DELETE', 'PUT', 'OPTIONS'],
  allowedHeaders: ['Content-Type']
}));
app.use(express.json());

const server = http.createServer(app);
const wss = new WebSocketServer({ server });
const clients = new Map<WebSocket, Readable>();
const sseClients: Response[] = [];

async function getContainerByName(name: string): Promise<Container | null> {
  try {
    const containers = await docker.listContainers({ all: true });
    const containerInfo = containers.find(c => c.Names.includes(`/${name}`));
    if (containerInfo) {
      return docker.getContainer(containerInfo.Id);
    }
    return null;
  } catch (err) {
    console.error('Error retrieving container by name:', err);
    return null;
  }
}

async function getContainerId(container: Container): Promise<string | null> {
  try {
    const info = await container.inspect();
    return info.Id;
  } catch (err) {
    console.error('Error retrieving container ID:', err);
    return null;
  }
}

app.get('/options', async (req: Request, res: Response) => {
  const options = await Promise.all(Object.entries(launchOptions).map(async ([key, config]) => {
    const container = await getContainerByName(`${key}-instance`);
    const info = container ? await container.inspect() : null;
    const isRunning = info?.State?.Running ?? false;
    const status = isRunning ? 'running' : 'stopped';
    const startTime = info?.State?.StartedAt ?? null;
    const id = info?.Id ?? null;
    const protocol = req.protocol === 'https' ? 'wss' : 'ws';
    const host = req.headers.host;
    const logsWsUrl = isRunning ? `${protocol}://${host}/logs?id=${id}` : null;
    const cmd = config.command ? config.command.join(' ') : '';

    return {
      key,
      description: `Launch option for ${key}`,
      image: config.image,
      cmd,
      status,
      startTime,
      id,
      logsWsUrl
    };
  }));
  res.json(options);
});

// GET /events/:id - SSE stream for a specific option
app.get('/events', (req: Request, res: Response) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  sseClients.push(res);

  req.on('close', () => {
    const index = sseClients.indexOf(res);
    if (index !== -1) sseClients.splice(index, 1);
  });
});

wss.on('connection', async (ws: WebSocket, req: IncomingMessage) => {
  const parsed = url.parse(req.url || '', true);
  if (!parsed.pathname || parsed.pathname !== '/logs') {
    ws.close(1008, 'Invalid WebSocket path');
    return;
  }

  const containerId = parsed.query.id as string | undefined;
  if (!containerId) {
    ws.send('Missing container ID');
    ws.close();
    return;
  }

  let logClients = logStreams.get(containerId);
  if (!logClients) {

    try {
      const container = docker.getContainer(containerId);
      const info = await container.inspect();
      if (!info.State.Running) {
        ws.send(`Container ${containerId} is not running. Logs may be incomplete.`);
      }

      container.logs({ follow: true, stdout: true, stderr: true }, (err, stream) => {
        if (err || !stream) {
          ws.send(`Error retrieving logs: ${err?.message || 'Unknown error'}`);
          ws.close();
          return;
        }

        const nodeStream = stream as Readable;
        const clientsSet = new Set<WebSocket>();
        clientsSet.add(ws);

        logStreams.set(containerId, { stream: nodeStream, clients: clientsSet });

        nodeStream.on('data', chunk => {
          for (const client of clientsSet) {
            if (client.readyState === client.OPEN) {
              client.send(chunk.toString());
            }
          }
        });

        nodeStream.on('error', err => {
          console.error('Log stream error:', err);
          for (const client of clientsSet) {
            if (client.readyState === client.OPEN) {
              client.send(`Log stream error: ${err.message}`);
              client.close();
            }
          }
          logStreams.delete(containerId);
        });

        nodeStream.on('end', () => {
          for (const client of clientsSet) {
            if (client.readyState === client.OPEN) {
              client.close();
            }
          }
          logStreams.delete(containerId);
        });
      });

    } catch (err) {
      ws.send(`Container not found`);
      ws.close();
      return;
    }
  } else {
    logClients.clients.add(ws);
  }

  ws.on('close', () => {
    const logClients = logStreams.get(containerId);
    if (!logClients) return;
    logClients.clients.delete(ws);
    if (logClients.clients.size === 0) {
      logClients.stream.destroy();
      logStreams.delete(containerId);
    }
  });
});

app.post('/start/:option', async (req, res) => {
  const option = req.params.option;
  const optionConfig = launchOptions[option];
  const containerName = `${option}-instance`;

  if (!optionConfig) {
    return res.status(400).json({ error: 'Invalid option' });
  }

  try {
    const existing = await getContainerByName(containerName);
    if (existing) {
      const info = await existing.inspect();

      if (info.State.Running) {
        return res.status(409).json({ error: 'Container already running for this option' });
      }

      console.log(`Removing existing container: ${containerName}`);
      await existing.remove();
    }
    const containerConfig: Docker.ContainerCreateOptions = {
      ...sharedConfig,
      Image: optionConfig.image,
      Cmd: optionConfig.command,
      name: containerName,
    };

    const container = await docker.createContainer(containerConfig);
    await container.start();
    res.json({ status: 'started', id: container.id });

    // Alert all other clients:
    const message = {
      event: 'starting',
      container: option,
      timestamp: new Date().toISOString()
    };
    const data = `data: ${JSON.stringify(message)}\n\n`;
    sseClients.forEach(client => client.write(data));

  } catch (err: any) {
    console.log("Error starting container:", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/stop/:option', async (req: Request, res: Response) => {
  try {
    const option = req.params.option;
    const container = await getContainerByName(`${option}-instance`);
    if (!option || !container) {
      return res.status(404).json({ error: 'Container not found' });
    }

    const message = {
      event: 'stopping',
      container: option,
      timestamp: new Date().toISOString()
    };
    console.log(`Stopping container: ${option}`);

    const data = `data: ${JSON.stringify(message)}\n\n`;
    sseClients.forEach(client => client.write(data));

    // Send SIGINT to trigger ros2 graceful shutdown
    await container.kill({ signal: 'SIGINT' });

    // After 10s, check if still running → force kill
    setTimeout(async () => {
      try {
        const inspect = await container.inspect();
        if (inspect.State.Running) {
          console.log(`Container ${option} still running, sending SIGKILL`);
          await container.kill({ signal: 'SIGKILL' });
        }
      } catch (e: any) {
        console.log(`Container ${option} may already be stopped:`, e.message);
      }
    }, 10000);

    res.json({ status: 'SIGINT sent, will SIGKILL after 10s if needed' });
  } catch (err: any) {
    console.log("Error stopping container:", err.message);
    res.status(500).json({ error: err.message });
  }
});

(async () => {
  const eventStream = await docker.getEvents();
  eventStream.on('data', buffer => {
    try {
      const event = JSON.parse(buffer.toString());

      if (event.status === 'die') {
        const containerName = event.Actor?.Attributes?.name ?? 'unknown';
        const exitCode = event.Actor?.Attributes?.exitCode ?? 'unknown';

        console.log(`Container ${containerName} exited with code ${exitCode}`);

        const id = Object.entries(launchOptions)
          .find(([key]) => `${key}-instance` === containerName)?.[0];

        if (id) {
          const message = {
            event: 'exit',
            container: containerName,
            code: exitCode,
            timestamp: new Date(event.time * 1000).toISOString()
          };
          const data = `data: ${JSON.stringify(message)}\n\n`;
          sseClients.forEach(client => client.write(data));
        } else {
          console.warn(`Unknown container for name: ${containerName}`);
        }
      }
    } catch (err) {
      console.error('Error handling Docker event:', err);
    }
  });
})();

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
