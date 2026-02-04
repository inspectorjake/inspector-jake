/**
 * Jake MCP Content Script
 *
 * Runs in the context of web pages. Provides:
 * - Custom element picker with hover highlight
 * - DOM access for snapshots and element info
 * - CSS selector computation
 */

import {
  IMPLICIT_ROLES,
  getImplicitRole,
  computeAccessibleName,
  buildSelectorPart,
  type AccessibleNameContext,
  type SelectorContext,
} from '@inspector-jake/shared';

// Note: Content scripts can't use the shared logger easily,
// so we use console.log with a prefix for traceability
console.log("[Jake MCP] Content script loaded");

// ============================================================================
// Cleanup stale content script artifacts
// ============================================================================

// Global flag to disable orphaned handlers from old content scripts
const CONTENT_SCRIPT_VERSION = Date.now();
(window as any).__jakeMcpVersion = CONTENT_SCRIPT_VERSION;

// Remove any existing overlays from previous script instances
function cleanupStaleOverlays() {
  const staleOverlays = [
    'inspector-jake-highlight',
    'inspector-jake-label',
    'jake-mcp-drag-region',
    'inspector-jake-region-overlay',
    'inspector-jake-region-box',
    'inspector-jake-region-label',
    'inspector-jake-cursor',
  ];

  staleOverlays.forEach(id => {
    const el = document.getElementById(id);
    if (el) {
      el.remove();
      console.log(`[Jake MCP] Cleaned up stale overlay: ${id}`);
    }
  });
}

cleanupStaleOverlays();

// ============================================================================
// Console Capture Setup
// ============================================================================

(() => {
  const logs: Array<{ type: string; message: string; timestamp: number }> = [];
  const MAX_LOGS = 1000;
  (window as any).__consoleLogs = logs;

  function pushLog(type: string, message: string) {
    logs.push({ type, message, timestamp: Date.now() });
    if (logs.length > MAX_LOGS) logs.shift();
  }

  // Patch console methods
  const methodsToCapture = ['log', 'warn', 'error', 'info', 'debug', 'trace'] as const;
  for (const method of methodsToCapture) {
    const original = console[method].bind(console);
    console[method] = (...args: any[]) => {
      pushLog(method, args.map(a => {
        try { return typeof a === 'string' ? a : JSON.stringify(a); }
        catch { return String(a); }
      }).join(' '));
      original(...args);
    };
  }

  // Patch console.assert
  const originalAssert = console.assert.bind(console);
  console.assert = (condition?: boolean, ...args: any[]) => {
    if (!condition) {
      pushLog('assert', 'Assertion failed: ' + args.map(a => {
        try { return typeof a === 'string' ? a : JSON.stringify(a); }
        catch { return String(a); }
      }).join(' '));
    }
    originalAssert(condition, ...args);
  };

  // Uncaught exceptions
  window.addEventListener('error', (e) => {
    pushLog('exception', `${e.message} at ${e.filename}:${e.lineno}:${e.colno}`);
  });

  // Unhandled promise rejections
  window.addEventListener('unhandledrejection', (e) => {
    const reason = e.reason instanceof Error ? e.reason.message : String(e.reason);
    pushLog('unhandledrejection', reason);
  });
})();

/**
 * Check if this script instance is the current active one.
 * Old orphaned scripts will fail this check and exit early.
 */
function isCurrentVersion(): boolean {
  return (window as any).__jakeMcpVersion === CONTENT_SCRIPT_VERSION;
}

/**
 * Safely send message to background - handles invalidated extension context.
 * Chrome.runtime becomes undefined when extension is reloaded/updated.
 */
function safeSendMessage(message: any): void {
  try {
    if (chrome.runtime?.id) {
      chrome.runtime.sendMessage(message);
    }
  } catch (e) {
    console.warn('[Jake MCP] Extension context invalidated - reload page to reconnect');
  }
}

// ============================================================================
// Element Picker State
// ============================================================================

let isPicking = false;
let hoveredElement: Element | null = null;
let highlightOverlay: HTMLDivElement | null = null;
let labelOverlay: HTMLDivElement | null = null;
let cursorStyleTag: HTMLStyleElement | null = null;

// ============================================================================
// Highlight Overlay
// ============================================================================

