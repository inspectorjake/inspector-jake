/**
 * WebSocket server for communication with Chrome extension.
 * Handles tool requests from MCP server and forwards to extension.
 * Includes HTTP health endpoint for silent discovery pre-checks.
 */

import { createServer, type Server as HttpServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { v4 as uuidv4 } from 'uuid';
import type {
  ToolResponse,
  ToolType,
  DiscoveryResponse,
} from '@inspector-jake/shared';
import { log } from './logger.js';

export interface WsServerInstance {
  port: number;
  sendToolRequest: (type: ToolType, payload: unknown) => Promise<ToolResponse>;
  isConnected: () => boolean;
  getDiscoveryInfo: () => DiscoveryResponse;
  setSessionName: (name: string) => void;
  close: () => void;
}

interface PendingRequest {
  resolve: (response: ToolResponse) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
}

export async function createWsServer(port: number): Promise<WsServerInstance> {
  return new Promise((resolve, reject) => {
    const pendingRequests = new Map<string, PendingRequest>();
    let clientSocket: WebSocket | null = null;
    let sessionName: string = '';
    let connectedTabInfo: { id: number; title: string; url: string } | undefined;

    // Create HTTP server for health endpoint (enables silent discovery pre-checks)
    const httpServer: HttpServer = createServer((req, res) => {
      // CORS headers for cross-origin fetch from extension
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

      if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
      }

      if (req.url === '/health' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          status: 'ok',
          session: sessionName,
          connected: clientSocket !== null && clientSocket.readyState === WebSocket.OPEN,
        }));
        return;
      }

      // 404 for other HTTP requests (WebSocket upgrade handled separately)
      res.writeHead(404);
      res.end();
    });

    // Create WebSocket server attached to HTTP server
    const wss = new WebSocketServer({ server: httpServer });

    // Handle WebSocketServer errors (fires when httpServer fails to bind)
    wss.on('error', (err) => {
      // Swallow - httpServer error handler will reject the promise
      log.debug('WS', 'WebSocketServer error (expected during port scan):', (err as Error).message);
    });

    httpServer.on('error', (err) => {
      reject(err);
    });

    httpServer.listen(port, '127.0.0.1', () => {
      // Server started successfully
      log.info('WS', `HTTP/WebSocket server listening on 127.0.0.1:${port}`);

      resolve({
        port,

        setSessionName: (name: string) => {
          sessionName = name;
          log.debug('WS', `Session name set to: ${name}`);
        },

        sendToolRequest: (type: ToolType, payload: unknown): Promise<ToolResponse> => {
          return new Promise((resolveReq, rejectReq) => {
            if (!clientSocket || clientSocket.readyState !== WebSocket.OPEN) {
              resolveReq({
                id: '',
                success: false,
                error: "No browser connection. Open the Inspector Jake extension and connect to this session.",
              });
              return;
            }

            const id = uuidv4();
            const request = { id, type, payload };

            // Set timeout for request (30 seconds)
            const timeout = setTimeout(() => {
              pendingRequests.delete(id);
              rejectReq(new Error('Request timed out'));
            }, 30000);

            pendingRequests.set(id, {
              resolve: resolveReq,
              reject: rejectReq,
              timeout,
            });

            clientSocket.send(JSON.stringify(request));
          });
        },

        isConnected: () => {
          return clientSocket !== null && clientSocket.readyState === WebSocket.OPEN;
        },

        getDiscoveryInfo: (): DiscoveryResponse => {
          return {
            name: sessionName as any,
            status: clientSocket ? 'connected' : 'ready',
            connectedTab: connectedTabInfo,
          };
        },

        close: () => {
          wss.close();
          httpServer.close();
        },
      });
    });

    wss.on('connection', (ws, req) => {
      // Handle discovery requests (HTTP upgrade with specific path)
      const url = new URL(req.url || '/', `http://localhost:${port}`);

      if (url.pathname === '/discovery') {
        // Send discovery info and close
        const instance = {
          name: sessionName,
          status: clientSocket ? 'connected' : 'ready',
          connectedTab: connectedTabInfo,
        };
        // Wait for send to complete before closing to avoid race condition
        ws.send(JSON.stringify(instance), () => {
          ws.close();
        });
        return;
      }

      // Regular extension connection
      log.info('WS', 'Browser extension connected');
      clientSocket = ws;

      ws.on('message', (data) => {
        try {
          const message = JSON.parse(data.toString());

          // Handle tool responses
          if (message.id && pendingRequests.has(message.id)) {
            const pending = pendingRequests.get(message.id)!;
            clearTimeout(pending.timeout);
            pendingRequests.delete(message.id);
            pending.resolve(message as ToolResponse);
            log.trace('WS', `Tool response received: ${message.id}`);
            return;
          }

          // Handle extension status updates
          if (message.type === 'EXTENSION_STATUS') {
            connectedTabInfo = message.tab;
            log.info('WS', `Connected to tab: ${message.tab?.title || 'unknown'}`);
          }
        } catch (err) {
          log.error('WS', 'Error parsing WebSocket message:', err);
        }
      });

      ws.on('close', () => {
        log.info('WS', 'Browser extension disconnected');
        clientSocket = null;
        connectedTabInfo = undefined;
      });

      ws.on('error', (err) => {
        log.error('WS', 'WebSocket error:', err);
      });
    });

  });
}
