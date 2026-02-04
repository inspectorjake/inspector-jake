<script setup lang="ts">
/**
 * Jake MCP DevTools Panel - Main Vue component.
 * Orchestrates composables for state management.
 */

import { computed, onMounted, onUnmounted } from 'vue';
import type { ElementInfo } from '@inspector-jake/shared';
import {
  useSelections,
  useConnection,
  usePicker,
  useLogs,
  LogLevel,
  LogSource,
  type DiscoveredSession,
} from './composables/index.js';

// ============================================================================
// Composables
// ============================================================================

const {
  selections,
  expandedId,
  expandedSelection,
  toggleExpanded,
  addElementSelection,
  addScreenshotSelection,
  removeSelection,
  clearAllSelections,
  syncSelectionsToBackground,
} = useSelections();

const {
  sessions,
  scanning,
  connecting,
  connectionStatus,
  error: connectionError,
  isConnected,
  connectedSessionName,
  scanForSessions,
  getConnectionStatus,
  connectToSession: connectToSessionBase,
  disconnect,
  handleConnectionClosed,
  stopStatusPolling,
} = useConnection();

const {
  isPicking,
  error: pickerError,
  isCoolingDown,
  startElementPicker,
  stopElementPicker,
  highlightSelector,
  clearHighlight,
  captureElementScreenshot,
  cancelPicking,
} = usePicker();

const { logs, showLogs, addLog, clearLogs, toggleLogs } = useLogs();

// ============================================================================
// Computed
// ============================================================================

/** Unified error from connection and picker composables */
const error = computed(() => connectionError.value || pickerError.value);

/** Check if any logs are errors (for indicator) */
const hasLogErrors = computed(() => logs.value.some(l => l.level === LogLevel.ERROR));

// ============================================================================
// Message Types
// ============================================================================

/** Incoming message types from background/content scripts */
const MessageType = {
  CONNECTION_CLOSED: 'CONNECTION_CLOSED',
  DEVTOOLS_ELEMENT_SELECTED: 'DEVTOOLS_ELEMENT_SELECTED',
  ELEMENT_PICKED: 'ELEMENT_PICKED',
  SCREENSHOT_REGION_SELECTED: 'SCREENSHOT_REGION_SELECTED',
  PICKER_CANCELLED: 'PICKER_CANCELLED',
  REGION_SELECTED: 'REGION_SELECTED',
  REGION_CANCELLED: 'REGION_CANCELLED',
} as const;

type MessageTypeValue = typeof MessageType[keyof typeof MessageType];

// ============================================================================
// Event Handlers
// ============================================================================

/**
 * Handle picker button click with cooldown guard.
 */
async function handlePickerClick(): Promise<void> {
  if (isCoolingDown.value) return;

  addLog(LogLevel.INFO, LogSource.EXT, `Picker ${isPicking.value ? 'stopping' : 'starting'}`);

  if (isPicking.value) {
    stopElementPicker();
  } else {
    await startElementPicker();
  }
}

/**
 * Connect to a session and sync existing selections.
 */
async function connectToSession(session: DiscoveredSession): Promise<void> {
  const success = await connectToSessionBase(session);
  if (success) {
    await syncSelectionsToBackground();
  }
}

/**
 * Handle incoming messages from background/content scripts.
 * Uses early returns and switch for cleaner flow.
 */
async function handleMessage(message: { type: string; [key: string]: unknown }): Promise<void> {
  const { type } = message;

  switch (type as MessageTypeValue) {
    case MessageType.CONNECTION_CLOSED:
      handleConnectionClosed();
      break;

    case MessageType.DEVTOOLS_ELEMENT_SELECTED:
      await addElementSelection(message.element as ElementInfo, captureElementScreenshot);
      break;

    case MessageType.ELEMENT_PICKED:
      cancelPicking();
      addLog(LogLevel.SUCCESS, LogSource.EXT, `Element selected: <${(message.element as ElementInfo).tagName}>`);
      await addElementSelection(message.element as ElementInfo, captureElementScreenshot);
      break;

    case MessageType.SCREENSHOT_REGION_SELECTED: {
      cancelPicking();
      const rect = message.rect as { x: number; y: number; width: number; height: number };
      addLog(LogLevel.SUCCESS, LogSource.EXT, `Screenshot region: ${rect.width}×${rect.height}`);
      const image = await captureElementScreenshot(rect);
      if (image) {
        addScreenshotSelection(rect, image);
      }
      break;
    }

    case MessageType.PICKER_CANCELLED:
      addLog(LogLevel.INFO, LogSource.EXT, 'Picker cancelled');
      cancelPicking();
      break;

    // Legacy support
    case MessageType.REGION_SELECTED: {
      const { image, rect } = message as { image: string; rect: { x: number; y: number; width: number; height: number } };
      if (image) {
        addScreenshotSelection(rect, image);
      }
      break;
    }

    case MessageType.REGION_CANCELLED:
      cancelPicking();
      break;
  }
}

