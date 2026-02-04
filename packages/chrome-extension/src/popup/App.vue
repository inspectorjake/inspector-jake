<script setup lang="ts">
/**
 * Jake MCP Popup - Session discovery and connection UI.
 * Dark mode developer tool aesthetic with professional design.
 */

import { ref, onMounted, onUnmounted, computed } from 'vue';
import type { SessionName } from '@inspector-jake/shared';
import { log } from '../utils/logger.js';

interface DiscoveredSession {
  name: SessionName;
  port: number;
  status: 'ready' | 'connected';
  connectedTab?: {
    id: number;
    title: string;
    url: string;
  };
}

interface ConnectionStatus {
  connected: boolean;
  sessionName: SessionName | null;
  tabId: number | null;
}

const sessions = ref<DiscoveredSession[]>([]);
const scanning = ref(false);
const connecting = ref(false);
const connectionStatus = ref<ConnectionStatus>({
  connected: false,
  sessionName: null,
  tabId: null,
});
const currentTab = ref<chrome.tabs.Tab | null>(null);
const error = ref<string | null>(null);
let statusPollTimer: ReturnType<typeof setInterval> | null = null;

const isConnected = computed(() => connectionStatus.value.connected);
const connectedSessionName = computed(() => connectionStatus.value.sessionName);

async function scanForSessions() {
  scanning.value = true;
  error.value = null;

  try {
    const response = await chrome.runtime.sendMessage({ type: 'DISCOVER_SESSIONS' });
    sessions.value = response.sessions || [];
  } catch (err) {
    error.value = 'Failed to scan for sessions';
    log.error('Popup', 'Failed to scan for sessions:', err);
  } finally {
    scanning.value = false;
  }
}

async function getConnectionStatus() {
  try {
    const status = await chrome.runtime.sendMessage({ type: 'GET_CONNECTION_STATUS' });
    connectionStatus.value = status;
  } catch (err) {
    log.error('Popup', 'Failed to get connection status:', err);
  }
}

async function getCurrentTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  currentTab.value = tab || null;
}

async function connectToSession(session: DiscoveredSession) {
  if (!currentTab.value?.id) {
    error.value = 'No active tab';
    return;
  }

  connecting.value = true;
  error.value = null;

  try {
    const response = await chrome.runtime.sendMessage({
      type: 'CONNECT_SESSION',
      sessionName: session.name,
      port: session.port,
      tabId: currentTab.value.id,
    });

    if (response.success) {
      connectionStatus.value = {
        connected: true,
        sessionName: session.name,
        tabId: currentTab.value.id,
      };
    } else {
      error.value = response.error || 'Connection failed';
    }
  } catch (err) {
    error.value = 'Failed to connect';
    log.error('Popup', 'Failed to connect to session:', err);
  } finally {
    connecting.value = false;
  }
}

async function disconnect() {
  try {
    await chrome.runtime.sendMessage({ type: 'DISCONNECT_SESSION' });
    connectionStatus.value = {
      connected: false,
      sessionName: null,
      tabId: null,
    };
  } catch (err) {
    log.error('Popup', 'Failed to disconnect:', err);
  }
}

function handleMessage(message: any) {
  if (message.type === 'CONNECTION_CLOSED') {
    connectionStatus.value = {
      connected: false,
      sessionName: null,
      tabId: null,
    };
  }
}

onMounted(async () => {
  chrome.runtime.onMessage.addListener(handleMessage);
  await Promise.all([
    getCurrentTab(),
    getConnectionStatus(),
    scanForSessions(),
  ]);

  // Poll connection status while popup is open
  statusPollTimer = setInterval(getConnectionStatus, 8000);
});

onUnmounted(() => {
  chrome.runtime.onMessage.removeListener(handleMessage);
  if (statusPollTimer) {
    clearInterval(statusPollTimer);
    statusPollTimer = null;
  }
});
</script>

