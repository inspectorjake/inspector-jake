/**
 * Composable for managing MCP session connection.
 * Handles session discovery, connection, and status tracking.
 * Includes periodic status polling to detect stale connection state.
 */
import { ref, computed } from 'vue';
import type { SessionName } from '@inspector-jake/shared';
import { log } from '../../utils/logger.js';

const STATUS_POLL_INTERVAL_MS = 8000; // Poll every 8 seconds

/**
 * Discovered session from MCP server.
 */
export interface DiscoveredSession {
  name: SessionName;
  port: number;
  status: 'ready' | 'connected';
  connectedTab?: {
    id: number;
    title: string;
    url: string;
  };
}

/**
 * Current connection status.
 */
export interface ConnectionStatus {
  connected: boolean;
  sessionName: SessionName | null;
  tabId: number | null;
}

/**
 * Composable for MCP session connection management.
 */
export function useConnection() {
  // Core state
  const sessions = ref<DiscoveredSession[]>([]);
  const scanning = ref(false);
  const connecting = ref(false);
  const connectionStatus = ref<ConnectionStatus>({
    connected: false,
    sessionName: null,
    tabId: null,
  });
  const error = ref<string | null>(null);

  // Computed properties
  const isConnected = computed(() => connectionStatus.value.connected);
  const connectedSessionName = computed(() => connectionStatus.value.sessionName);

  // Status polling state
  let statusPollTimer: ReturnType<typeof setInterval> | null = null;

  /**
   * Scan for available MCP sessions.
   */
  async function scanForSessions(): Promise<void> {
    scanning.value = true;
    error.value = null;

    try {
      const response = await chrome.runtime.sendMessage({ type: 'DISCOVER_SESSIONS' });
      sessions.value = response.sessions || [];
    } catch (err) {
      error.value = 'Failed to scan for sessions';
      log.error('useConnection', 'Failed to scan for sessions:', err);
    } finally {
      scanning.value = false;
    }
  }

  /**
   * Get current connection status from background.
   */
  async function getConnectionStatus(): Promise<void> {
    try {
      const status = await chrome.runtime.sendMessage({ type: 'GET_CONNECTION_STATUS' });
      connectionStatus.value = status;

      // Start or stop polling based on actual connection state
      if (status.connected) {
        startStatusPolling();
      } else {
        stopStatusPolling();
      }
    } catch (err) {
      log.error('useConnection', 'Failed to get connection status:', err);
    }
  }

  /**
   * Connect to a discovered session.
   */
  async function connectToSession(session: DiscoveredSession): Promise<boolean> {
    // Get current tab from DevTools context
    const tabId = chrome.devtools?.inspectedWindow?.tabId;
    if (!tabId) {
      error.value = 'No inspected tab';
      return false;
    }

    connecting.value = true;
    error.value = null;

    try {
      const response = await chrome.runtime.sendMessage({
        type: 'CONNECT_SESSION',
        sessionName: session.name,
        port: session.port,
        tabId: tabId,
      });

      if (response.success) {
        connectionStatus.value = {
          connected: true,
          sessionName: session.name,
          tabId: tabId,
        };
        startStatusPolling();
        return true;
      } else {
        error.value = response.error || 'Connection failed';
        return false;
      }
    } catch (err) {
      error.value = 'Failed to connect';
      log.error('useConnection', 'Failed to connect to session:', err);
      return false;
    } finally {
      connecting.value = false;
    }
  }

  /**
   * Disconnect from current session.
   */
  async function disconnect(): Promise<void> {
    try {
      await chrome.runtime.sendMessage({ type: 'DISCONNECT_SESSION' });
      connectionStatus.value = {
        connected: false,
        sessionName: null,
        tabId: null,
      };
      stopStatusPolling();
    } catch (err) {
      log.error('useConnection', 'Failed to disconnect:', err);
    }
  }

  /**
   * Handle connection closed event (from background).
   */
  function handleConnectionClosed(): void {
    connectionStatus.value = {
      connected: false,
      sessionName: null,
      tabId: null,
    };
    stopStatusPolling();
  }

  /**
   * Start periodic polling of actual connection status from background.
   * Detects stale UI state when event messages are missed.
   */
  function startStatusPolling(): void {
    if (statusPollTimer) return; // Already polling

    statusPollTimer = setInterval(async () => {
      try {
        const status = await chrome.runtime.sendMessage({ type: 'GET_CONNECTION_STATUS' });

        // Detect mismatch: UI thinks connected but background says disconnected
        if (connectionStatus.value.connected && !status.connected) {
          log.warn('useConnection', 'Connection state mismatch detected: UI=connected, background=disconnected');
          handleConnectionClosed();
          return;
        }

        connectionStatus.value = status;
      } catch (err) {
        log.error('useConnection', 'Status poll failed:', err);
      }
    }, STATUS_POLL_INTERVAL_MS);

    log.debug('useConnection', 'Status polling started');
  }

  function stopStatusPolling(): void {
    if (statusPollTimer) {
      clearInterval(statusPollTimer);
      statusPollTimer = null;
      log.debug('useConnection', 'Status polling stopped');
    }
  }

  return {
    // State
    sessions,
    scanning,
    connecting,
    connectionStatus,
    error,

    // Computed
    isConnected,
    connectedSessionName,

    // Methods
    scanForSessions,
    getConnectionStatus,
    connectToSession,
    disconnect,
    handleConnectionClosed,
    stopStatusPolling,
  };
}