// ============================================================================
// Utilities
// ============================================================================

/**
 * Format element tag for display (e.g., "<div#myId>").
 */
function formatElementDisplay(el: { tagName: string; id?: string | null }): string {
  const idPart = el.id ? `#${el.id}` : '';
  return `<${el.tagName}${idPart}>`;
}

// ============================================================================
// Lifecycle
// ============================================================================

onMounted(async () => {
  chrome.runtime.onMessage.addListener(handleMessage);
  addLog(LogLevel.INFO, LogSource.EXT, 'Inspector Jake initialized');

  // Initialize connection state and sessions in parallel
  await Promise.all([getConnectionStatus(), scanForSessions()]);

  // Auto-connect to first available session
  if (!connectionStatus.value.connected && sessions.value.length > 0) {
    const availableSession = sessions.value.find(s => s.status !== 'connected');
    if (availableSession) {
      await connectToSession(availableSession);
    }
  }
});

onUnmounted(() => {
  chrome.runtime.onMessage.removeListener(handleMessage);
  stopStatusPolling();
  if (isPicking.value) {
    stopElementPicker();
  }
});
</script>

<template>
  <div class="panel" @click.self="isPicking && stopElementPicker()">
    <!-- Header -->
    <header class="header">
      <div class="logo">
        <svg
          class="picker-icon"
          width="24"
          height="24"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
          @click="handlePickerClick"
          :class="{ active: isPicking, disabled: isCoolingDown }"
          :title="isCoolingDown ? 'Please wait...' : (isPicking ? 'Stop picking (Esc)' : 'Select element or drag region')"
        >
          <circle cx="10" cy="10" r="7"/>
          <path d="m21 21-5.2-5.2"/>
          <path d="M10 7v6"/>
          <path d="M7 10h6"/>
        </svg>
        <img
          class="logo-icon"
          src="/icons/logo.svg"
          alt="Jake MCP"
          width="24"
          height="24"
        />
        <h1 class="title">Jake MCP</h1>
      </div>
      <!-- Logs Toggle -->
      <div class="header-actions">
        <svg
          class="header-icon logs-toggle"
          width="18"
          height="18"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
          @click.stop="toggleLogs"
          :class="{ active: showLogs, 'has-errors': hasLogErrors }"
          title="Toggle logs"
        >
          <polyline points="4 17 10 11 4 5"/>
          <line x1="12" y1="19" x2="20" y2="19"/>
        </svg>
      </div>
    </header>

    <!-- Logs Panel - Retro Terminal Style -->
    <Transition name="logs-slide">
      <section v-if="showLogs" class="logs-panel">
        <div class="logs-header">
          <div class="logs-title">
            <span class="logs-title-icon">▸</span>
            <span class="logs-title-text">SYSTEM LOGS</span>
            <span class="logs-count">{{ logs.length }}</span>
          </div>
          <div class="logs-actions">
            <button class="logs-btn" @click="clearLogs" title="Clear logs">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <polyline points="3 6 5 6 21 6"/>
                <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
              </svg>
            </button>
            <button class="logs-btn" @click="toggleLogs" title="Close">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <line x1="18" y1="6" x2="6" y2="18"/>
                <line x1="6" y1="6" x2="18" y2="18"/>
              </svg>
            </button>
          </div>
        </div>

        <div class="logs-terminal">
          <!-- Scanline overlay for CRT effect -->
          <div class="logs-scanlines"></div>

          <div class="logs-content" ref="logsContent">
            <TransitionGroup name="log-entry">
              <div
                v-for="log in logs"
                :key="log.id"
                class="log-line"
                :class="[`level-${log.level}`, `source-${log.source}`]"
              >
                <span class="log-time">{{ log.time }}</span>
                <span class="log-source">[{{ log.source.toUpperCase() }}]</span>
                <span class="log-level">{{ log.level.toUpperCase().padEnd(5) }}</span>
                <span class="log-msg">{{ log.message }}</span>
              </div>
            </TransitionGroup>

            <!-- Blinking cursor at bottom -->
            <div class="log-cursor">
              <span class="cursor-prompt">▸</span>
              <span class="cursor-block"></span>
            </div>
          </div>
        </div>
      </section>
    </Transition>

    <!-- Connection Status Card -->
    <section class="section">
      <h2 class="section-title">CONNECTION</h2>
      <div v-if="isConnected" class="card connected">
        <div class="card-row">
          <div class="status-indicator">
            <svg width="12" height="12" viewBox="0 0 12 12">
              <circle cx="6" cy="6" r="5" fill="#22C55E"/>
            </svg>
          </div>
          <div class="status-content">
            <div class="status-label">Connected to: {{ connectedSessionName }}</div>
          </div>
          <button class="btn btn-danger" @click="disconnect">
            Disconnect
          </button>
        </div>
      </div>
      <div v-else class="card">
        <div class="card-row">
          <div class="status-indicator">
            <svg width="12" height="12" viewBox="0 0 12 12">
              <circle cx="6" cy="6" r="4.5" fill="none" stroke="#64748B" stroke-width="1.5"/>
            </svg>
          </div>
          <div class="status-content">
            <div class="status-label">Not Connected</div>
          </div>
        </div>
      </div>
    </section>

    <!-- Error Message -->
    <div v-if="error" class="error-card">
      <svg class="error-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <circle cx="12" cy="12" r="10"/>
        <line x1="12" y1="8" x2="12" y2="12"/>
        <line x1="12" y1="16" x2="12.01" y2="16"/>
      </svg>
      <span>{{ error }}</span>
    </div>

    <!-- Sessions Section (shown when not connected) -->
    <section class="section" v-if="!isConnected">
      <div class="section-header">
        <h2 class="section-title">AVAILABLE CONNECTIONS</h2>
        <button
          class="btn btn-icon"
          @click="scanForSessions"
          :disabled="scanning"
        >
          <svg
            :class="['refresh-icon', { spinning: scanning }]"
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
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
        <span>Scanning...</span>
      </div>

      <!-- Empty State -->
      <div v-else-if="sessions.length === 0" class="empty-state">
        <p>No MCP servers found.</p>
        <p class="empty-hint">Start one with:</p>
        <code class="code-block">npx vibe-jake-mcp</code>
      </div>

      <!-- Session List -->
      <ul v-else class="session-list">
        <li
          v-for="session in sessions"
          :key="session.name"
          class="session-item"
          :class="{ 'session-disabled': connecting || session.status === 'connected' }"
          @click="!(connecting || session.status === 'connected') && connectToSession(session)"
        >
          <div class="session-info">
            <div class="session-name">
              <svg width="8" height="8" viewBox="0 0 8 8">
                <circle cx="4" cy="4" r="4" :fill="session.status === 'connected' ? '#F59E0B' : '#22C55E'"/>
              </svg>
              <span>{{ session.name }}</span>
            </div>
            <div class="session-port">Port {{ session.port }}</div>
          </div>
          <button
            class="btn"
            :class="session.status === 'connected' ? 'btn-warning' : 'btn-primary'"
            @click.stop="connectToSession(session)"
            :disabled="connecting || session.status === 'connected'"
          >
            {{ session.status === 'connected' ? 'In Use' : 'Connect' }}
          </button>
        </li>
      </ul>
    </section>

    <!-- Connected UI: Unified Selections -->
    <template v-if="isConnected">
      <!-- Selections Section -->
      <section class="section">
        <div class="section-header">
          <h2 class="section-title">SELECTIONS</h2>
          <button
            v-if="selections.length > 0"
            class="btn btn-icon"
            @click="clearAllSelections"
            title="Clear all selections"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M3 6h18"/>
              <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/>
              <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/>
            </svg>
          </button>
        </div>

        <!-- Selection Grid (with add button) -->
        <div v-if="selections.length > 0" class="selection-grid">
          <div
            v-for="sel in selections"
            :key="sel.id"
            class="selection-item"
            :class="[sel.type, { selected: expandedId === sel.id }]"
            @click="toggleExpanded(sel.id)"
          >
            <img :src="sel.image" class="selection-thumb" :alt="`${sel.width}x${sel.height}`" />
            <span class="selection-badge">{{ sel.type === 'element' ? 'elem' : 'shot' }}</span>
            <button class="selection-remove" @click.stop="removeSelection(sel.id)" title="Remove">×</button>
          </div>
          <!-- Add selection button in grid -->
          <button
            class="selection-add"
            :class="{ active: isPicking, disabled: isCoolingDown }"
            :disabled="isCoolingDown"
            @click="handlePickerClick"
            :title="isCoolingDown ? 'Please wait...' : (isPicking ? 'Cancel (Esc)' : 'Add selection')"
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M12 5v14"/>
              <path d="M5 12h14"/>
            </svg>
          </button>
        </div>

        <!-- Expanded detail panel (shown below grid when selection clicked) -->
        <div v-if="expandedSelection" class="selection-detail">
          <img :src="expandedSelection.image" class="detail-image" :alt="`${expandedSelection.width}x${expandedSelection.height}`" />
          <div class="detail-info">
            <template v-if="expandedSelection.type === 'element'">
              <div class="detail-tag">{{ formatElementDisplay(expandedSelection) }}</div>
              <div class="detail-row">
                <span class="detail-label">selector</span>
                <code
                  class="detail-selector"
                  @mouseenter="highlightSelector(expandedSelection.selector)"
                  @mouseleave="clearHighlight()"
                >{{ expandedSelection.selector }}</code>
              </div>
              <div v-if="expandedSelection.className" class="detail-row">
                <span class="detail-label">class</span>
                <span class="detail-value">{{ expandedSelection.className }}</span>
              </div>
            </template>
            <template v-else>
              <div class="detail-tag screenshot-tag">Screenshot Region</div>
            </template>
            <div class="detail-row">
              <span class="detail-label">size</span>
              <span class="detail-value">{{ expandedSelection.width }} × {{ expandedSelection.height }}</span>
            </div>
          </div>
        </div>

        <!-- Empty state: Add a Selection placeholder -->
        <div
          v-else-if="selections.length === 0"
          class="selection-placeholder"
          :class="{ active: isPicking, disabled: isCoolingDown }"
          @click="handlePickerClick"
        >
          <svg class="selection-placeholder-icon" width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="11" cy="11" r="8"/>
            <path d="m21 21-4.3-4.3"/>
            <path d="M11 8v6"/>
            <path d="M8 11h6"/>
          </svg>
          <span class="selection-placeholder-text">{{ isPicking ? 'Click element or drag region...' : 'Add a Selection' }}</span>
          <span class="selection-placeholder-hint">{{ isPicking ? 'Press Esc to cancel' : 'Click an element or drag to capture a region' }}</span>
        </div>
      </section>
    </template>
  </div>