<template>
  <div class="popup">
    <!-- Header -->
    <header class="header">
      <div class="logo">
        <svg class="logo-icon" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="11" cy="11" r="8"/>
          <path d="m21 21-4.3-4.3"/>
          <path d="M11 8v6"/>
          <path d="M8 11h6"/>
        </svg>
        <h1 class="title">Jake MCP</h1>
      </div>
    </header>

    <!-- Connection Status Card - Connected -->
    <div v-if="isConnected" class="status-card connected">
      <div class="status-indicator">
        <svg class="status-dot connected" width="12" height="12" viewBox="0 0 12 12">
          <circle cx="6" cy="6" r="5" fill="#22C55E"/>
        </svg>
      </div>
      <div class="status-content">
        <div class="status-label">Connected</div>
        <div class="status-session">Session: {{ connectedSessionName }}</div>
      </div>
      <button
        class="btn btn-ghost"
        @click="disconnect"
        aria-label="Disconnect from session"
      >
        Disconnect
      </button>
    </div>

    <!-- Connection Status Card - Disconnected -->
    <div v-else class="status-card">
      <div class="status-indicator">
        <svg class="status-dot" width="12" height="12" viewBox="0 0 12 12">
          <circle cx="6" cy="6" r="4.5" fill="none" stroke="#64748B" stroke-width="1.5"/>
        </svg>
      </div>
      <div class="status-content">
        <div class="status-label">Not Connected</div>
      </div>
    </div>

    <!-- Error Message -->
    <div v-if="error" class="error-card">
      <svg class="error-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <circle cx="12" cy="12" r="10"/>
        <line x1="12" y1="8" x2="12" y2="12"/>
        <line x1="12" y1="16" x2="12.01" y2="16"/>
      </svg>
      <span>{{ error }}</span>
    </div>

    <!-- Session List -->
    <div class="section" v-if="!isConnected">
      <div class="section-header">
        <h2 class="section-title">Available Sessions</h2>
        <button
          class="btn btn-icon"
          @click="scanForSessions"
          :disabled="scanning"
          :aria-label="scanning ? 'Scanning...' : 'Refresh sessions'"
        >
          <svg
            :class="['refresh-icon', { spinning: scanning }]"
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/>
            <path d="M3 3v5h5"/>
            <path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16"/>
            <path d="M16 16h5v5"/>
          </svg>
        </button>
      </div>

      <!-- Loading State -->
      <div v-if="scanning" class="loading-state">
        <svg class="spinner" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M21 12a9 9 0 1 1-6.219-8.56"/>
        </svg>
        <span>Scanning for sessions...</span>
      </div>

      <!-- Empty State -->
      <div v-else-if="sessions.length === 0" class="empty-state">
        <p>No MCP servers found.</p>
        <p class="empty-hint">Start one with:</p>
        <code class="code-block">npx inspector-jake-mcp</code>
      </div>

      <!-- Session List -->
      <ul v-else class="session-list">
        <li
          v-for="session in sessions"
          :key="session.name"
          class="session-item"
        >
          <div class="session-info">
            <div class="session-name">
              <svg class="session-dot" :class="session.status" width="8" height="8" viewBox="0 0 8 8">
                <circle cx="4" cy="4" r="4" :fill="session.status === 'connected' ? '#F59E0B' : '#22C55E'"/>
              </svg>
              <span>{{ session.name }}</span>
            </div>
            <div class="session-port">Port {{ session.port }}</div>
          </div>
          <button
            class="btn"
            :class="session.status === 'connected' ? 'btn-warning' : 'btn-primary'"
            @click="connectToSession(session)"
            :disabled="connecting || session.status === 'connected'"
          >
            {{ session.status === 'connected' ? 'In Use' : 'Connect' }}
          </button>
        </li>
      </ul>
    </div>

    <!-- Hint when connected -->
    <div class="hint-card" v-if="isConnected">
      <svg class="hint-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <circle cx="12" cy="12" r="10"/>
        <path d="M12 16v-4"/>
        <path d="M12 8h.01"/>
      </svg>
      <span>Open DevTools and select elements to share with AI.</span>
    </div>
  </div>
</template>

<style scoped>
/* Color Variables */
.popup {
  --bg-primary: #0F172A;
  --bg-secondary: #1E293B;
  --bg-tertiary: #334155;
  --border-color: #475569;
  --text-primary: #F8FAFC;
  --text-secondary: #94A3B8;
  --text-muted: #64748B;
  --accent-green: #22C55E;
  --accent-green-hover: #16A34A;
  --accent-amber: #F59E0B;
  --accent-red: #EF4444;
  --accent-blue: #3B82F6;
}

.popup {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

/* Header */
.header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding-bottom: 4px;
}

