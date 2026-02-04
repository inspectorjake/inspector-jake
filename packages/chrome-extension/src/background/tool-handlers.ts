/**
 * Tool handlers for InspectorJake MCP tools.
 * These handle requests from the MCP server and return results.
 *
 * Includes both inspection tools and browser automation tools.
 */

import type {
  ToolRequest,
  ToolResponse,
  ScreenshotResponse,
  GetPageInfoRequest,
  ElementInfo,
  Selection,
  GetSelectionsRequest,
  ViewImageRequest,
  InteractiveContextResponse,
  BrowserClickRequest,
  BrowserTypeRequest,
  BrowserSelectOptionRequest,
  BrowserNavigateRequest,
  BrowserEvaluateRequest,
  BrowserScreenshotRequest,
  BrowserGetConsoleLogsRequest,
  BrowserActionResponse,
  BrowserEvaluateResponse,
  BrowserConsoleLogsResponse,
  WaitForElementRequest,
  WaitForElementResponse,
} from '@inspector-jake/shared';
import { formatDimensions } from '@inspector-jake/shared';
import {
  attachDebugger,
  detachDebugger,
  isDebuggerAttached,
  cdpClick,
  cdpType,
  cdpPressKey,
  cdpScreenshot,
} from './cdp.js';

// Cache of selected elements from DevTools, keyed by tabId
const selectedElements = new Map<number, ElementInfo | null>();

// Cache of unified selections from DevTools panel
let storedSelections: Selection[] = [];

/**
 * Update selections (called from panel).
 */
export function updateSelections(selections: Selection[]): void {
  storedSelections = selections;
}

/**
 * Get selections for including in tool responses.
 */
export function getSelections(): Selection[] {
  return storedSelections;
}

/**
 * Clear all selections.
 */
export function clearSelections(): void {
  storedSelections = [];
}

// Legacy aliases for backward compatibility
export function updateAttachedSnapshots(snapshots: any[]): void {
  // Convert legacy snapshot format to selections if needed
  storedSelections = snapshots as Selection[];
}

export function getAttachedSnapshots(): any[] {
  return storedSelections;
}

export function clearAttachedSnapshots(): void {
  storedSelections = [];
}

/**
 * Selection response format for tool handlers.
 */
interface SelectionResponse {
  type: 'element' | 'screenshot';
  id: string;
  image?: string;
  selector?: string;
  tagName?: string;
  className?: string;
  dimensions: string;
  rect: { x: number; y: number; width: number; height: number };
  hint?: string;
}

/**
 * Build selections response with differentiated format.
 * Single source of truth for selection response building.
 */
function buildSelectionsResponse(selections: Selection[] = storedSelections): SelectionResponse[] {
  return selections.map((sel) => {
    const dimensions = formatDimensions(sel);
    const base = {
      id: sel.id,
      dimensions,
      rect: sel.rect,
    };

    if (sel.type === 'screenshot') {
      return {
        type: 'screenshot' as const,
        ...base,
        image: sel.image,
      };
    }

    return {
      type: 'element' as const,
      ...base,
      selector: sel.selector,
      tagName: sel.tagName,
      className: sel.className,
      hint: `Use view_user_selection_image tool with imageId="${sel.id}" to see this element's screenshot`,
    };
  });
}

/**
 * Update the selected element for a tab (called from DevTools panel).
 */
export function updateSelectedElement(tabId: number, element: ElementInfo | null): void {
  selectedElements.set(tabId, element);
}

/**
 * Check if DevTools is open for a tab.
 */
const devToolsOpenTabs = new Set<number>();

export function markDevToolsOpen(tabId: number): void {
  devToolsOpenTabs.add(tabId);
}

export function markDevToolsClosed(tabId: number): void {
  devToolsOpenTabs.delete(tabId);
  selectedElements.delete(tabId);
}

export function isDevToolsOpen(tabId: number): boolean {
  return devToolsOpenTabs.has(tabId);
}

/**
 * Handle incoming tool request from MCP server.
 */