function createHighlightOverlay() {
  if (highlightOverlay) return;

  highlightOverlay = document.createElement('div');
  highlightOverlay.id = 'inspector-jake-highlight';
  highlightOverlay.style.cssText = `
    position: fixed !important;
    pointer-events: none !important;
    z-index: 2147483647 !important;
    background: rgba(34, 197, 94, 0.15) !important;
    border: 2px solid #22C55E !important;
    border-radius: 2px !important;
    box-shadow: 0 0 0 1px rgba(34, 197, 94, 0.3) !important;
    transition: all 50ms ease-out !important;
    display: none !important;
  `;
  document.documentElement.appendChild(highlightOverlay);

  // Element label tooltip
  labelOverlay = document.createElement('div');
  labelOverlay.id = 'inspector-jake-label';
  labelOverlay.style.cssText = `
    position: fixed !important;
    pointer-events: none !important;
    z-index: 2147483647 !important;
    background: #0F172A !important;
    color: #22C55E !important;
    font-family: 'SF Mono', 'Fira Code', monospace !important;
    font-size: 11px !important;
    padding: 4px 8px !important;
    border-radius: 4px !important;
    white-space: nowrap !important;
    display: none !important;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3) !important;
  `;
  document.documentElement.appendChild(labelOverlay);
}

function updateHighlight(el: Element) {
  if (!highlightOverlay || !labelOverlay) return;

  const rect = el.getBoundingClientRect();

  highlightOverlay.style.display = 'block';
  highlightOverlay.style.left = `${rect.left}px`;
  highlightOverlay.style.top = `${rect.top}px`;
  highlightOverlay.style.width = `${rect.width}px`;
  highlightOverlay.style.height = `${rect.height}px`;

  // Build label text (handle SVG/namespaced elements where tagName might be undefined)
  let label = (el.tagName || 'element').toLowerCase();
  if ((el as HTMLElement).id) {
    label += `#${(el as HTMLElement).id}`;
  } else if (el.className && typeof el.className === 'string') {
    const classes = el.className.trim().split(/\s+/).slice(0, 2);
    if (classes.length > 0) {
      label += `.${classes.join('.')}`;
    }
  }
  label += ` ${Math.round(rect.width)}×${Math.round(rect.height)}`;

  labelOverlay.textContent = label;
  labelOverlay.style.display = 'block';

  // Position label above element, or below if not enough space
  const labelRect = labelOverlay.getBoundingClientRect();
  let labelTop = rect.top - labelRect.height - 6;
  if (labelTop < 4) {
    labelTop = rect.bottom + 6;
  }
  let labelLeft = rect.left;
  if (labelLeft + labelRect.width > window.innerWidth - 4) {
    labelLeft = window.innerWidth - labelRect.width - 4;
  }

  labelOverlay.style.top = `${labelTop}px`;
  labelOverlay.style.left = `${Math.max(4, labelLeft)}px`;
}

function hideHighlight() {
  if (highlightOverlay) highlightOverlay.style.display = 'none';
  if (labelOverlay) labelOverlay.style.display = 'none';
}

function removeHighlightOverlay() {
  if (highlightOverlay) {
    highlightOverlay.remove();
    highlightOverlay = null;
  }
  if (labelOverlay) {
    labelOverlay.remove();
    labelOverlay = null;
  }
}

// ============================================================================
// Element Picker Event Handlers
// ============================================================================

// Track drag state for click vs drag detection
let dragStartPos: { x: number; y: number } | null = null;
let isDragging = false;
const DRAG_THRESHOLD = 10; // pixels - if mouse moves more than this, it's a drag

function onMouseMove(e: MouseEvent) {
  if (!isPicking) return;

  // Check if we're dragging (for region screenshot)
  if (dragStartPos) {
    const dx = Math.abs(e.clientX - dragStartPos.x);
    const dy = Math.abs(e.clientY - dragStartPos.y);

    if (dx > DRAG_THRESHOLD || dy > DRAG_THRESHOLD) {
      isDragging = true;
      // Switch to crosshair cursor for region selection
      document.body.style.cursor = 'crosshair';
      // Hide element highlight during drag - show region instead
      hideHighlight();
      updateDragRegion(dragStartPos, e);
      return;
    }
  }

  // Normal hover highlighting for element selection
  const target = e.target as Element;
  if (
    target === highlightOverlay ||
    target === labelOverlay ||
    target === dragRegionOverlay ||
    target === document.documentElement ||
    target === document.body
  ) {
    return;
  }

  hoveredElement = target;
  updateHighlight(target);
}

