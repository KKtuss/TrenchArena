import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import { WebSocket } from 'ws';

// Built API package — keeps this POC from re-implementing the gateway.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { ApiServer } = require('../../../../packages/api/dist/src/server') as {
  ApiServer: new (options?: { allowDemoAuth?: boolean }) => {
    listen(port?: number): Promise<number>;
    close(): Promise<void>;
  };
};

const publicDir = join(__dirname, '../../public');

/**
 * Minimal POC host:
 * - PokeArena ApiServer (authority)
 * - static Showdown-client embed page
 * - auto bot for demo-player-2 so one browser can exercise a full choice path
 */
async function main(): Promise<void> {
  const api = new ApiServer({ allowDemoAuth: true });
  const apiPort = await api.listen(0);

  const http = createServer((request, response) => {
    void handleStatic(request, response, apiPort);
  });

  const port = await new Promise<number>((resolve, reject) => {
    http.listen(0, '127.0.0.1', () => {
      const address = http.address();
      if (!address || typeof address === 'string') reject(new Error('No port'));
      else resolve(address.port);
    });
  });

  console.log('Showdown client battle POC');
  console.log(`  UI:  http://127.0.0.1:${port}/`);
  console.log(`  API: ws://127.0.0.1:${apiPort}/ws`);
  console.log('Open the UI as demo-player-1. demo-player-2 is auto-played by the bot.');

  await runOpponentBot(apiPort);
}

async function handleStatic(
  request: IncomingMessage,
  response: ServerResponse,
  apiPort: number,
): Promise<void> {
  const pathname = new URL(request.url ?? '/', 'http://localhost').pathname;
  if (pathname === '/config.js') {
    response.writeHead(200, { 'content-type': 'application/javascript; charset=utf-8' });
    response.end(`window.POKEARENA_POC = ${JSON.stringify({
      wsUrl: `ws://127.0.0.1:${apiPort}/ws`,
      playerId: 'demo-player-1',
    })};`);
    return;
  }

  const file = pathname === '/' ? 'index.html' : pathname.replace(/^\//, '');
  const map: Record<string, string> = {
    'index.html': 'text/html; charset=utf-8',
    'poc-client.js': 'application/javascript; charset=utf-8',
  };
  if (!map[file]) {
    response.writeHead(404);
    response.end('Not found');
    return;
  }
  try {
    response.writeHead(200, { 'content-type': map[file] });
    response.end(readFileSync(join(publicDir, file)));
  } catch {
    response.writeHead(404);
    response.end('Not found');
  }
}

class BotClient {
  readonly socket: WebSocket;
  private readonly messages: any[] = [];
  private readonly waiters: Array<{
    predicate: (message: any) => boolean;
    resolve: (message: any) => void;
  }> = [];

  constructor(port: number) {
    this.socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    this.socket.on('message', raw => {
      const message = JSON.parse(String(raw));
      const waiter = this.waiters.find(item => item.predicate(message));
      if (waiter) {
        this.waiters.splice(this.waiters.indexOf(waiter), 1);
        waiter.resolve(message);
      } else {
        this.messages.push(message);
      }
    });
  }

  async open(): Promise<void> {
    if (this.socket.readyState === WebSocket.OPEN) return;
    await new Promise<void>((resolve, reject) => {
      this.socket.once('open', () => resolve());
      this.socket.once('error', reject);
    });
  }

  send(message: object): void {
    this.socket.send(JSON.stringify({ requestId: randomUUID(), ...message }));
  }

  async waitFor(predicate: (message: any) => boolean, timeoutMs = 120_000): Promise<any> {
    const existing = this.messages.find(predicate);
    if (existing) {
      this.messages.splice(this.messages.indexOf(existing), 1);
      return existing;
    }
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Bot timed out.')), timeoutMs);
      this.waiters.push({
        predicate,
        resolve: message => {
          clearTimeout(timeout);
          resolve(message);
        },
      });
    });
  }
}

function choiceFor(choice: any): any {
  if (choice.type === 'move') return { type: 'move', slot: choice.slot };
  if (choice.type === 'switch') return { type: 'switch', slot: choice.slot };
  return { type: choice.type };
}

async function runOpponentBot(apiPort: number): Promise<void> {
  const bot = new BotClient(apiPort);
  await bot.open();
  bot.send({ type: 'identify', playerId: 'demo-player-2' });
  await bot.waitFor(message => message.type === 'ready' && message.playerId === 'demo-player-2');
  console.log('Opponent bot ready as demo-player-2.');

  for (;;) {
    const snapshot = await bot.waitFor(message => (
      message.type === 'arena.snapshot'
      && Array.isArray(message.snapshot?.openCasualRooms)
      && message.snapshot.openCasualRooms.some((room: any) => (
        room.status === 'open'
        && room.creatorId === 'demo-player-1'
        && room.battleSize === '1v1'
      ))
    ));

    const room = snapshot.snapshot.openCasualRooms.find((candidate: any) => (
      candidate.status === 'open' && candidate.creatorId === 'demo-player-1'
    ));
    if (!room) continue;

    bot.send({ type: 'casual.accept', roomId: room.id });
    await bot.waitFor(message => message.type === 'casual.state' && message.room.id === room.id);
    bot.send({ type: 'casual.ready', roomId: room.id, ready: true });
    await bot.waitFor(message => (
      message.type === 'casual.state'
      && message.room.id === room.id
      && message.room.ready?.['demo-player-2']
    ));
    console.log(`Bot accepted room ${room.id}; waiting for battle start…`);

    const started = await bot.waitFor(message => (
      message.type === 'casual.state'
      && message.room.id === room.id
      && message.room.status === 'battling'
    ));
    bot.send({ type: 'match.subscribe', matchId: started.room.matchId });
    let state = await bot.waitFor(message => message.type === 'match.subscribed');

    while (state.match?.status !== 'completed' && state.type !== 'casual.result') {
      const request = state.state?.request ?? state.view?.request;
      if (request?.choices?.length) {
        bot.send({
          type: 'match.choice',
          matchId: started.room.matchId,
          battleInstanceId: started.room.battleInstanceId ?? state.match.battleInstanceId,
          requestRevision: request.revision,
          choice: choiceFor(request.choices[0]),
        });
      }
      state = await bot.waitFor(message => (
        message.type === 'match.update' || message.type === 'casual.result'
      ));
    }
    console.log('Bot finished a casual match; waiting for the next open room.');
  }
}

void main().catch(error => {
  console.error(error);
  process.exit(1);
});