export async function handleToolRequest(
  request: ToolRequest,
  tabId: number | null
): Promise<ToolResponse> {
  const { id, type, payload } = request;

  try {
    switch (type) {
      case 'get_user_selections':
        return {
          id,
          success: true,
          result: handleGetSelections(),
        };

      case 'view_user_selection_image':
        return {
          id,
          success: true,
          result: handleViewImage(payload as ViewImageRequest),
        };

      case 'get_page_info':
        return {
          id,
          success: true,
          result: await handleCombinedPageInfo(tabId, payload as GetPageInfoRequest),
        };

      case 'capture_screenshot':
        return {
          id,
          success: true,
          result: await handleBrowserScreenshot(tabId, payload as BrowserScreenshotRequest),
        };

      case 'run_javascript':
        return {
          id,
          success: true,
          result: await handleBrowserEvaluate(tabId, payload as BrowserEvaluateRequest),
        };

      case 'get_console_logs':
        return {
          id,
          success: true,
          result: await handleBrowserGetConsoleLogs(tabId, payload as BrowserGetConsoleLogsRequest),
        };

      case 'navigate_to_url':
        return {
          id,
          success: true,
          result: await handleBrowserNavigate(tabId, payload as BrowserNavigateRequest),
        };

      case 'go_back':
        return {
          id,
          success: true,
          result: await handleBrowserGoBack(tabId),
        };

      case 'go_forward':
        return {
          id,
          success: true,
          result: await handleBrowserGoForward(tabId),
        };

      case 'reload_page':
        return {
          id,
          success: true,
          result: await handleBrowserReload(tabId),
        };

      case 'click_element':
        return {
          id,
          success: true,
          result: await handleBrowserClick(tabId, payload as BrowserClickRequest),
        };

      case 'type_into_element':
        return {
          id,
          success: true,
          result: await handleBrowserType(tabId, payload as BrowserTypeRequest),
        };

      case 'select_dropdown_option':
        return {
          id,
          success: true,
          result: await handleBrowserSelectOption(tabId, payload as BrowserSelectOptionRequest),
        };

      case 'wait_for_element':
        return {
          id,
          success: true,
          result: await handleWaitForElement(tabId, payload as WaitForElementRequest),
        };

      default:
        return {
          id,
          success: false,
          error: `Unknown tool type: ${type}`,
        };
    }
  } catch (err) {
    return {
      id,
      success: false,
      error: err instanceof Error ? err.message : 'Unknown error',
    };
  }
}

/**
 * Handle get_user_selections tool.
 * Returns all selections with differentiated response format.
 */
function handleGetSelections(): { selections: SelectionResponse[] } {
  return { selections: buildSelectionsResponse() };
}

/**
 * Handle view_image tool.
 * Returns the stored image for an element selection by its ID.
 */
function handleViewImage(payload: ViewImageRequest): { image: string; width: number; height: number } | { error: string } {
  const { imageId } = payload;
  const selection = storedSelections.find(s => s.id === imageId);

  if (!selection) {
    return { error: `No image found with id: ${imageId}` };
  }

  return {
    image: selection.image,
    width: selection.width,
    height: selection.height,
  };
}

/**
 * Handle screenshot capture (internal, used by capture_screenshot fallback).
 * Supports optional CSS selector to capture specific element.
 */
async function handleScreenshot(
  tabId: number | null,
  payload: ScreenshotRequest
): Promise<ScreenshotResponse> {
  if (!tabId) {
    throw new Error('No tab connected');
  }

  // Capture visible area using chrome.tabs.captureVisibleTab
  const dataUrl = await chrome.tabs.captureVisibleTab(undefined, {
    format: 'png',
  });

  // If selector provided, resolve element and crop to its bounds
  if (payload.selector) {
    // Execute script to get element rect (scaled by devicePixelRatio for screenshot coordinates)
    const [result] = await chrome.scripting.executeScript({
      target: { tabId },
      func: (selector: string) => {
        const el = document.querySelector(selector);
        if (!el) return null;
        const rect = el.getBoundingClientRect();
        const dpr = window.devicePixelRatio || 1;
        return {
          x: Math.round(rect.x * dpr),
          y: Math.round(rect.y * dpr),
          width: Math.round(rect.width * dpr),
          height: Math.round(rect.height * dpr),
        };
      },
      args: [payload.selector ?? null],
    });

    if (!result?.result) {
      throw new Error(`Element not found: ${payload.selector}`);
    }

    const rect = result.result;

    // Crop to element rect using existing cropImageToRect
    const croppedImage = await cropImageToRect(dataUrl, rect);
    return {
      image: croppedImage,
      width: rect.width,
      height: rect.height,
    };
  }

  // No selector - return full viewport (existing behavior)
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => ({
      width: window.innerWidth,
      height: window.innerHeight,
    }),
  });

  const dimensions = results[0]?.result || { width: 0, height: 0 };

  return {
    image: dataUrl,
    width: dimensions.width,
    height: dimensions.height,
  };
}