function onMouseLeave() {
  if (!isPicking) return;
  hideHighlight();
  hoveredElement = null;
}

function onMouseDown(e: MouseEvent) {
  if (!isPicking) return;

  e.preventDefault();
  dragStartPos = { x: e.clientX, y: e.clientY };
  isDragging = false;
}

function onMouseUp(e: MouseEvent) {
  if (!isPicking || !dragStartPos) return;
  if (!isCurrentVersion()) return; // Orphaned script check

  e.preventDefault();
  e.stopPropagation();
  e.stopImmediatePropagation();

  if (isDragging) {
    // Drag completed - capture screenshot region
    const rect = {
      x: Math.min(dragStartPos.x, e.clientX),
      y: Math.min(dragStartPos.y, e.clientY),
      width: Math.abs(e.clientX - dragStartPos.x),
      height: Math.abs(e.clientY - dragStartPos.y),
    };

    // Only capture if region is big enough
    if (rect.width > 20 && rect.height > 20) {
      safeSendMessage({
        type: 'SCREENSHOT_REGION_SELECTED',
        rect,
      });
    }

    hideDragRegion();
    stopPicking();
  } else if (hoveredElement) {
    // Click - select element
    const element = hoveredElement;
    const info = (window as any).__jakesVibe.getElementInfo(element);

    safeSendMessage({
      type: 'ELEMENT_PICKED',
      element: info,
    });

    stopPicking();
  }

  dragStartPos = null;
  isDragging = false;
}

function onKeyDown(e: KeyboardEvent) {
  if (!isPicking) return;
  if (!isCurrentVersion()) return; // Orphaned script check

  // Escape to cancel
  if (e.key === 'Escape') {
    e.preventDefault();
    hideDragRegion();
    stopPicking();
    safeSendMessage({ type: 'PICKER_CANCELLED' });
  }
}

function onClick(e: MouseEvent) {
  if (!isPicking) return;
  if (!isCurrentVersion()) return; // Orphaned script check
  // Prevent default click action (navigation, form submit, etc.)
  e.preventDefault();
  e.stopPropagation();
  e.stopImmediatePropagation();
}

// ============================================================================
// Drag Region Overlay (for screenshot selection)
// ============================================================================

let dragRegionOverlay: HTMLDivElement | null = null;

function createDragRegionOverlay() {
  if (dragRegionOverlay) return;

  dragRegionOverlay = document.createElement('div');
  dragRegionOverlay.id = 'jake-mcp-drag-region';
  dragRegionOverlay.style.cssText = `
    position: fixed !important;
    pointer-events: none !important;
    z-index: 2147483647 !important;
    background: rgba(59, 130, 246, 0.15) !important;
    border: 2px dashed #3B82F6 !important;
    border-radius: 2px !important;
    display: none !important;
  `;
  document.documentElement.appendChild(dragRegionOverlay);
}

function updateDragRegion(start: { x: number; y: number }, current: MouseEvent) {
  if (!dragRegionOverlay) createDragRegionOverlay();
  if (!dragRegionOverlay) return;

  const x = Math.min(start.x, current.clientX);
  const y = Math.min(start.y, current.clientY);
  const width = Math.abs(current.clientX - start.x);
  const height = Math.abs(current.clientY - start.y);

  dragRegionOverlay.style.display = 'block';
  dragRegionOverlay.style.left = `${x}px`;
  dragRegionOverlay.style.top = `${y}px`;
  dragRegionOverlay.style.width = `${width}px`;
  dragRegionOverlay.style.height = `${height}px`;
}

function hideDragRegion() {
  if (dragRegionOverlay) {
    dragRegionOverlay.style.display = 'none';
  }
}

function removeDragRegionOverlay() {
  if (dragRegionOverlay) {
    dragRegionOverlay.remove();
    dragRegionOverlay = null;
  }
}

// ============================================================================
// Picker Control
// ============================================================================

function startPicking() {
  console.log('[Jake MCP Content] startPicking() called, current isPicking:', isPicking);
  if (isPicking) return;

  isPicking = true;
  console.log('[Jake MCP Content] isPicking set to true, adding event listeners');
  dragStartPos = null;
  isDragging = false;

  createHighlightOverlay();

  // Inject global cursor override (guarantees crosshair on all elements)
  cursorStyleTag = document.createElement('style');
  cursorStyleTag.id = 'inspector-jake-cursor';
  cursorStyleTag.textContent = '* { cursor: default !important; }';
  document.head.appendChild(cursorStyleTag);

  document.addEventListener('mousemove', onMouseMove, true);
  document.addEventListener('mouseleave', onMouseLeave, true);
  document.addEventListener('mousedown', onMouseDown, true);
  document.addEventListener('mouseup', onMouseUp, true);
  document.addEventListener('click', onClick, true);
  document.addEventListener('keydown', onKeyDown, true);
}

