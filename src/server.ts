
import express, { Request, Response } from 'express';
import http, { get } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import Docker, { Container } from 'dockerode';
import url from 'url';
import { Readable } from 'stream';
import type { IncomingMessage } from 'http';
import { launchOptions, OptionConfig } from './config/launchOptions';


type WebSocketWithStream = WebSocket & { stream?: Readable };

const sharedConfig: Partial<Docker.ContainerCreateOptions> = {
  Tty: true,
  HostConfig: {
    Privileged: true,
    NetworkMode: 'host',
    AutoRemove: true,
  }
};

/**
 * Retrieves a Docker container by its name.
 * @param name - The name of the container to retrieve.
 * @returns A promise that resolves to the Docker container or null if not found.
 */
async function getContainerByName(name: string): Promise<Container | null> {
    try {
        const docker = new Docker({ socketPath: '/var/run/docker.sock' });
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

async function getContainerById(id: string): Promise<Container | null> {
    try {
        const docker = new Docker({ socketPath: '/var/run/docker.sock' });
        return docker.getContainer(id);
    } catch (err) {
        console.error('Error retrieving container by ID:', err);
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

const docker = new Docker({ socketPath: '/var/run/docker.sock' });
const app = express();
app.use(express.json());

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const clients = new Map<WebSocket, Readable>();

// SSE clients per option key
const sseClientsById: Record<string, Response[]> = {};
Object.keys(launchOptions).forEach(opt => sseClientsById[opt] = []);

// GET /options - return available launch option keys
app.get('/options', async (req: Request, res: Response) => {
  const options = await Promise.all(Object.entries(launchOptions).map(async ([key, config]) => {
    const container = await getContainerByName(`${key}-instance`);
    const id = container ? await getContainerId(container) : null;
    const status = container ? 'running' : 'stopped';
    const startTime = container ? (await container.inspect()).State.StartedAt : null;
    const protocol = req.protocol === 'https' ? 'wss' : 'ws';
    const host = req.headers.host;
    const logsWsUrl = container ? `${protocol}://${host}/logs?id=${id}` : null;
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
app.get('/events/:id', (req: Request, res: Response) => {
  const id = req.params.id;
  if (!sseClientsById[id]) {
    return res.status(400).json({ error: 'Invalid option ID' });
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  sseClientsById[id].push(res);

  req.on('close', () => {
    const index = sseClientsById[id].indexOf(res);
    if (index !== -1) sseClientsById[id].splice(index, 1);
  });
});

wss.on('connection', (ws: WebSocketWithStream, req: IncomingMessage) => {
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

  const container = docker.getContainer(containerId);
  container.logs({ follow: true, stdout: true, stderr: true }, (err, stream) => {
    if (err || !stream) {
        ws.close();
        return;
    }

    const nodeStream = stream as Readable;

    ws.stream = nodeStream;
    clients.set(ws, nodeStream);

    nodeStream.on('data', chunk => {
        if (ws.readyState === ws.OPEN) {
        ws.send(chunk.toString());
        }
    });

    ws.on('close', () => {
        nodeStream.destroy();
        clients.delete(ws);
    });
  });
});

app.post('/start/:option', async (req, res) => {
  const option = req.params.option;
  const optionConfig = launchOptions[option];
  const containerName = `${option}-instance`;

  if (!optionConfig) {
    return res.status(400).json({ error: 'Invalid option' });
  }

  if (await getContainerByName(containerName)) {
    return res.status(409).json({ error: 'Container already running for this option' });
  }

  try {
    const containerConfig: Docker.ContainerCreateOptions = {
      ...sharedConfig,
      Image: optionConfig.image,
      Cmd: optionConfig.command,
      name: `${option}-instance`,
    };

    const container = await docker.createContainer(containerConfig);
    await container.start();
    res.json({ status: 'started', id: container.id });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/stop/:id', async (req: Request, res: Response) => {
  try {
    const container = await getContainerById(req.params.id);
    if (!container) {
      return res.status(404).json({ error: 'Container not found' });
    }
    await container.stop();
    res.json({ status: 'stopped' });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

(async () => {
  const eventStream = await docker.getEvents();
  eventStream.on('data', buffer => {
    const event = JSON.parse(buffer.toString());
    if (event.status === 'die') {
      const message = {
        event: 'exit',
        container: event.Actor.Attributes.name,
        code: event.Actor.Attributes.exitCode,
        timestamp: new Date(event.time * 1000).toISOString()
      };
      const containerName = event.Actor?.Attributes?.name ?? 'unknown';
      console.log(`Container ${message.container} exited with code ${message.code}`);
      const id = Object.entries(launchOptions).find(([key]) => `${key}-instance` === containerName)?.[0];
      if (id) {
        const data = `data: ${JSON.stringify(message)}\n\n`;
        sseClientsById[id].forEach(client => client.write(data));
      }
    }
  });
})();

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
