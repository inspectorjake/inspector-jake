/**
 * Tests for useConnection composable.
 * Covers session discovery, connection management, status tracking, and polling.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { nextTick } from 'vue';
import { useConnection } from '../useConnection.js';

// Mock chrome APIs
const mockSendMessage = vi.fn();
vi.stubGlobal('chrome', {
  runtime: {
    sendMessage: mockSendMessage,
  },
  devtools: {
    inspectedWindow: {
      tabId: 123,
    },
  },
  alarms: {
    create: vi.fn(),
    clear: vi.fn(),
    onAlarm: {
      addListener: vi.fn(),
    },
  },
});

describe('useConnection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSendMessage.mockReset();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('initial state', () => {
    it('should have empty sessions array', () => {
      const { sessions } = useConnection();
      expect(sessions.value).toEqual([]);
    });

    it('should not be scanning initially', () => {
      const { scanning } = useConnection();
      expect(scanning.value).toBe(false);
    });

    it('should not be connecting initially', () => {
      const { connecting } = useConnection();
      expect(connecting.value).toBe(false);
    });

    it('should not be connected initially', () => {
      const { isConnected, connectionStatus } = useConnection();
      expect(isConnected.value).toBe(false);
      expect(connectionStatus.value.connected).toBe(false);
      expect(connectionStatus.value.sessionName).toBeNull();
      expect(connectionStatus.value.tabId).toBeNull();
    });

    it('should have no error initially', () => {
      const { error } = useConnection();
      expect(error.value).toBeNull();
    });
  });

  describe('scanForSessions', () => {
    it('should set scanning to true during scan', async () => {
      const { scanning, scanForSessions } = useConnection();
      mockSendMessage.mockImplementation(() => new Promise(() => {})); // Never resolves

      const promise = scanForSessions();
      await nextTick();

      expect(scanning.value).toBe(true);
    });

    it('should populate sessions from response', async () => {
      const { sessions, scanForSessions } = useConnection();
      mockSendMessage.mockResolvedValue({
        sessions: [
          { name: 'jake', port: 52192, status: 'ready' },
          { name: 'test', port: 52193, status: 'connected' },
        ],
      });

      await scanForSessions();

      expect(sessions.value).toHaveLength(2);
      expect(sessions.value[0].name).toBe('jake');
      expect(sessions.value[1].name).toBe('test');
    });

    it('should set scanning to false after scan completes', async () => {
      const { scanning, scanForSessions } = useConnection();
      mockSendMessage.mockResolvedValue({ sessions: [] });

      await scanForSessions();

      expect(scanning.value).toBe(false);
    });

    it('should set error on failure', async () => {
      const { error, scanForSessions } = useConnection();
      mockSendMessage.mockRejectedValue(new Error('Network error'));

      await scanForSessions();

      expect(error.value).toBe('Failed to scan for sessions');
    });

    it('should clear error before scanning', async () => {
      const { error, scanForSessions } = useConnection();
      error.value = 'Previous error';
      mockSendMessage.mockResolvedValue({ sessions: [] });

      await scanForSessions();

      expect(error.value).toBeNull();
    });
  });

  describe('getConnectionStatus', () => {
    it('should update connection status from response', async () => {
      const { connectionStatus, getConnectionStatus } = useConnection();
      mockSendMessage.mockResolvedValue({
        connected: true,
        sessionName: 'jake',
        tabId: 123,
      });

      await getConnectionStatus();

      expect(connectionStatus.value.connected).toBe(true);
      expect(connectionStatus.value.sessionName).toBe('jake');
      expect(connectionStatus.value.tabId).toBe(123);
    });
  });

  describe('connectToSession', () => {
    const mockSession = { name: 'jake', port: 52192, status: 'ready' as const };

    it('should set connecting to true during connection', async () => {
      const { connecting, connectToSession } = useConnection();
      mockSendMessage.mockImplementation(() => new Promise(() => {})); // Never resolves

      const promise = connectToSession(mockSession);
      await nextTick();

      expect(connecting.value).toBe(true);
    });

    it('should update connectionStatus on successful connect', async () => {
      const { connectionStatus, connectToSession } = useConnection();
      mockSendMessage.mockResolvedValue({ success: true });

      await connectToSession(mockSession);

      expect(connectionStatus.value.connected).toBe(true);
      expect(connectionStatus.value.sessionName).toBe('jake');
      expect(connectionStatus.value.tabId).toBe(123);
    });

    it('should set connecting to false after connection completes', async () => {
      const { connecting, connectToSession } = useConnection();
      mockSendMessage.mockResolvedValue({ success: true });

      await connectToSession(mockSession);

      expect(connecting.value).toBe(false);
    });

    it('should set error on connection failure response', async () => {
      const { error, connectToSession } = useConnection();
      mockSendMessage.mockResolvedValue({ success: false, error: 'Session busy' });

      await connectToSession(mockSession);

      expect(error.value).toBe('Session busy');
    });

    it('should set generic error if no error message in response', async () => {
      const { error, connectToSession } = useConnection();
      mockSendMessage.mockResolvedValue({ success: false });

      await connectToSession(mockSession);

      expect(error.value).toBe('Connection failed');
    });

    it('should set error on exception', async () => {
      const { error, connectToSession } = useConnection();
      mockSendMessage.mockRejectedValue(new Error('Network error'));

      await connectToSession(mockSession);

      expect(error.value).toBe('Failed to connect');
    });

    it('should clear error before connecting', async () => {
      const { error, connectToSession } = useConnection();
      error.value = 'Previous error';
      mockSendMessage.mockResolvedValue({ success: true });

      await connectToSession(mockSession);

      expect(error.value).toBeNull();
    });
  });

  describe('disconnect', () => {
    it('should reset connectionStatus on disconnect', async () => {
      const { connectionStatus, disconnect } = useConnection();
      connectionStatus.value = { connected: true, sessionName: 'jake', tabId: 123 };
      mockSendMessage.mockResolvedValue({});

      await disconnect();

      expect(connectionStatus.value.connected).toBe(false);
      expect(connectionStatus.value.sessionName).toBeNull();
      expect(connectionStatus.value.tabId).toBeNull();
    });

    it('should send disconnect message', async () => {
      const { disconnect } = useConnection();
      mockSendMessage.mockResolvedValue({});

      await disconnect();

      expect(mockSendMessage).toHaveBeenCalledWith({ type: 'DISCONNECT_SESSION' });
    });
  });

  describe('computed properties', () => {
    it('isConnected should reflect connectionStatus.connected', async () => {
      const { isConnected, connectionStatus } = useConnection();

      expect(isConnected.value).toBe(false);

      connectionStatus.value = { connected: true, sessionName: 'jake', tabId: 123 };
      await nextTick();

      expect(isConnected.value).toBe(true);
    });

    it('connectedSessionName should reflect connectionStatus.sessionName', async () => {
      const { connectedSessionName, connectionStatus } = useConnection();

      expect(connectedSessionName.value).toBeNull();

      connectionStatus.value = { connected: true, sessionName: 'jake', tabId: 123 };
      await nextTick();

      expect(connectedSessionName.value).toBe('jake');
    });
  });

  describe('handleConnectionClosed', () => {
    it('should reset connectionStatus when connection closed', () => {
      const { connectionStatus, handleConnectionClosed } = useConnection();
      connectionStatus.value = { connected: true, sessionName: 'jake', tabId: 123 };

      handleConnectionClosed();

      expect(connectionStatus.value.connected).toBe(false);
      expect(connectionStatus.value.sessionName).toBeNull();
      expect(connectionStatus.value.tabId).toBeNull();
    });
  });

  describe('status polling', () => {
    const mockSession = { name: 'jake', port: 52192, status: 'ready' as const };

    it('should start polling after successful connection', async () => {
      const { connectToSession } = useConnection();
      mockSendMessage.mockResolvedValue({ success: true });

      await connectToSession(mockSession);

      // After the polling interval, a GET_CONNECTION_STATUS message should be sent
      mockSendMessage.mockClear();
      mockSendMessage.mockResolvedValue({ connected: true, sessionName: 'jake', tabId: 123 });

      await vi.advanceTimersByTimeAsync(8000);

      expect(mockSendMessage).toHaveBeenCalledWith({ type: 'GET_CONNECTION_STATUS' });
    });

    it('should detect state mismatch and update to disconnected', async () => {
      const { connectToSession, connectionStatus } = useConnection();
      mockSendMessage.mockResolvedValue({ success: true });

      await connectToSession(mockSession);

      // Background reports disconnected on next poll
      mockSendMessage.mockResolvedValue({ connected: false, sessionName: null, tabId: null });

      await vi.advanceTimersByTimeAsync(8000);

      expect(connectionStatus.value.connected).toBe(false);
    });

    it('should stop polling on disconnect', async () => {
      const { connectToSession, disconnect } = useConnection();
      mockSendMessage.mockResolvedValue({ success: true });

      await connectToSession(mockSession);
      mockSendMessage.mockClear();
      mockSendMessage.mockResolvedValue({});

      await disconnect();
      mockSendMessage.mockClear();

      // Advance timer - no polling should occur
      await vi.advanceTimersByTimeAsync(16000);

      // Should not have sent any GET_CONNECTION_STATUS messages
      const statusCalls = mockSendMessage.mock.calls.filter(
        (call) => call[0]?.type === 'GET_CONNECTION_STATUS'
      );
      expect(statusCalls).toHaveLength(0);
    });

    it('should stop polling on handleConnectionClosed', async () => {
      const { connectToSession, handleConnectionClosed } = useConnection();
      mockSendMessage.mockResolvedValue({ success: true });

      await connectToSession(mockSession);
      handleConnectionClosed();
      mockSendMessage.mockClear();

      await vi.advanceTimersByTimeAsync(16000);

      const statusCalls = mockSendMessage.mock.calls.filter(
        (call) => call[0]?.type === 'GET_CONNECTION_STATUS'
      );
      expect(statusCalls).toHaveLength(0);
    });
  });
});