function stopPicking() {
  if (!isPicking) return;

  isPicking = false;
  hoveredElement = null;
  dragStartPos = null;
  isDragging = false;

  document.removeEventListener('mousemove', onMouseMove, true);
  document.removeEventListener('mouseleave', onMouseLeave, true);
  document.removeEventListener('mousedown', onMouseDown, true);
  document.removeEventListener('mouseup', onMouseUp, true);
  document.removeEventListener('click', onClick, true);
  document.removeEventListener('keydown', onKeyDown, true);

  hideHighlight();
  removeHighlightOverlay();
  removeDragRegionOverlay();

  // Remove cursor override
  if (cursorStyleTag) {
    cursorStyleTag.remove();
    cursorStyleTag = null;
  }
  document.body.style.cursor = '';
}

// ============================================================================
// Selector Highlight (non-picking mode)
// ============================================================================

function highlightBySelector(selector: string) {
  try {
    const el = document.querySelector(selector);
    if (el) {
      createHighlightOverlay();
      updateHighlight(el);
    }
  } catch {
    // Invalid selector, ignore
  }
}

// ============================================================================
// Region Selection State
// ============================================================================

let regionSelection = {
  isActive: false,
  isDrawing: false,
  startX: 0,
  startY: 0,
  overlay: null as HTMLDivElement | null,
  selectionBox: null as HTMLDivElement | null,
  instructionLabel: null as HTMLDivElement | null,
};

// ============================================================================
// Region Selection Overlay
// ============================================================================

function createRegionOverlay() {
  if (regionSelection.overlay) return;

  // Full-page semi-transparent overlay
  regionSelection.overlay = document.createElement('div');
  regionSelection.overlay.id = 'inspector-jake-region-overlay';
  regionSelection.overlay.style.cssText = `
    position: fixed !important;
    top: 0 !important;
    left: 0 !important;
    width: 100vw !important;
    height: 100vh !important;
    background: rgba(15, 23, 42, 0.3) !important;
    cursor: crosshair !important;
    z-index: 2147483646 !important;
  `;
  document.documentElement.appendChild(regionSelection.overlay);

  // Selection box
  regionSelection.selectionBox = document.createElement('div');
  regionSelection.selectionBox.id = 'inspector-jake-region-box';
  regionSelection.selectionBox.style.cssText = `
    position: fixed !important;
    pointer-events: none !important;
    z-index: 2147483647 !important;
    background: rgba(34, 197, 94, 0.1) !important;
    border: 2px dashed #22C55E !important;
    border-radius: 2px !important;
    display: none !important;
  `;
  document.documentElement.appendChild(regionSelection.selectionBox);

  // Instruction label
  regionSelection.instructionLabel = document.createElement('div');
  regionSelection.instructionLabel.id = 'inspector-jake-region-label';
  regionSelection.instructionLabel.style.cssText = `
    position: fixed !important;
    top: 16px !important;
    left: 50% !important;
    transform: translateX(-50%) !important;
    background: #0F172A !important;
    color: #F8FAFC !important;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif !important;
    font-size: 13px !important;
    padding: 8px 16px !important;
    border-radius: 6px !important;
    z-index: 2147483647 !important;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3) !important;
  `;
  regionSelection.instructionLabel.textContent = 'Drag to select a region • Press Esc to cancel';
  document.documentElement.appendChild(regionSelection.instructionLabel);
}

function removeRegionOverlay() {
  if (regionSelection.overlay) {
    regionSelection.overlay.remove();
    regionSelection.overlay = null;
  }
  if (regionSelection.selectionBox) {
    regionSelection.selectionBox.remove();
    regionSelection.selectionBox = null;
  }
  if (regionSelection.instructionLabel) {
    regionSelection.instructionLabel.remove();
    regionSelection.instructionLabel = null;
  }
}

