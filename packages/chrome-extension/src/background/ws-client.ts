/**
 * WebSocket client for connecting to Jake MCP MCP server.
 * Handles tool requests from server and forwards to appropriate handlers.
 * Includes keepalive alarm and heartbeat to prevent MV3 service worker termination.
 */

import type { ToolRequest, ToolResponse, SessionName } from '@inspector-jake/shared';
import { handleToolRequest } from './tool-handlers.js';
import { log } from '../utils/logger.js';

export const KEEPALIVE_ALARM_NAME = 'jake-ws-keepalive';
const KEEPALIVE_INTERVAL_MINUTES = 0.4; // ~24 seconds (under 30s MV3 termination limit)
const HEARTBEAT_INTERVAL_MS = 15000;    // 15 seconds
const HEARTBEAT_TIMEOUT_MS = 10000;     // 10 seconds to receive pong

export interface WsClientInstance {
  disconnect: () => void;
  isConnected: () => boolean;
  getSessionName: () => SessionName | null;
  sendStatusUpdate: (tab: { id: number; title: string; url: string } | null) => void;
}

let currentConnection: {
  ws: WebSocket;
  sessionName: SessionName;
  port: number;
  tabId: number | null;
} | null = null;

let heartbeatInterval: ReturnType<typeof setInterval> | null = null;
let heartbeatTimeout: ReturnType<typeof setTimeout> | null = null;

// --- Keepalive alarm management ---

function startKeepaliveAlarm(): void {
  chrome.alarms.create(KEEPALIVE_ALARM_NAME, {
    periodInMinutes: KEEPALIVE_INTERVAL_MINUTES,
  });
  log.info('WS', 'Keepalive alarm started');
}

function stopKeepaliveAlarm(): void {
  chrome.alarms.clear(KEEPALIVE_ALARM_NAME);
  log.info('WS', 'Keepalive alarm stopped');
}

// --- Application-level heartbeat ---

function startHeartbeat(ws: WebSocket): void {
  stopHeartbeat();

  heartbeatInterval = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) {
      // Clear any lingering timeout before starting a new cycle
      if (heartbeatTimeout) {
        clearTimeout(heartbeatTimeout);
        heartbeatTimeout = null;
      }

      log.trace('WS', 'Sending heartbeat ping');
      ws.send(JSON.stringify({ type: 'ping' }));

      heartbeatTimeout = setTimeout(() => {
        log.warn('WS', 'Heartbeat pong not received within timeout, closing connection');
        ws.close();
      }, HEARTBEAT_TIMEOUT_MS);
    }
  }, HEARTBEAT_INTERVAL_MS);

  log.info('WS', 'Heartbeat started');
}

function stopHeartbeat(): void {
  if (heartbeatInterval) {
    clearInterval(heartbeatInterval);
    heartbeatInterval = null;
  }
  if (heartbeatTimeout) {
    clearTimeout(heartbeatTimeout);
    heartbeatTimeout = null;
  }
}

function handlePong(): void {
  if (heartbeatTimeout) {
    clearTimeout(heartbeatTimeout);
    heartbeatTimeout = null;
  }
  log.trace('WS', 'Heartbeat pong received');
}

/**
 * Handle keepalive alarm. Checks connection health.
 * Called from background/index.ts alarm listener.
 */
export function handleKeepaliveAlarm(): void {
  log.trace('WS', 'Keepalive alarm fired');

  if (!currentConnection) {
    log.info('WS', 'No active connection during keepalive, stopping alarm');
    stopKeepaliveAlarm();
    return;
  }

  if (currentConnection.ws.readyState !== WebSocket.OPEN) {
    log.warn('WS', `Connection in unexpected state: ${currentConnection.ws.readyState}, cleaning up`);
    currentConnection = null;
    stopHeartbeat();
    stopKeepaliveAlarm();
    chrome.runtime.sendMessage({ type: 'CONNECTION_CLOSED' }).catch(() => {});
    return;
  }

  log.trace('WS', 'Connection healthy during keepalive check');
}

/**
 * Connect to an MCP server session.
 */
export function connectToSession(
  sessionName: SessionName,
  port: number,
  tabId: number
): Promise<WsClientInstance> {
  return new Promise((resolve, reject) => {
    // Disconnect existing connection if any
    if (currentConnection) {
      stopHeartbeat();
      stopKeepaliveAlarm();
      currentConnection.ws.close();
      currentConnection = null;
    }

    const ws = new WebSocket(`ws://127.0.0.1:${port}`);

    ws.onopen = () => {
      currentConnection = {
        ws,
        sessionName,
        port,
        tabId,
      };

      // Start keepalive alarm and heartbeat
      startKeepaliveAlarm();
      startHeartbeat(ws);

      const instance: WsClientInstance = {
        disconnect: () => {
          ws.close();
          currentConnection = null;
        },

        isConnected: () => ws.readyState === WebSocket.OPEN,

        getSessionName: () => sessionName,

        sendStatusUpdate: (tab) => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({
              type: 'EXTENSION_STATUS',
              tab,
            }));
          }
        },
      };

      // Send initial status
      chrome.tabs.get(tabId, (tab) => {
        if (tab) {
          instance.sendStatusUpdate({
            id: tabId,
            title: tab.title || 'Unknown',
            url: tab.url || 'Unknown',
          });
        }
      });

      resolve(instance);
    };

    ws.onmessage = async (event) => {
      try {
        const message = JSON.parse(event.data);

        // Handle heartbeat pong
        if (message.type === 'pong') {
          handlePong();
          return;
        }

        const request = message as ToolRequest;
        log.debug('WS', `Tool request received: ${request.type}`);

        // Handle tool request
        const response = await handleToolRequest(request, currentConnection?.tabId || null);

        // Send response back
        ws.send(JSON.stringify(response));
        log.trace('WS', `Tool response sent: ${request.id}`);
      } catch (err) {
        log.error('WS', 'Error handling WebSocket message:', err);
      }
    };

    ws.onerror = (error) => {
      log.error('WS', 'WebSocket error:', error);
      reject(new Error('Failed to connect to MCP server'));
    };

    ws.onclose = () => {
      log.info('WS', 'WebSocket connection closed');
      currentConnection = null;
      stopHeartbeat();
      stopKeepaliveAlarm();
      // Notify popup/panel about disconnection
      chrome.runtime.sendMessage({ type: 'CONNECTION_CLOSED' }).catch(() => {
        // Popup/panel might be closed
      });
    };
  });
}

/**
 * Get current connection status.
 */
export function getConnectionStatus(): {
  connected: boolean;
  sessionName: SessionName | null;
  tabId: number | null;
} {
  if (!currentConnection || currentConnection.ws.readyState !== WebSocket.OPEN) {
    return { connected: false, sessionName: null, tabId: null };
  }

  return {
    connected: true,
    sessionName: currentConnection.sessionName,
    tabId: currentConnection.tabId,
  };
}

/**
 * Update the connected tab ID.
 */
export function updateConnectedTab(tabId: number): void {
  if (currentConnection) {
    currentConnection.tabId = tabId;
  }
}

/**
 * Disconnect current session.
 */
export function disconnectSession(): void {
  if (currentConnection) {
    stopHeartbeat();
    stopKeepaliveAlarm();
    currentConnection.ws.close();
    currentConnection = null;
  }
}
