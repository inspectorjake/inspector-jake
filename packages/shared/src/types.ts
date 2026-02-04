/**
 * Shared types for InspectorJake MCP server and Chrome extension communication.
 */

import type { SessionName } from './names.js';

// Element info returned from DevTools selection
export interface ElementInfo {
  tagName: string;
  id: string | null;
  className: string | null;
  selector: string;
  innerText: string | null;
  attributes: Array<{ name: string; value: string }>;
  rect: {
    x: number;
    y: number;
    width: number;
    height: number;
    top: number;
    right: number;
    bottom: number;
    left: number;
  };
}

// Page info
export interface PageInfo {
  url: string;
  title: string;
  viewport: {
    width: number;
    height: number;
  };
}

// Screenshot result
export interface ScreenshotResult {
  image: string; // data:image/png;base64,...
  width: number;
  height: number;
}

// =============================================================================
// Unified Selections System
// =============================================================================

// Base selection properties shared by all selection types
interface BaseSelection {
  id: string;
  timestamp: number;
  image: string; // data:image/png;base64,...
  width: number;
  height: number;
}

// Element selection - CSS selector + element metadata
export interface ElementSelection extends BaseSelection {
  type: 'element';
  selector: string;
  tagName: string;
  className: string | null;
  rect: { x: number; y: number; width: number; height: number };
  attributes: Array<{ name: string; value: string }>;
}

// Screenshot selection - just a region capture
export interface ScreenshotSelection extends BaseSelection {
  type: 'screenshot';
  rect: { x: number; y: number; width: number; height: number };
}

// Discriminated union of all selection types
export type Selection = ElementSelection | ScreenshotSelection;

// Tool request types
export interface ScreenshotRequest {
  selector?: string;
  fullPage?: boolean;
}

export interface GetPageInfoRequest {
  selector?: string;
}

// Tool response types
export interface ScreenshotResponse extends ScreenshotResult {}

export interface GetPageInfoResponse extends PageInfo {}

// WebSocket message types (MCP Server <-> Extension)
export type ToolType =
  | 'get_user_selections'
  | 'view_user_selection_image'
  | 'get_page_info'
  | 'get_session_info'
  | 'capture_screenshot'
  | 'run_javascript'
  | 'get_console_logs'
  | 'navigate_to_url'
  | 'go_back'
  | 'go_forward'
  | 'reload_page'
  | 'click_element'
  | 'type_into_element'
  | 'select_dropdown_option'
  | 'wait_for_element';

// Request types for new tools
export interface GetSelectionsRequest {}

export interface ViewImageRequest {
  imageId: string;
}

// Response types for new tools
export interface GetSelectionsResponse {
  selections: Array<{
    type: 'element' | 'screenshot';
    id: string;
    image?: string;
    selector?: string;
    tagName?: string;
    className?: string;
    dimensions: string;
    rect: { x: number; y: number; width: number; height: number };
    hint?: string;
  }>;
}

export interface ViewImageResponse {
  image?: string;
  width?: number;
  height?: number;
  error?: string;
}

export interface WaitForElementRequest {
  selector: string;
  timeout?: number;
}

export interface WaitForElementResponse {
  found: boolean;
  selector: string;
  elapsed: number;
}

export interface ToolRequest {
  id: string;
  type: ToolType;
  payload: ScreenshotRequest | GetPageInfoRequest | GetSelectionsRequest | ViewImageRequest | BrowserScreenshotRequest | BrowserClickRequest | BrowserTypeRequest | BrowserSelectOptionRequest | BrowserNavigateRequest | BrowserEvaluateRequest | BrowserGetConsoleLogsRequest | WaitForElementRequest;
}

export interface ToolResponse {
  id: string;
  success: boolean;
  result?: ScreenshotResponse | GetPageInfoResponse | GetSelectionsResponse | ViewImageResponse | InteractiveContextResponse | BrowserActionResponse | BrowserEvaluateResponse | BrowserConsoleLogsResponse | WaitForElementResponse;
  error?: string;
}