function updateSelectionBox(e: MouseEvent) {
  if (!regionSelection.selectionBox || !regionSelection.isDrawing) return;

  const x = Math.min(regionSelection.startX, e.clientX);
  const y = Math.min(regionSelection.startY, e.clientY);
  const width = Math.abs(e.clientX - regionSelection.startX);
  const height = Math.abs(e.clientY - regionSelection.startY);

  regionSelection.selectionBox.style.display = 'block';
  regionSelection.selectionBox.style.left = `${x}px`;
  regionSelection.selectionBox.style.top = `${y}px`;
  regionSelection.selectionBox.style.width = `${width}px`;
  regionSelection.selectionBox.style.height = `${height}px`;
}

// ============================================================================
// Region Selection Event Handlers
// ============================================================================

function onRegionMouseDown(e: MouseEvent) {
  if (!regionSelection.isActive) return;

  regionSelection.isDrawing = true;
  regionSelection.startX = e.clientX;
  regionSelection.startY = e.clientY;

  // Reset selection box
  if (regionSelection.selectionBox) {
    regionSelection.selectionBox.style.display = 'none';
  }
}

function onRegionMouseMove(e: MouseEvent) {
  if (!regionSelection.isActive || !regionSelection.isDrawing) return;
  updateSelectionBox(e);
}

function onRegionMouseUp(e: MouseEvent) {
  if (!regionSelection.isActive || !regionSelection.isDrawing) return;
  if (!isCurrentVersion()) return; // Orphaned script check

  regionSelection.isDrawing = false;

  const x = Math.min(regionSelection.startX, e.clientX);
  const y = Math.min(regionSelection.startY, e.clientY);
  const width = Math.abs(e.clientX - regionSelection.startX);
  const height = Math.abs(e.clientY - regionSelection.startY);

  // Minimum size check
  if (width < 10 || height < 10) {
    // Too small, ignore
    return;
  }

  // Request screenshot from background and send back with region info
  safeSendMessage({
    type: 'CAPTURE_REGION_SCREENSHOT',
    rect: { x, y, width, height },
  });

  stopRegionSelection();
}

function onRegionKeyDown(e: KeyboardEvent) {
  if (!regionSelection.isActive) return;
  if (!isCurrentVersion()) return; // Orphaned script check

  if (e.key === 'Escape') {
    e.preventDefault();
    stopRegionSelection();
    safeSendMessage({ type: 'REGION_CANCELLED' });
  }
}

// ============================================================================
// Region Selection Control
// ============================================================================

function startRegionSelection() {
  if (regionSelection.isActive) return;

  regionSelection.isActive = true;
  regionSelection.isDrawing = false;
  createRegionOverlay();

  if (regionSelection.overlay) {
    regionSelection.overlay.addEventListener('mousedown', onRegionMouseDown);
    regionSelection.overlay.addEventListener('mousemove', onRegionMouseMove);
    regionSelection.overlay.addEventListener('mouseup', onRegionMouseUp);
  }
  document.addEventListener('keydown', onRegionKeyDown, true);
}

function stopRegionSelection() {
  if (!regionSelection.isActive) return;

  regionSelection.isActive = false;
  regionSelection.isDrawing = false;

  if (regionSelection.overlay) {
    regionSelection.overlay.removeEventListener('mousedown', onRegionMouseDown);
    regionSelection.overlay.removeEventListener('mousemove', onRegionMouseMove);
    regionSelection.overlay.removeEventListener('mouseup', onRegionMouseUp);
  }
  document.removeEventListener('keydown', onRegionKeyDown, true);

  removeRegionOverlay();
}

// ============================================================================
// Message Listener
// ============================================================================

// Only add listener if extension context is valid
if (chrome.runtime?.id) {
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    console.log('[Jake MCP Content] Received message:', message.type);

    switch (message.type) {
      case 'START_ELEMENT_PICKER':
        console.log('[Jake MCP Content] Starting picker...');
        startPicking();
        console.log('[Jake MCP Content] Picker started, isPicking:', isPicking);
        sendResponse({ success: true });
        break;
      case 'STOP_ELEMENT_PICKER':
        stopPicking();
        sendResponse({ success: true });
        break;
      case 'HIGHLIGHT_SELECTOR':
        highlightBySelector(message.selector);
        sendResponse({ success: true });
        break;
      case 'CLEAR_HIGHLIGHT':
        hideHighlight();
        sendResponse({ success: true });
        break;
      case 'START_REGION_SELECTION':
        startRegionSelection();
        sendResponse({ success: true });
        break;
      case 'STOP_REGION_SELECTION':
        stopRegionSelection();
        sendResponse({ success: true });
        break;
      default:
        sendResponse({ success: false, error: 'Unknown message type' });
    }
    return true;
  });
}