/**
 * Handle page info request (internal helper for get_page_info).
 */
async function handleGetPageInfo(tabId: number | null): Promise<GetPageInfoResponse> {
  if (!tabId) {
    throw new Error('No tab connected');
  }

  const tab = await chrome.tabs.get(tabId);

  // Get viewport dimensions
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => ({
      width: window.innerWidth,
      height: window.innerHeight,
    }),
  });

  const viewport = results[0]?.result || { width: 0, height: 0 };

  return {
    url: tab.url || '',
    title: tab.title || '',
    viewport,
  };
}

/**
 * Handle combined get_page_info tool.
 * Merges page info (URL, title, viewport) with interactive ARIA snapshot and selections.
 */
async function handleCombinedPageInfo(
  tabId: number | null,
  payload: GetPageInfoRequest
): Promise<InteractiveContextResponse> {
  if (!tabId) {
    throw new Error('No tab connected');
  }

  // Get page info
  const tab = await chrome.tabs.get(tabId);

  // Get viewport dimensions
  const viewportResults = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => ({
      width: window.innerWidth,
      height: window.innerHeight,
    }),
  });

  const viewport = viewportResults[0]?.result || { width: 0, height: 0 };

  // Generate ARIA snapshot with refs
  const snapshotResults = await chrome.scripting.executeScript({
    target: { tabId },
    func: generateInteractiveSnapshot,
    args: [payload.selector || null],
  });

  if (!snapshotResults || snapshotResults.length === 0 || !snapshotResults[0].result) {
    throw new Error('Failed to generate page snapshot');
  }

  return {
    url: tab.url || '',
    title: tab.title || '',
    viewport,
    snapshot: snapshotResults[0].result,
  };
}

/**
 * Capture an element screenshot by cropping a full-page screenshot.
 * Handles devicePixelRatio scaling for Retina/HiDPI displays.
 */
export async function captureElementScreenshot(
  tabId: number,
  rect: { x: number; y: number; width: number; height: number }
): Promise<string | null> {
  try {
    // Get devicePixelRatio from the tab (captureVisibleTab captures at device resolution)
    const [dprResult] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => window.devicePixelRatio || 1,
    });
    const dpr = dprResult?.result || 1;

    // Scale rect by DPR for screenshot coordinates
    const scaledRect = {
      x: Math.round(rect.x * dpr),
      y: Math.round(rect.y * dpr),
      width: Math.round(rect.width * dpr),
      height: Math.round(rect.height * dpr),
    };

    // Capture the visible area
    const fullDataUrl = await chrome.tabs.captureVisibleTab(undefined, {
      format: 'png',
    });

    // Crop to the element's bounding rect using OffscreenCanvas
    const croppedDataUrl = await cropImageToRect(fullDataUrl, scaledRect);
    return croppedDataUrl;
  } catch (err) {
    console.error('[Tool Handlers] Failed to capture element screenshot:', err);
    return null;
  }
}

/**
 * Crop a data URL image to a specific rect.
 */
async function cropImageToRect(
  dataUrl: string,
  rect: { x: number; y: number; width: number; height: number }
): Promise<string> {
  // Use OffscreenCanvas in the service worker
  const response = await fetch(dataUrl);
  const blob = await response.blob();
  const imageBitmap = await createImageBitmap(blob);

  // Create canvas for cropping
  const canvas = new OffscreenCanvas(rect.width, rect.height);
  const ctx = canvas.getContext('2d');

  if (!ctx) {
    throw new Error('Failed to get canvas context');
  }

  // Draw cropped region
  ctx.drawImage(
    imageBitmap,
    rect.x,
    rect.y,
    rect.width,
    rect.height,
    0,
    0,
    rect.width,
    rect.height
  );

  // Convert to data URL
  const croppedBlob = await canvas.convertToBlob({ type: 'image/png' });
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(croppedBlob);
  });
}

// =============================================================================
// Browser Automation Tool Handlers
// =============================================================================

// Console log storage for get_console_logs
const consoleLogs: Map<number, Array<{ type: string; message: string; timestamp: number }>> = new Map();

/**
 * Content script function to generate ARIA snapshot with refs.
 * This runs in the page context.
 */