</template>

<style scoped>
/* Color Variables */
.panel {
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
  --accent-purple: #A855F7;
  --accent-cyan: #06B6D4;
}

.panel {
  height: 100%;
  padding: 16px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 16px;
}

/* Header */
.header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.logo {
  display: flex;
  align-items: center;
  gap: 8px;
}

.picker-icon {
  color: var(--text-muted);
  cursor: pointer;
  transition: all 150ms ease;
  padding: 4px;
  border-radius: 8px;
  border: 2px dashed var(--border-color);
  flex-shrink: 0;
}

.picker-icon:hover {
  color: var(--accent-green);
  background: var(--bg-tertiary);
  border-color: var(--accent-green);
  transform: scale(1.05);
}

.picker-icon.active {
  color: var(--accent-green);
  background: rgba(34, 197, 94, 0.15);
  border-color: var(--accent-green);
  border-style: solid;
  animation: pulse 1s ease-in-out infinite;
}

.picker-icon.disabled {
  opacity: 0.4;
  cursor: not-allowed;
  pointer-events: none;
}

.logo-icon {
  width: 24px;
  height: 24px;
  border-radius: 4px;
}

.title {
  font-size: 16px;
  font-weight: 600;
  color: var(--text-primary);
}

/* Sections */
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

/* Cards */
.card {
  padding: 12px;
  border-radius: 8px;
  background: var(--bg-secondary);
  border: 1px solid var(--bg-tertiary);
}

