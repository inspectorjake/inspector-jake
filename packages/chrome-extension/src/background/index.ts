/**
 * Jake MCP Chrome Extension - Background Service Worker
 *
 * Handles WebSocket connection to MCP server, tool request routing,
 * and communication with DevTools panel and content scripts.
 */

import { discoverSessions, type DiscoveredSession } from './discovery.js';
import {
  connectToSession,
  getConnectionStatus,
  disconnectSession,
  updateConnectedTab,
  handleKeepaliveAlarm,
  KEEPALIVE_ALARM_NAME,
} from './ws-client.js';
import {
  updateSelectedElement,
  markDevToolsOpen,
  markDevToolsClosed,
  updateAttachedSnapshots,
  updateSelections,
  captureElementScreenshot,
} from './tool-handlers.js';
import type { ElementInfo, SessionName } from '@inspector-jake/shared';
import { log } from '../utils/logger.js';

// Handle keepalive alarms to prevent service worker termination
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === KEEPALIVE_ALARM_NAME) {
    handleKeepaliveAlarm();
  }
});

// Handle messages from popup and DevTools
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender).then(sendResponse);
  return true; // Keep channel open for async response
});

async function handleMessage(
  message: any,
  sender: chrome.runtime.MessageSender
): Promise<any> {
  switch (message.type) {
    case 'DISCOVER_SESSIONS': {
      const sessions = await discoverSessions();
      return { sessions };
    }

    case 'CONNECT_SESSION': {
      const { sessionName, port, tabId } = message;
      try {
        await connectToSession(sessionName as SessionName, port, tabId);
        return { success: true };
      } catch (err) {
        return {
          success: false,
          error: err instanceof Error ? err.message : 'Connection failed',
        };
      }
    }

    case 'DISCONNECT_SESSION': {
      disconnectSession();
      return { success: true };
    }

    case 'GET_CONNECTION_STATUS': {
      return getConnectionStatus();
    }

    case 'UPDATE_CONNECTED_TAB': {
      const { tabId } = message;
      updateConnectedTab(tabId);
      return { success: true };
    }

    case 'DEVTOOLS_ELEMENT_SELECTED': {
      // Message from DevTools panel about selected element
      const { element, tabId } = message;
      updateSelectedElement(tabId, element as ElementInfo | null);
      return { success: true };
    }

    case 'DEVTOOLS_OPENED': {
      // Use message.tabId - DevTools pages don't have sender.tab
      const { tabId } = message;
      if (tabId) {
        markDevToolsOpen(tabId);
      }
      return { success: true };
    }

    case 'DEVTOOLS_CLOSED': {
      // Use message.tabId - DevTools pages don't have sender.tab
      const { tabId } = message;
      if (tabId) {
        markDevToolsClosed(tabId);
      }
      return { success: true };
    }

    case 'ELEMENT_PICKED': {
      // Relay from content script to DevTools panel
      // Also update the selected element in tool handlers
      const { element } = message;
      const tabId = sender.tab?.id;
      if (tabId) {
        updateSelectedElement(tabId, element);
      }
      // Broadcast to all extension contexts (panel will receive this)
      chrome.runtime.sendMessage(message).catch(() => {});
      return { success: true };
    }

    case 'PICKER_CANCELLED': {
      // Relay from content script to DevTools panel
      chrome.runtime.sendMessage(message).catch(() => {});
      return { success: true };
    }

    case 'SCREENSHOT_REGION_SELECTED': {
      // Relay from content script to DevTools panel (drag-to-capture region)
      chrome.runtime.sendMessage(message).catch(() => {});
      return { success: true };
    }

    case 'SYNC_SNAPSHOTS': {
      // Legacy: Update attached snapshots from panel
      updateAttachedSnapshots(message.snapshots || []);
      return { success: true };
    }

    case 'SYNC_SELECTIONS': {
      // Update unified selections from panel
      updateSelections(message.selections || []);
      return { success: true };
    }

    case 'CAPTURE_ELEMENT_SCREENSHOT': {
      // Capture screenshot of a specific element region
      // tabId comes from message (panel) or sender.tab (content script)
      const tabId = message.tabId || sender.tab?.id;
      if (!tabId) {
        return { success: false, error: 'No tab ID' };
      }
      const image = await captureElementScreenshot(tabId, message.rect);
      return { success: true, image };
    }

    case 'CAPTURE_REGION_SCREENSHOT': {
      // Capture screenshot of a user-selected region (from content script)
      const tabId = sender.tab?.id;
      if (!tabId) {
        return { success: false, error: 'No tab ID' };
      }
      const image = await captureElementScreenshot(tabId, message.rect);
      // Send the result back to the panel
      chrome.runtime.sendMessage({
        type: 'REGION_SELECTED',
        image,
        rect: message.rect,
      }).catch(() => {});
      return { success: true };
    }

    case 'REGION_CANCELLED': {
      // Relay from content script to DevTools panel
      chrome.runtime.sendMessage(message).catch(() => {});
      return { success: true };
    }

    default:
      return { error: 'Unknown message type' };
  }
}

// Clean up when tabs are closed
chrome.tabs.onRemoved.addListener((tabId) => {
  markDevToolsClosed(tabId);
});

log.info('Background', "Jake MCP background service worker started");