// Discovery response (for port scanning)
export interface DiscoveryResponse {
  name: SessionName;
  status: 'ready' | 'connected';
  connectedTab?: {
    id: number;
    title: string;
    url: string;
  };
}

// Extension -> Background script messages
export interface DevToolsElementSelectedMessage {
  type: 'DEVTOOLS_ELEMENT_SELECTED';
  element: ElementInfo | null;
  tabId: number;
}

export interface ExtensionConnectionMessage {
  type: 'EXTENSION_CONNECT';
  tabId: number;
}

export interface ExtensionDisconnectionMessage {
  type: 'EXTENSION_DISCONNECT';
  tabId: number;
}

export type ExtensionMessage =
  | DevToolsElementSelectedMessage
  | ExtensionConnectionMessage
  | ExtensionDisconnectionMessage;

// =============================================================================
// ARIA Tree Types (for get_page_info tool)
// =============================================================================

/**
 * A node in the ARIA accessibility tree.
 * Represents an element with its role, name, states, and children.
 */
export interface AriaNode {
  /** ARIA role (explicit or implicit) */
  role: string;
  /** Accessible name (from aria-label, text content, etc.) */
  name: string;
  /** Element reference (format: s{generation}e{index}) */
  ref: string;
  /** Child nodes (can be AriaNode or text string) */
  children: (AriaNode | string)[];
  /** Additional properties (e.g., url for links) */
  props: Record<string, unknown>;
  /** Checked state for checkable roles */
  checked?: boolean | 'mixed';
  /** Disabled state */
  disabled?: boolean;
  /** Expanded state for expandable roles */
  expanded?: boolean;
  /** Selected state for selectable roles */
  selected?: boolean;
  /** Level for headings and tree items */
  level?: number;
}

/**
 * A complete accessibility snapshot of the page.
 * Contains the tree structure and element references.
 */
export interface Snapshot {
  /** Generation counter (increments with each snapshot) */
  generation: number;
  /** Map of element index to DOM element */
  elements: Map<number, Element>;
  /** Root of the ARIA tree */
  root: AriaNode;
  /** Timestamp when snapshot was created */
  timestamp: number;
}

/**
 * Response from get_page_info tool (merged page info + interactive context).
 */
export interface InteractiveContextResponse {
  /** Page URL */
  url: string;
  /** Page title */
  title: string;
  /** Viewport dimensions */
  viewport: { width: number; height: number };
  /** Formatted ARIA tree as text */
  snapshot: string;
}

// =============================================================================
// Browser Automation Request/Response Types
// =============================================================================

export interface BrowserClickRequest {
  ref?: string;
  selector?: string;
  button?: 'left' | 'right' | 'middle';
  clickCount?: number;
}

export interface BrowserTypeRequest {
  ref?: string;
  selector?: string;
  text: string;
  clear?: boolean;
}

export interface BrowserSelectOptionRequest {
  ref?: string;
  selector?: string;
  value?: string;
  label?: string;
  index?: number;
}

export interface BrowserNavigateRequest {
  url: string;
}

export interface BrowserEvaluateRequest {
  code: string;
}

export interface BrowserScreenshotRequest {
  ref?: string;
  selector?: string;
  fullPage?: boolean;
  quality?: number;
}

export interface BrowserGetConsoleLogsRequest {
  types?: ('log' | 'warn' | 'error' | 'info' | 'debug' | 'trace' | 'assert' | 'exception' | 'unhandledrejection')[];
  clear?: boolean;
}

export interface BrowserActionResponse {
  success: boolean;
  message?: string;
  error?: string;
}

export interface BrowserEvaluateResponse {
  result: unknown;
  error?: string;
}

export interface BrowserConsoleLogsResponse {
  logs: Array<{
    type: string;
    message: string;
    timestamp: number;
  }>;
}