function generateInteractiveSnapshot(rootSelector: string | null): string {
  // Use the aria-tree module if available, otherwise inline implementation
  const jakesVibe = (window as any).__jakesVibe;

  // Configuration
  const MAX_NAME_LENGTH = 500;

  // ARIA role mappings
  const TAG_TO_ROLE: Record<string, string> = {
    A: 'link', BUTTON: 'button', INPUT: 'textbox', SELECT: 'combobox',
    TEXTAREA: 'textbox', IMG: 'img', H1: 'heading', H2: 'heading',
    H3: 'heading', H4: 'heading', H5: 'heading', H6: 'heading',
    NAV: 'navigation', MAIN: 'main', ASIDE: 'complementary',
    HEADER: 'banner', FOOTER: 'contentinfo', FORM: 'form',
    TABLE: 'table', TR: 'row', TH: 'columnheader', TD: 'cell',
    UL: 'list', OL: 'list', LI: 'listitem', ARTICLE: 'article', SECTION: 'region',
  };

  const INTERACTIVE_TAGS = ['A', 'BUTTON', 'INPUT', 'SELECT', 'TEXTAREA'];
  const CHECKABLE_ROLES = ['checkbox', 'radio', 'menuitemcheckbox', 'menuitemradio', 'switch'];
  const DISABLEABLE_ROLES = ['button', 'textbox', 'checkbox', 'radio', 'combobox', 'listbox', 'slider', 'spinbutton'];
  const EXPANDABLE_ROLES = ['button', 'combobox', 'listbox', 'treeitem', 'row'];
  const SELECTABLE_ROLES = ['option', 'tab', 'treeitem', 'row', 'cell'];

  // Generation counter (persisted on window for consistency)
  (window as any).__ariaGeneration = ((window as any).__ariaGeneration || 0) + 1;
  const generation = (window as any).__ariaGeneration;

  // Element map for ref resolution
  const elementMap = new Map<number, Element>();
  (window as any).__ariaElementMap = elementMap;
  (window as any).__ariaCurrentGeneration = generation;
  let elementIndex = 0;

  function assignRef(element: Element): string {
    const index = ++elementIndex;
    elementMap.set(index, element);
    return `s${generation}e${index}`;
  }

  function getElementRole(element: Element): string {
    const explicitRole = element.getAttribute('role');
    if (explicitRole && explicitRole !== 'presentation' && explicitRole !== 'none') {
      return explicitRole;
    }
    if (explicitRole === 'presentation' || explicitRole === 'none') {
      return 'generic';
    }
    const tagRole = TAG_TO_ROLE[element.tagName];
    if (tagRole) {
      if (element.tagName === 'INPUT') {
        const type = (element as HTMLInputElement).type.toLowerCase();
        if (type === 'checkbox') return 'checkbox';
        if (type === 'radio') return 'radio';
        if (type === 'button' || type === 'submit' || type === 'reset') return 'button';
        if (type === 'range') return 'slider';
        if (type === 'number') return 'spinbutton';
        return 'textbox';
      }
      return tagRole;
    }
    if (element.hasAttribute('onclick') || element.hasAttribute('tabindex')) {
      return 'button';
    }
    return 'generic';
  }

  function getAccessibleName(element: Element): string {
    const ariaLabel = element.getAttribute('aria-label');
    if (ariaLabel) return ariaLabel.trim();

    const labelledBy = element.getAttribute('aria-labelledby');
    if (labelledBy) {
      const parts = labelledBy.split(/\s+/).map(id => document.getElementById(id)?.textContent?.trim() || '');
      const combined = parts.filter(Boolean).join(' ');
      if (combined) return combined;
    }

    const title = element.getAttribute('title');
    if (title) return title.trim();

    if (element instanceof HTMLImageElement) return element.alt;

    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
      if (element.placeholder) return element.placeholder;
    }

    if (element instanceof HTMLInputElement || element instanceof HTMLSelectElement || element instanceof HTMLTextAreaElement) {
      const id = element.id;
      if (id) {
        const label = document.querySelector(`label[for="${id}"]`);
        if (label) return label.textContent?.trim() || '';
      }
    }

    if (element.tagName === 'BUTTON' || element.tagName === 'A') {
      let text = '';
      for (const node of element.childNodes) {
        if (node.nodeType === Node.TEXT_NODE) text += node.textContent || '';
      }
      return text.trim();
    }

    if (/^H[1-6]$/.test(element.tagName)) {
      return element.textContent?.trim() || '';
    }

    return '';
  }

  function shouldSkipElement(element: Element): boolean {
    if (element instanceof HTMLElement) {
      const style = window.getComputedStyle(element);
      if (style.display === 'none' || style.visibility === 'hidden') return true;
      if (element.hidden) return true;
    }
    if (element.getAttribute('aria-hidden') === 'true') return true;
    if (element.tagName === 'SCRIPT' || element.tagName === 'STYLE' || element.tagName === 'NOSCRIPT') return true;
    return false;
  }

  function hasInteractiveDescendants(element: Element): boolean {
    for (const tag of INTERACTIVE_TAGS) {
      if (element.querySelector(tag)) return true;
    }
    if (element.querySelector('[role]')) return true;
    if (element.querySelector('[tabindex]')) return true;
    return false;
  }

  function buildSelector(element: Element): string {
    if (jakesVibe?.computeSelector) {
      return jakesVibe.computeSelector(element);
    }
    // Simple fallback
    const tag = element.tagName.toLowerCase();
    if (element.id) return `#${CSS.escape(element.id)}`;
    const classes = Array.from(element.classList).slice(0, 2).map(c => `.${CSS.escape(c)}`).join('');
    return tag + classes;
  }

  function escapeText(text: string): string {
    return text.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r');
  }

  function truncateName(name: string): string {
    return name.length <= MAX_NAME_LENGTH ? name : name.slice(0, MAX_NAME_LENGTH - 3) + '...';
  }

  // Build tree
  const lines: string[] = [];

  function processNode(element: Element, depth: number): void {
    if (shouldSkipElement(element)) return;

    const role = getElementRole(element);
    const name = truncateName(getAccessibleName(element));
    const ref = assignRef(element);
    const selector = buildSelector(element);

    // Skip generic unnamed nodes but process children
    if (role === 'generic' && !name && !hasInteractiveDescendants(element)) {
      for (const child of element.children) {
        processNode(child, depth);
      }
      return;
    }

    const indent = '  '.repeat(depth);
    let line = `${indent}- ${role}`;

    if (name) {
      line += ` "${escapeText(name)}"`;
    }

    // State flags
    if (CHECKABLE_ROLES.includes(role)) {
      const checked = element.getAttribute('aria-checked');
      if (checked === 'mixed') line += ' [checked=mixed]';
      else if (checked === 'true' || (element as HTMLInputElement).checked) line += ' [checked]';
    }

    if (DISABLEABLE_ROLES.includes(role)) {
      if (element.getAttribute('aria-disabled') === 'true' || (element as HTMLInputElement).disabled) {
        line += ' [disabled]';
      }
    }

    if (EXPANDABLE_ROLES.includes(role)) {
      if (element.getAttribute('aria-expanded') === 'true') line += ' [expanded]';
    }

    if (SELECTABLE_ROLES.includes(role)) {
      if (element.getAttribute('aria-selected') === 'true') line += ' [selected]';
    }

    if (role === 'heading') {
      const ariaLevel = element.getAttribute('aria-level');
      const level = ariaLevel ? parseInt(ariaLevel, 10) : /^H([1-6])$/.test(element.tagName) ? parseInt(element.tagName[1], 10) : null;
      if (level) line += ` [level=${level}]`;
    }

    // Add ref with selector
    line += ` [${ref}|${selector}]`;

    lines.push(line);

    // Process children
    for (const child of element.children) {
      processNode(child, depth + 1);
    }
  }

  const rootElement = rootSelector ? document.querySelector(rootSelector) : document.body;
  if (!rootElement) {
    throw new Error(`Root element not found: ${rootSelector}`);
  }

  processNode(rootElement, 0);
  return lines.join('\n');
}