.card.connected {
  border-color: rgba(34, 197, 94, 0.3);
}

.card-row {
  display: flex;
  align-items: center;
  gap: 12px;
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

.btn-danger {
  background: rgba(239, 68, 68, 0.15);
  color: var(--accent-red);
  border: 1px solid rgba(239, 68, 68, 0.3);
}

.btn-danger:hover:not(:disabled) {
  background: rgba(239, 68, 68, 0.25);
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

@keyframes pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.5; }
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
  background: var(--bg-secondary);
  border: 1px solid var(--bg-tertiary);
  border-radius: 8px;
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
  background: var(--bg-tertiary);
  border-radius: 6px;
  font-family: 'SF Mono', 'Fira Code', monospace;
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

.session-item:hover:not(.session-disabled) {
  background: var(--bg-tertiary);
  border-color: var(--border-color);
}

.session-item.session-disabled {
  cursor: not-allowed;
  opacity: 0.7;
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

.session-port {
  font-size: 11px;
  color: var(--text-muted);
  margin-left: 16px;
}

/* ============================================
   Unified Selections Grid & Detail Panel
   ============================================ */

.selection-grid {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  padding: 10px;
  background: var(--bg-secondary);
  border-radius: 8px;
  border: 1px solid var(--bg-tertiary);
}

.selection-item {
  position: relative;
  width: 80px;
  height: 60px;
  border-radius: 6px;
  overflow: hidden;
  border: 2px solid var(--border-color);
  cursor: pointer;
  transition: all 150ms ease;
}

.selection-item:hover {
  border-color: var(--text-muted);
}

.selection-item.selected {
  border-color: var(--accent-green);
  box-shadow: 0 0 0 2px rgba(34, 197, 94, 0.25);
}

/* Type-specific border colors */
.selection-item.element {
  border-color: var(--accent-purple);
}

.selection-item.element.selected {
  border-color: var(--accent-purple);
  box-shadow: 0 0 0 2px rgba(168, 85, 247, 0.25);
}

.selection-item.screenshot {
  border-color: var(--accent-cyan);
}

.selection-item.screenshot.selected {
  border-color: var(--accent-cyan);
  box-shadow: 0 0 0 2px rgba(6, 182, 212, 0.25);
}

.selection-thumb {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}

.selection-badge {
  position: absolute;
  bottom: 2px;
  left: 2px;
  font-size: 8px;
  padding: 2px 4px;
  background: rgba(0, 0, 0, 0.8);
  color: var(--text-secondary);
  border-radius: 3px;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  font-weight: 600;
}

.selection-item.element .selection-badge {
  color: var(--accent-purple);
}

.selection-item.screenshot .selection-badge {
  color: var(--accent-cyan);
}

.selection-remove {
  position: absolute;
  top: 2px;
  right: 2px;
  width: 18px;
  height: 18px;
  border-radius: 50%;
  background: var(--accent-red);
  color: white;
  border: none;
  font-size: 14px;
  font-weight: 600;
  line-height: 1;
  cursor: pointer;
  opacity: 0;
  transition: opacity 150ms ease;
  display: flex;
  align-items: center;
  justify-content: center;
}

.selection-item:hover .selection-remove {
  opacity: 1;
}

.selection-remove:hover {
  background: #DC2626;
}

/* Add selection button in grid */
.selection-add {
  width: 80px;
  height: 60px;
  border-radius: 6px;
  border: 2px dashed var(--border-color);
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all 150ms ease;
}

.selection-add:hover {
  border-color: var(--accent-green);
  color: var(--accent-green);
  background: rgba(34, 197, 94, 0.05);
}

.selection-add.active {
  border-color: var(--accent-green);
  border-style: solid;
  color: var(--accent-green);
  background: rgba(34, 197, 94, 0.1);
  animation: pulse 1s ease-in-out infinite;
}

.selection-add.disabled,
.selection-add:disabled {
  opacity: 0.4;
  cursor: not-allowed;
  pointer-events: none;
}

/* Expanded detail panel */
.selection-detail {
  display: flex;
  gap: 16px;
  padding: 16px;
  background: var(--bg-secondary);
  border: 1px solid var(--bg-tertiary);
  border-radius: 8px;
  margin-top: 8px;
}

.detail-image {
  max-width: 200px;
  max-height: 150px;
  object-fit: contain;
  border-radius: 6px;
  border: 1px solid var(--border-color);
  background: var(--bg-tertiary);
}

.detail-info {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
}

.detail-tag {
  font-family: 'SF Mono', 'Fira Code', monospace;
  font-size: 14px;
  font-weight: 600;
  color: var(--accent-purple);
}

.detail-tag.screenshot-tag {
  color: var(--accent-cyan);
}

.detail-row {
  display: flex;
  align-items: baseline;
  gap: 8px;
}

.detail-label {
  font-size: 11px;
  color: var(--text-muted);
  min-width: 50px;
  flex-shrink: 0;
}

.detail-value {
  font-size: 12px;
  color: var(--text-secondary);
}

.detail-selector {
  font-family: 'SF Mono', 'Fira Code', monospace;
  font-size: 11px;
  color: var(--accent-green);
  background: var(--bg-tertiary);
  padding: 2px 6px;
  border-radius: 4px;
  word-break: break-all;
  cursor: pointer;
  transition: all 150ms ease;
}

.detail-selector:hover {
  background: var(--border-color);
  box-shadow: 0 0 0 2px rgba(34, 197, 94, 0.3);
}

/* Empty state placeholder */
.selection-placeholder {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 32px 16px;
  background: var(--bg-secondary);
  border: 2px dashed var(--border-color);
  border-radius: 8px;
  cursor: pointer;
  transition: all 150ms ease;
}

.selection-placeholder:hover {
  border-color: var(--accent-green);
  background: rgba(34, 197, 94, 0.05);
}

.selection-placeholder:hover .selection-placeholder-icon {
  color: var(--accent-green);
  transform: scale(1.05);
}

.selection-placeholder.active {
  border-color: var(--accent-green);
  border-style: solid;
  background: rgba(34, 197, 94, 0.1);
}

.selection-placeholder.active .selection-placeholder-icon {
  color: var(--accent-green);
  animation: pulse 1s ease-in-out infinite;
}

.selection-placeholder.disabled {
  opacity: 0.4;
  cursor: not-allowed;
  pointer-events: none;
}

.selection-placeholder-icon {
  color: var(--text-muted);
  transition: all 150ms ease;
}

.selection-placeholder-text {
  font-size: 13px;
  font-weight: 500;
  color: var(--text-primary);
}

.selection-placeholder-hint {
  font-size: 11px;
  color: var(--text-muted);
}

/* ==========================================================================
   LOGS PANEL - RETRO TERMINAL AESTHETIC
   ========================================================================== */

/* Header icon for logs toggle */
.header-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

.header-icon {
  cursor: pointer;
  color: var(--text-muted);
  transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
  padding: 4px;
  border-radius: 4px;
}

.header-icon:hover {
  color: var(--accent-cyan);
  background: rgba(6, 182, 212, 0.1);
}

.header-icon.active {
  color: var(--accent-cyan);
  filter: drop-shadow(0 0 4px var(--accent-cyan));
}

.header-icon.has-errors {
  animation: error-pulse 2s ease-in-out infinite;
}

@keyframes error-pulse {
  0%, 100% { color: var(--text-muted); }
  50% { color: var(--accent-red); filter: drop-shadow(0 0 6px var(--accent-red)); }
}

/* Logs Panel Container */
.logs-panel {
  background: linear-gradient(180deg, #0a0f14 0%, #0d1117 100%);
  border: 1px solid rgba(6, 182, 212, 0.2);
  border-radius: 8px;
  overflow: hidden;
  box-shadow:
    0 0 20px rgba(6, 182, 212, 0.05),
    inset 0 1px 0 rgba(255, 255, 255, 0.02);
}

/* Logs Header */
.logs-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 12px;
  background: rgba(6, 182, 212, 0.05);
  border-bottom: 1px solid rgba(6, 182, 212, 0.15);
}

.logs-title {
  display: flex;
  align-items: center;
  gap: 8px;
  font-family: 'JetBrains Mono', 'SF Mono', 'Fira Code', 'Consolas', monospace;
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 1px;
  color: var(--accent-cyan);
  text-shadow: 0 0 8px rgba(6, 182, 212, 0.5);
}

.logs-title-icon {
  animation: blink 1s step-end infinite;
}

@keyframes blink {
  50% { opacity: 0; }
}

.logs-count {
  padding: 2px 6px;
  background: rgba(6, 182, 212, 0.15);
  border-radius: 4px;
  font-size: 9px;
  color: var(--text-muted);
}

.logs-actions {
  display: flex;
  gap: 4px;
}

.logs-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  background: transparent;
  border: 1px solid rgba(100, 116, 139, 0.3);
  border-radius: 4px;
  color: var(--text-muted);
  cursor: pointer;
  transition: all 0.15s ease;
}

.logs-btn:hover {
  background: rgba(239, 68, 68, 0.1);
  border-color: var(--accent-red);
  color: var(--accent-red);
}

/* Terminal Container */
.logs-terminal {
  position: relative;
  max-height: 240px;
  overflow: hidden;
}

/* CRT Scanlines Effect */
.logs-scanlines {
  position: absolute;
  inset: 0;
  pointer-events: none;
  background: repeating-linear-gradient(
    0deg,
    transparent,
    transparent 2px,
    rgba(0, 0, 0, 0.15) 2px,
    rgba(0, 0, 0, 0.15) 4px
  );
  z-index: 10;
}

/* Scrollable Content */
.logs-content {
  height: 100%;
  max-height: 240px;
  overflow-y: auto;
  padding: 8px 12px;
  font-family: 'JetBrains Mono', 'SF Mono', 'Fira Code', 'Consolas', monospace;
  font-size: 11px;
  line-height: 1.6;

  /* Custom scrollbar */
  scrollbar-width: thin;
  scrollbar-color: var(--accent-cyan) transparent;
}

.logs-content::-webkit-scrollbar {
  width: 6px;
}

.logs-content::-webkit-scrollbar-track {
  background: transparent;
}

.logs-content::-webkit-scrollbar-thumb {
  background: rgba(6, 182, 212, 0.3);
  border-radius: 3px;
}

.logs-content::-webkit-scrollbar-thumb:hover {
  background: rgba(6, 182, 212, 0.5);
}

/* Individual Log Line */
.log-line {
  display: flex;
  gap: 8px;
  padding: 2px 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.log-time {
  color: #4a5568;
  flex-shrink: 0;
  font-variant-numeric: tabular-nums;
}

.log-source {
  flex-shrink: 0;
  font-size: 9px;
  padding: 1px 4px;
  border-radius: 2px;
  font-weight: 600;
}

.source-ext .log-source {
  color: var(--accent-purple);
  background: rgba(168, 85, 247, 0.1);
}

.source-page .log-source {
  color: var(--accent-blue);
  background: rgba(59, 130, 246, 0.1);
}

.source-mcp .log-source {
  color: var(--accent-cyan);
  background: rgba(6, 182, 212, 0.1);
}

.log-level {
  flex-shrink: 0;
  font-size: 9px;
  font-weight: 700;
  min-width: 40px;
}

.level-debug .log-level { color: #6b7280; }
.level-info .log-level { color: var(--accent-cyan); }
.level-warn .log-level { color: var(--accent-amber); text-shadow: 0 0 4px rgba(245, 158, 11, 0.3); }
.level-error .log-level { color: var(--accent-red); text-shadow: 0 0 4px rgba(239, 68, 68, 0.4); }
.level-success .log-level { color: var(--accent-green); text-shadow: 0 0 4px rgba(34, 197, 94, 0.3); }

.log-msg {
  color: var(--text-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
}

.level-error .log-msg { color: rgba(239, 68, 68, 0.9); }
.level-warn .log-msg { color: rgba(245, 158, 11, 0.85); }

/* Blinking Cursor */
.log-cursor {
  display: flex;
  align-items: center;
  gap: 4px;
  margin-top: 4px;
  color: var(--accent-cyan);
  opacity: 0.7;
}

.cursor-prompt {
  font-size: 10px;
}

.cursor-block {
  width: 8px;
  height: 14px;
  background: var(--accent-cyan);
  animation: cursor-blink 1s step-end infinite;
}

@keyframes cursor-blink {
  0%, 100% { opacity: 1; }
  50% { opacity: 0; }
}

/* Entry Animation */
.log-entry-enter-active {
  animation: log-slide-in 0.2s cubic-bezier(0.4, 0, 0.2, 1);
}

@keyframes log-slide-in {
  from {
    opacity: 0;
    transform: translateX(-12px);
  }
  to {
    opacity: 1;
    transform: translateX(0);
  }
}

/* Panel Slide Animation */
.logs-slide-enter-active,
.logs-slide-leave-active {
  transition: all 0.25s cubic-bezier(0.4, 0, 0.2, 1);
}

.logs-slide-enter-from,
.logs-slide-leave-to {
  opacity: 0;
  max-height: 0;
  transform: translateY(-8px);
}

.logs-slide-enter-to,
.logs-slide-leave-from {
  opacity: 1;
  max-height: 300px;
  transform: translateY(0);
}
</style>