// ============================================================================
// A11y Path Generation (uses shared utilities)
// ============================================================================

/**
 * Get accessible name for an element using shared utility.
 * Creates the context required by computeAccessibleName.
 */
function getAccessibleName(el: Element): string | null {
  const ctx: AccessibleNameContext = {
    tagName: el.tagName,
    getAttribute: (name) => el.getAttribute(name),
    innerText: (el as HTMLElement).innerText,
    getElementById: (id) => document.getElementById(id),
  };
  return computeAccessibleName(ctx);
}

/**
 * Build a simple selector for an element using shared utility.
 * Creates the context required by buildSelectorPart.
 */
function buildSimpleSelector(el: Element): string {
  const parent = el.parentElement;
  let siblingIndex: number | undefined;
  let siblingCount: number | undefined;

  if (parent) {
    const siblings = Array.from(parent.children).filter((s) => s.tagName === el.tagName);
    siblingCount = siblings.length;
    siblingIndex = siblings.indexOf(el) + 1;
  }

  const ctx: SelectorContext = {
    tagName: el.tagName,
    id: el.id || null,
    className: typeof el.className === 'string' ? el.className : null,
    getAttribute: (name) => el.getAttribute(name),
    siblingIndex,
    siblingCount,
  };
  return buildSelectorPart(ctx);
}

function buildA11yPath(el: Element): string {
  const path: string[] = [];
  let current: Element | null = el;

  while (current && current !== document.body && current !== document.documentElement) {
    const role = current.getAttribute('role') || getImplicitRole(current.tagName);
    const name = getAccessibleName(current);
    const selector = buildSimpleSelector(current);

    let node = `- ${role || (current.tagName || 'element').toLowerCase()}`;
    if (name) {
      // Truncate and escape name
      const truncated = name.slice(0, 50).replace(/"/g, '\\"');
      node += ` "${truncated}"`;
    }
    node += ` [${selector}]`;

    path.unshift(node);
    current = current.parentElement;
  }

  // Mark the last one as selected
  if (path.length > 0) {
    path[path.length - 1] += ' ← SELECTED';
  }

  // Format with indentation
  return path.map((line, i) => '  '.repeat(i) + line).join('\n');
}

// ============================================================================
// Utilities (exposed for executeScript)
// ============================================================================

(window as any).__jakesVibe = {
  /**
   * Compute a unique CSS selector for an element.
   */
  computeSelector(el: Element): string {
    if (el.id) {
      return `#${CSS.escape(el.id)}`;
    }

    const path: string[] = [];
    let current: Element | null = el;

    while (current && current !== document.body) {
      let selector = (current.tagName || 'element').toLowerCase();

      // Add classes for specificity
      if (current.className && typeof current.className === 'string') {
        const classes = current.className.trim().split(/\s+/).filter(c => c);
        if (classes.length > 0) {
          selector += '.' + classes.map(c => CSS.escape(c)).join('.');
        }
      }

      // Add nth-child if there are siblings with same tag
      const parent = current.parentElement;
      if (parent) {
        const siblings = Array.from(parent.children).filter(
          (s) => s.tagName === current!.tagName
        );
        if (siblings.length > 1) {
          const index = siblings.indexOf(current) + 1;
          selector += `:nth-of-type(${index})`;
        }
      }

      path.unshift(selector);
      current = current.parentElement;
    }

    return path.join(' > ');
  },

  /**
   * Get detailed info about an element.
   */
  getElementInfo(el: Element): any {
    const rect = el.getBoundingClientRect();

    return {
      tagName: (el.tagName || 'element').toLowerCase(),
      id: el.id || null,
      className: el.className || null,
      selector: this.computeSelector(el),
      a11yPath: buildA11yPath(el),
      innerText: (el as HTMLElement).innerText?.slice(0, 200) || null,
      attributes: Array.from(el.attributes).map((a) => ({
        name: a.name,
        value: a.value,
      })),
      rect: {
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
        top: rect.top,
        right: rect.right,
        bottom: rect.bottom,
        left: rect.left,
      },
    };
  },
};

// Backwards compatibility aliases
(window as any).__vibeJake = (window as any).__jakesVibe;
(window as any).__inspectorJake = (window as any).__jakesVibe;