/**
 * Handle capture_screenshot tool.
 * Enhanced screenshot with ref support and full page option.
 */
async function handleBrowserScreenshot(
  tabId: number | null,
  payload: BrowserScreenshotRequest
): Promise<ScreenshotResponse> {
  if (!tabId) {
    throw new Error('No tab connected');
  }

  // If ref is provided, resolve it to element coordinates
  if (payload.ref) {
    const [result] = await chrome.scripting.executeScript({
      target: { tabId },
      func: (ref: string) => {
        const elementMap = (window as any).__ariaElementMap as Map<number, Element> | undefined;
        const currentGen = (window as any).__ariaCurrentGeneration as number | undefined;

        if (!elementMap) return null;

        const match = ref.match(/^s(\d+)e(\d+)$/);
        if (!match) return null;

        const [, genStr, idStr] = match;
        const generation = parseInt(genStr, 10);
        const elementId = parseInt(idStr, 10);

        if (currentGen !== generation) return null;

        const element = elementMap.get(elementId);
        if (!element) return null;

        const rect = element.getBoundingClientRect();
        const dpr = window.devicePixelRatio || 1;
        return {
          x: Math.round(rect.x * dpr),
          y: Math.round(rect.y * dpr),
          width: Math.round(rect.width * dpr),
          height: Math.round(rect.height * dpr),
        };
      },
      args: [payload.ref],
    });

    if (result?.result) {
      const dataUrl = await chrome.tabs.captureVisibleTab(undefined, { format: 'png' });
      const croppedImage = await cropImageToRect(dataUrl, result.result);
      return {
        image: croppedImage,
        width: result.result.width,
        height: result.result.height,
      };
    }
  }

  // Fall back to existing screenshot logic
  return handleScreenshot(tabId, {
    selector: payload.selector,
    fullPage: payload.fullPage,
  });
}