.logo {
  display: flex;
  align-items: center;
  gap: 8px;
}

.logo-icon {
  color: var(--accent-green);
}

.title {
  font-size: 15px;
  font-weight: 600;
  color: var(--text-primary);
}

/* Status Card */
.status-card {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px;
  border-radius: 8px;
  background: var(--bg-secondary);
  border: 1px solid var(--bg-tertiary);
}

.status-card.connected {
  border-color: rgba(34, 197, 94, 0.3);
}

.status-indicator {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
}

.status-content {
  flex: 1;
}

.status-label {
  font-size: 13px;
  font-weight: 500;
  color: var(--text-primary);
}

.status-session {
  font-size: 12px;
  color: var(--text-secondary);
  margin-top: 2px;
}

/* Buttons */
.btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-height: 32px;
  padding: 6px 12px;
  border: none;
  border-radius: 6px;
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
  transition: all 150ms ease;
}

.btn:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px var(--bg-primary), 0 0 0 4px rgba(34, 197, 94, 0.5);
}

.btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.btn-primary {
  background: var(--accent-green);
  color: #0F172A;
}

.btn-primary:hover:not(:disabled) {
  background: var(--accent-green-hover);
}

.btn-warning {
  background: rgba(245, 158, 11, 0.15);
  color: var(--accent-amber);
  border: 1px solid rgba(245, 158, 11, 0.3);
}

.btn-ghost {
  background: transparent;
  color: var(--text-secondary);
  border: 1px solid var(--bg-tertiary);
}

.btn-ghost:hover:not(:disabled) {
  background: var(--bg-tertiary);
  color: var(--text-primary);
}

.btn-icon {
  width: 32px;
  height: 32px;
  padding: 0;
  background: transparent;
  color: var(--text-muted);
  border: none;
  border-radius: 6px;
}

.btn-icon:hover:not(:disabled) {
  background: var(--bg-tertiary);
  color: var(--text-primary);
}

/* Error Card */
.error-card {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 12px;
  border-radius: 6px;
  background: rgba(239, 68, 68, 0.1);
  border: 1px solid rgba(239, 68, 68, 0.2);
  color: #FCA5A5;
  font-size: 12px;
}

.error-icon {
  flex-shrink: 0;
  color: var(--accent-red);
}

/* Section */
.section {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.section-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.section-title {
  font-size: 11px;
  font-weight: 500;
  color: var(--text-muted);
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

/* Loading & Empty States */
.loading-state,
.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 24px 16px;
  text-align: center;
  color: var(--text-secondary);
  font-size: 13px;
}

.loading-state {
  flex-direction: row;
  gap: 10px;
}

.spinner {
  animation: spin 1s linear infinite;
  color: var(--accent-green);
}

@keyframes spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}

.refresh-icon {
  transition: transform 150ms ease;
}

.refresh-icon.spinning {
  animation: spin 1s linear infinite;
}

.empty-hint {
  margin-top: 4px;
  color: var(--text-muted);
  font-size: 12px;
}

.code-block {
  display: block;
  margin-top: 8px;
  padding: 10px 14px;
  background: var(--bg-secondary);
  border: 1px solid var(--bg-tertiary);
  border-radius: 6px;
  font-family: 'SF Mono', 'Fira Code', 'Consolas', monospace;
  font-size: 12px;
  color: var(--accent-green);
}

/* Session List */
.session-list {
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.session-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 12px;
  background: var(--bg-secondary);
  border: 1px solid var(--bg-tertiary);
  border-radius: 8px;
  cursor: pointer;
  transition: all 150ms ease;
}

.session-item:hover {
  background: var(--bg-tertiary);
  border-color: var(--border-color);
}

.session-info {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.session-name {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  font-weight: 500;
  color: var(--text-primary);
}

.session-dot {
  flex-shrink: 0;
}

.session-port {
  font-size: 11px;
  color: var(--text-muted);
  margin-left: 16px;
}

/* Hint Card */
.hint-card {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 12px;
  border-radius: 8px;
  background: rgba(59, 130, 246, 0.1);
  border: 1px solid rgba(59, 130, 246, 0.2);
  font-size: 12px;
  color: #93C5FD;
  line-height: 1.5;
}

.hint-icon {
  flex-shrink: 0;
  margin-top: 1px;
  color: var(--accent-blue);
}
</style>