/**
 * Handle run_javascript tool.
 * Executes JavaScript in the page context.
 */
async function handleBrowserEvaluate(
  tabId: number | null,
  payload: BrowserEvaluateRequest
): Promise<BrowserEvaluateResponse> {
  if (!tabId) {
    throw new Error('No tab connected');
  }

  const [result] = await chrome.scripting.executeScript({
    target: { tabId },
    func: (code: string) => {
      try {
        // Use Function constructor for safer eval
        const fn = new Function(`return (${code})`);
        const value = fn();
        return { success: true, value };
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
    args: [payload.code],
  });

  if (!result?.result) {
    throw new Error('Failed to evaluate script');
  }

  if (!result.result.success) {
    return { result: null, error: result.result.error };
  }

  return { result: result.result.value };
}

/**
 * Handle get_console_logs tool.
 * Returns captured console logs.
 */
async function handleBrowserGetConsoleLogs(
  tabId: number | null,
  payload: BrowserGetConsoleLogsRequest
): Promise<BrowserConsoleLogsResponse> {
  if (!tabId) {
    throw new Error('No tab connected');
  }

  // Get logs from content script (injected listener)
  const [result] = await chrome.scripting.executeScript({
    target: { tabId },
    func: (types: string[] | undefined, clear: boolean | undefined) => {
      const logs = (window as any).__consoleLogs || [];
      let filtered = logs;

      if (types && types.length > 0) {
        filtered = logs.filter((l: any) => types.includes(l.type));
      }

      if (clear) {
        (window as any).__consoleLogs = [];
      }

      return filtered;
    },
    args: [payload.types ?? null, payload.clear ?? false],
  });

  return { logs: result?.result || [] };
}

/**
 * Handle navigate_to_url tool.
 */
async function handleBrowserNavigate(
  tabId: number | null,
  payload: BrowserNavigateRequest
): Promise<BrowserActionResponse> {
  if (!tabId) {
    throw new Error('No tab connected');
  }

  await chrome.tabs.update(tabId, { url: payload.url });
  return { success: true, message: `Navigated to ${payload.url}` };
}

/**
 * Handle go_back tool.
 */
async function handleBrowserGoBack(tabId: number | null): Promise<BrowserActionResponse> {
  if (!tabId) {
    throw new Error('No tab connected');
  }

  await chrome.tabs.goBack(tabId);
  return { success: true, message: 'Navigated back' };
}

/**
 * Handle go_forward tool.
 */
async function handleBrowserGoForward(tabId: number | null): Promise<BrowserActionResponse> {
  if (!tabId) {
    throw new Error('No tab connected');
  }

  await chrome.tabs.goForward(tabId);
  return { success: true, message: 'Navigated forward' };
}

/**
 * Handle reload_page tool.
 */
async function handleBrowserReload(tabId: number | null): Promise<BrowserActionResponse> {
  if (!tabId) {
    throw new Error('No tab connected');
  }

  await chrome.tabs.reload(tabId);
  return { success: true, message: 'Page reloaded' };
}

/**
 * Handle click_element tool.
 * Clicks an element by ref or selector.
 */
async function handleBrowserClick(
  tabId: number | null,
  payload: BrowserClickRequest
): Promise<BrowserActionResponse> {
  if (!tabId) {
    throw new Error('No tab connected');
  }

  // Get element coordinates
  const [result] = await chrome.scripting.executeScript({
    target: { tabId },
    func: (ref: string | undefined, selector: string | undefined) => {
      let element: Element | null = null;

      if (ref) {
        const elementMap = (window as any).__ariaElementMap as Map<number, Element> | undefined;
        const currentGen = (window as any).__ariaCurrentGeneration as number | undefined;

        if (elementMap) {
          const match = ref.match(/^s(\d+)e(\d+)$/);
          if (match) {
            const [, genStr, idStr] = match;
            const generation = parseInt(genStr, 10);
            const elementId = parseInt(idStr, 10);
            if (currentGen === generation) {
              element = elementMap.get(elementId) || null;
            }
          }
        }
      }

      if (!element && selector) {
        element = document.querySelector(selector);
      }

      if (!element) {
        return { error: 'Element not found' };
      }

      // Scroll into view and get center coordinates
      element.scrollIntoView({ behavior: 'instant', block: 'center', inline: 'center' });

      const rect = element.getBoundingClientRect();
      return {
        x: rect.left + rect.width / 2,
        y: rect.top + rect.height / 2,
      };
    },
    args: [payload.ref ?? null, payload.selector ?? null],
  });

  if (!result?.result || result.result.error) {
    throw new Error(result?.result?.error || 'Failed to locate element');
  }

  const { x, y } = result.result;

  // Try CDP click first, fall back to synthetic click
  try {
    await attachDebugger(tabId);
    await cdpClick(tabId, x, y, payload.button || 'left', payload.clickCount || 1);
    return { success: true, message: `Clicked at (${Math.round(x)}, ${Math.round(y)})` };
  } catch {
    // Fall back to synthetic click
    await chrome.scripting.executeScript({
      target: { tabId },
      func: (ref: string | null, selector: string | null, button: string, clickCount: number) => {
        let element: Element | null = null;

        if (ref) {
          const elementMap = (window as any).__ariaElementMap as Map<number, Element> | undefined;
          const currentGen = (window as any).__ariaCurrentGeneration as number | undefined;
          if (elementMap) {
            const match = ref.match(/^s(\d+)e(\d+)$/);
            if (match) {
              const [, genStr, idStr] = match;
              const generation = parseInt(genStr, 10);
              const elementId = parseInt(idStr, 10);
              if (currentGen === generation) {
                element = elementMap.get(elementId) || null;
              }
            }
          }
        }

        if (!element && selector) {
          element = document.querySelector(selector);
        }

        if (element instanceof HTMLElement) {
          for (let i = 0; i < clickCount; i++) {
            element.click();
          }
        }
      },
      args: [payload.ref ?? null, payload.selector ?? null, payload.button || 'left', payload.clickCount || 1],
    });

    return { success: true, message: 'Clicked element (synthetic)' };
  }
}

/**
 * Handle type_into_element tool.
 * Types text into an input element.
 */
async function handleBrowserType(
  tabId: number | null,
  payload: BrowserTypeRequest
): Promise<BrowserActionResponse> {
  if (!tabId) {
    throw new Error('No tab connected');
  }

  // Focus the element and optionally clear it
  await chrome.scripting.executeScript({
    target: { tabId },
    func: (ref: string | undefined, selector: string | undefined, clear: boolean) => {
      let element: Element | null = null;

      if (ref) {
        const elementMap = (window as any).__ariaElementMap as Map<number, Element> | undefined;
        const currentGen = (window as any).__ariaCurrentGeneration as number | undefined;
        if (elementMap) {
          const match = ref.match(/^s(\d+)e(\d+)$/);
          if (match) {
            const [, genStr, idStr] = match;
            const generation = parseInt(genStr, 10);
            const elementId = parseInt(idStr, 10);
            if (currentGen === generation) {
              element = elementMap.get(elementId) || null;
            }
          }
        }
      }

      if (!element && selector) {
        element = document.querySelector(selector);
      }

      if (element instanceof HTMLElement) {
        element.focus();
        if (clear && (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement)) {
          element.value = '';
          element.dispatchEvent(new Event('input', { bubbles: true }));
        }
      }
    },
    args: [payload.ref ?? null, payload.selector ?? null, payload.clear ?? false],
  });

  // Type using CDP if possible, otherwise synthetic input
  try {
    await attachDebugger(tabId);
    await cdpType(tabId, payload.text);
    return { success: true, message: `Typed "${payload.text.slice(0, 20)}${payload.text.length > 20 ? '...' : ''}"` };
  } catch {
    // Fall back to direct value setting
    await chrome.scripting.executeScript({
      target: { tabId },
      func: (ref: string | null, selector: string | null, text: string) => {
        let element: Element | null = null;

        if (ref) {
          const elementMap = (window as any).__ariaElementMap as Map<number, Element> | undefined;
          const currentGen = (window as any).__ariaCurrentGeneration as number | undefined;
          if (elementMap) {
            const match = ref.match(/^s(\d+)e(\d+)$/);
            if (match) {
              const [, genStr, idStr] = match;
              const generation = parseInt(genStr, 10);
              const elementId = parseInt(idStr, 10);
              if (currentGen === generation) {
                element = elementMap.get(elementId) || null;
              }
            }
          }
        }

        if (!element && selector) {
          element = document.querySelector(selector);
        }

        if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
          element.value += text;
          element.dispatchEvent(new Event('input', { bubbles: true }));
          element.dispatchEvent(new Event('change', { bubbles: true }));
        }
      },
      args: [payload.ref ?? null, payload.selector ?? null, payload.text],
    });

    return { success: true, message: 'Typed text (synthetic)' };
  }
}

/**
 * Handle select_dropdown_option tool.
 * Selects an option in a <select> element.
 */
async function handleBrowserSelectOption(
  tabId: number | null,
  payload: BrowserSelectOptionRequest
): Promise<BrowserActionResponse> {
  if (!tabId) {
    throw new Error('No tab connected');
  }

  const [result] = await chrome.scripting.executeScript({
    target: { tabId },
    func: (ref: string | undefined, selector: string | undefined, value: string | undefined, label: string | undefined, index: number | undefined) => {
      let element: Element | null = null;

      if (ref) {
        const elementMap = (window as any).__ariaElementMap as Map<number, Element> | undefined;
        const currentGen = (window as any).__ariaCurrentGeneration as number | undefined;
        if (elementMap) {
          const match = ref.match(/^s(\d+)e(\d+)$/);
          if (match) {
            const [, genStr, idStr] = match;
            const generation = parseInt(genStr, 10);
            const elementId = parseInt(idStr, 10);
            if (currentGen === generation) {
              element = elementMap.get(elementId) || null;
            }
          }
        }
      }

      if (!element && selector) {
        element = document.querySelector(selector);
      }

      if (!(element instanceof HTMLSelectElement)) {
        return { error: 'Element is not a select' };
      }

      const selectEl = element;
      let selectedOption: HTMLOptionElement | null = null;

      if (value !== undefined) {
        selectedOption = Array.from(selectEl.options).find(o => o.value === value) || null;
      } else if (label !== undefined) {
        selectedOption = Array.from(selectEl.options).find(o => o.text === label || o.label === label) || null;
      } else if (index !== undefined) {
        selectedOption = selectEl.options[index] || null;
      }

      if (!selectedOption) {
        return { error: 'Option not found' };
      }

      selectEl.value = selectedOption.value;
      selectEl.dispatchEvent(new Event('change', { bubbles: true }));

      return { success: true, selectedValue: selectedOption.value, selectedLabel: selectedOption.text };
    },
    args: [payload.ref ?? null, payload.selector ?? null, payload.value ?? null, payload.label ?? null, payload.index ?? null],
  });

  if (!result?.result || result.result.error) {
    throw new Error(result?.result?.error || 'Failed to select option');
  }

  return { success: true, message: `Selected option: ${result.result.selectedLabel}` };
}

/**
 * Handle wait_for_element tool.
 * Waits until a CSS selector matches an element on the page.
 * Uses MutationObserver + immediate check for reliability.
 */
async function handleWaitForElement(
  tabId: number | null,
  payload: WaitForElementRequest
): Promise<WaitForElementResponse> {
  if (!tabId) throw new Error('No tab connected');

  const timeout = Math.min(payload.timeout ?? 5000, 30000);

  const [result] = await chrome.scripting.executeScript({
    target: { tabId },
    func: (selector: string, timeoutMs: number) => {
      return new Promise<{ found: boolean; selector: string; elapsed: number }>((resolve, reject) => {
        const start = Date.now();

        // Check immediately
        if (document.querySelector(selector)) {
          return resolve({ found: true, selector, elapsed: 0 });
        }

        // Set up observer
        const observer = new MutationObserver(() => {
          if (document.querySelector(selector)) {
            observer.disconnect();
            resolve({ found: true, selector, elapsed: Date.now() - start });
          }
        });

        observer.observe(document.body, { childList: true, subtree: true });

        // Timeout fallback
        setTimeout(() => {
          observer.disconnect();
          reject(new Error(`Timeout: element "${selector}" not found within ${timeoutMs}ms`));
        }, timeoutMs);
      });
    },
    args: [payload.selector, timeout],
  });

  if (!result?.result) throw new Error('Failed to wait for element');
  return result.result as WaitForElementResponse;
}
