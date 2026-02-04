/**
 * MCP Server implementation for Inspector Jake.
 * Registers inspection tools and communicates with Chrome extension via WebSocket.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import type { WsServerInstance } from './ws-server.js';
import { log } from './logger.js';
import {
  errorResponse,
  jsonResponse,
  imageResponse,
  renderSelections,
  type SelectionData,
} from './response-builder.js';

export interface SessionInfo {
  sessionName: string;
  port: number;
}

const TOOLS = [
  {
    name: 'get_user_selections',
    description:
      'Get all user selections from the DevTools panel. Returns an array of selections - either element selections (with selector metadata, use view_user_selection_image to see the screenshot) or screenshot selections (with full image data inline).',
    inputSchema: {
      type: 'object' as const,
      properties: {},
      required: [],
    },
  },
  {
    name: 'view_user_selection_image',
    description:
      'View a stored user selection image by its ID. Use this when you need to see element screenshots. Call get_user_selections first to get available image IDs.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        imageId: {
          type: 'string',
          description: 'The image ID from get_user_selections response',
        },
      },
      required: ['imageId'],
    },
  },
  {
    name: 'get_page_info',
    description:
      'Get comprehensive information about the current page including URL, title, viewport dimensions, and a full ARIA accessibility tree with interactive element refs. Each element has a ref (e.g., "s1e42") that can be used with click_element, type_into_element, and other interaction tools. Optionally scope the tree to a subtree with a CSS selector.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        selector: {
          type: 'string',
          description: 'CSS selector to scope the tree to a subtree. If omitted, captures the full page.',
        },
      },
      required: [],
    },
  },
  {
    name: 'get_session_info',
    description:
      'Get information about the current MCP session including session name, port, and browser connection status.',
    inputSchema: {
      type: 'object' as const,
      properties: {},
      required: [],
    },
  },
  {
    name: 'capture_screenshot',
    description:
      'Capture a screenshot of the page or a specific element. Supports targeting by element ref (from get_page_info), CSS selector, or full page capture.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        ref: {
          type: 'string',
          description: 'Element ref from get_page_info (e.g., "s1e42")',
        },
        selector: {
          type: 'string',
          description: 'CSS selector of element to screenshot',
        },
        fullPage: {
          type: 'boolean',
          description: 'If true, captures the entire scrollable page',
        },
        quality: {
          type: 'number',
          description: 'JPEG quality (0-100). Only used for JPEG format.',
        },
      },
      required: [],
    },
  },
  {
    name: 'run_javascript',
    description:
      'Execute JavaScript code in the page context. Returns the evaluation result.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        code: {
          type: 'string',
          description: 'JavaScript expression to evaluate',
        },
      },
      required: ['code'],
    },
  },
  {
    name: 'get_console_logs',
    description:
      'Get all console output and uncaught errors from the page. Captures console.log, warn, error, info, debug, trace, assert failures, uncaught exceptions, and unhandled promise rejections.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        types: {
          type: 'array',
          items: { type: 'string' },
          description: 'Filter by log types: log, warn, error, info, debug, trace, assert, exception, unhandledrejection',
        },
        clear: {
          type: 'boolean',
          description: 'If true, clears logs after retrieving',
        },
      },
      required: [],
    },
  },
  {
    name: 'navigate_to_url',
    description:
      'Navigate the browser to a URL.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        url: {
          type: 'string',
          description: 'The URL to navigate to',
        },
      },
      required: ['url'],
    },
  },
  {
    name: 'go_back',
    description:
      'Navigate back in browser history.',
    inputSchema: {
      type: 'object' as const,
      properties: {},
      required: [],
    },
  },
  {
    name: 'go_forward',
    description:
      'Navigate forward in browser history.',
    inputSchema: {
      type: 'object' as const,
      properties: {},
      required: [],
    },
  },
  {
    name: 'reload_page',
    description:
      'Reload the current page.',
    inputSchema: {
      type: 'object' as const,
      properties: {},
      required: [],
    },
  },
  {
    name: 'click_element',
    description:
      'Click an element by ref (from get_page_info) or CSS selector.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        ref: {
          type: 'string',
          description: 'Element ref from get_page_info (e.g., "s1e42")',
        },
        selector: {
          type: 'string',
          description: 'CSS selector of element to click',
        },
        button: {
          type: 'string',
          enum: ['left', 'right', 'middle'],
          description: 'Mouse button to use. Default: left',
        },
        clickCount: {
          type: 'number',
          description: 'Number of clicks. Use 2 for double-click. Default: 1',
        },
      },
      required: [],
    },
  },
  {
    name: 'type_into_element',
    description:
      'Type text into an input element by ref (from get_page_info) or CSS selector.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        ref: {
          type: 'string',
          description: 'Element ref from get_page_info (e.g., "s1e42")',
        },
        selector: {
          type: 'string',
          description: 'CSS selector of input element',
        },
        text: {
          type: 'string',
          description: 'Text to type',
        },
        clear: {
          type: 'boolean',
          description: 'If true, clears existing text before typing',
        },
      },
      required: ['text'],
    },
  },
  {
    name: 'select_dropdown_option',
    description:
      'Select an option from a <select> dropdown by ref (from get_page_info) or selector.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        ref: {
          type: 'string',
          description: 'Element ref from get_page_info (e.g., "s1e42")',
        },
        selector: {
          type: 'string',
          description: 'CSS selector of select element',
        },
        value: {
          type: 'string',
          description: 'Option value to select',
        },
        label: {
          type: 'string',
          description: 'Option label/text to select',
        },
        index: {
          type: 'number',
          description: 'Option index to select (0-based)',
        },
      },
      required: [],
    },
  },
  {
    name: 'wait_for_element',
    description:
      'Wait until an element matching a CSS selector appears on the page. Returns when found or throws on timeout.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        selector: {
          type: 'string',
          description: 'CSS selector to wait for',
        },
        timeout: {
          type: 'number',
          description: 'Maximum wait time in milliseconds (default: 5000, max: 30000)',
        },
      },
      required: ['selector'],
    },
  },
];

export async function createMcpServer(
  wsServer: WsServerInstance,
  sessionInfo: SessionInfo
): Promise<void> {
  const server = new Server(
    {
      name: 'vibejake',
      version: '1.0.0',
    },
    {
      capabilities: {
        tools: {},
      },
      instructions: `Inspector Jake MCP Server

Session Name: ${sessionInfo.sessionName}
Port: ${sessionInfo.port}

To use this server:
1. Open Chrome DevTools on any webpage
2. Go to the "Inspector Jake" tab
3. Click "Refresh" to scan for sessions
4. Connect to session "${sessionInfo.sessionName}"

Once connected, use the inspector tools to interact with the page.`,
    }
  );

  // Handle list tools request
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return { tools: TOOLS };
  });

  // Handle tool calls
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    switch (name) {
      case 'get_user_selections': {
        const response = await wsServer.sendToolRequest(
          'get_user_selections',
          {}
        );

        if (!response.success) {
          return errorResponse(response.error || 'Unknown error');
        }

        const result = response.result as { selections: SelectionData[] };

        if (!result.selections?.length) {
          return jsonResponse({
            message: 'No selections. Use the DevTools panel to click on elements or drag to capture regions.',
          });
        }

        const content = renderSelections(result.selections);
        return { content };
      }

      case 'view_user_selection_image': {
        const imageId = args?.imageId as string;
        if (!imageId) {
          return errorResponse('imageId is required');
        }

        const response = await wsServer.sendToolRequest(
          'view_user_selection_image',
          { imageId }
        );

        if (!response.success) {
          return errorResponse(response.error || 'Unknown error');
        }

        const result = response.result as { image?: string; width?: number; height?: number; error?: string };

        if (result.error) {
          return errorResponse(result.error);
        }

        return imageResponse(
          result.image!,
          `Image [${imageId}]: ${result.width}x${result.height}`
        );
      }

      case 'get_page_info': {
        const response = await wsServer.sendToolRequest('get_page_info', {
          selector: args?.selector as string | undefined,
        });

        if (!response.success) {
          return errorResponse(response.error || 'Unknown error');
        }

        const result = response.result as {
          url: string;
          title: string;
          viewport: { width: number; height: number };
          snapshot: string;
        };

        return {
          content: [
            {
              type: 'text',
              text: `Page: ${result.title}\nURL: ${result.url}\nViewport: ${result.viewport.width}x${result.viewport.height}\n\n${result.snapshot}`,
            },
          ],
        };
      }

      case 'get_session_info': {
        const discoveryInfo = wsServer.getDiscoveryInfo();
        return jsonResponse({
          sessionName: sessionInfo.sessionName,
          port: sessionInfo.port,
          browserConnected: discoveryInfo.status === 'connected',
          connectedTab: discoveryInfo.connectedTab || null,
        });
      }

      case 'capture_screenshot': {
        const response = await wsServer.sendToolRequest('capture_screenshot', {
          ref: args?.ref as string | undefined,
          selector: args?.selector as string | undefined,
          fullPage: args?.fullPage as boolean | undefined,
          quality: args?.quality as number | undefined,
        });

        if (!response.success) {
          return errorResponse(response.error || 'Unknown error');
        }

        const result = response.result as { image: string; width: number; height: number };
        return imageResponse(result.image, `Screenshot: ${result.width}x${result.height}`);
      }

      case 'run_javascript': {
        const code = args?.code as string;
        if (!code) {
          return errorResponse('code is required');
        }

        const response = await wsServer.sendToolRequest('run_javascript', { code });

        if (!response.success) {
          return errorResponse(response.error || 'Unknown error');
        }

        const result = response.result as { result: unknown; error?: string };
        if (result.error) {
          return errorResponse(`Evaluation error: ${result.error}`);
        }

        return jsonResponse({ result: result.result });
      }

      case 'get_console_logs': {
        const response = await wsServer.sendToolRequest('get_console_logs', {
          types: args?.types as string[] | undefined,
          clear: args?.clear as boolean | undefined,
        });

        if (!response.success) {
          return errorResponse(response.error || 'Unknown error');
        }

        return jsonResponse(response.result);
      }

      case 'navigate_to_url': {
        const url = args?.url as string;
        if (!url) {
          return errorResponse('url is required');
        }

        const response = await wsServer.sendToolRequest('navigate_to_url', { url });

        if (!response.success) {
          return errorResponse(response.error || 'Unknown error');
        }

        return jsonResponse(response.result);
      }

      case 'go_back': {
        const response = await wsServer.sendToolRequest('go_back', {});

        if (!response.success) {
          return errorResponse(response.error || 'Unknown error');
        }

        return jsonResponse(response.result);
      }

      case 'go_forward': {
        const response = await wsServer.sendToolRequest('go_forward', {});

        if (!response.success) {
          return errorResponse(response.error || 'Unknown error');
        }

        return jsonResponse(response.result);
      }

      case 'reload_page': {
        const response = await wsServer.sendToolRequest('reload_page', {});

        if (!response.success) {
          return errorResponse(response.error || 'Unknown error');
        }

        return jsonResponse(response.result);
      }

      case 'click_element': {
        const response = await wsServer.sendToolRequest('click_element', {
          ref: args?.ref as string | undefined,
          selector: args?.selector as string | undefined,
          button: args?.button as string | undefined,
          clickCount: args?.clickCount as number | undefined,
        });

        if (!response.success) {
          return errorResponse(response.error || 'Unknown error');
        }

        return jsonResponse(response.result);
      }

      case 'type_into_element': {
        const text = args?.text as string;
        if (!text) {
          return errorResponse('text is required');
        }

        const response = await wsServer.sendToolRequest('type_into_element', {
          ref: args?.ref as string | undefined,
          selector: args?.selector as string | undefined,
          text,
          clear: args?.clear as boolean | undefined,
        });

        if (!response.success) {
          return errorResponse(response.error || 'Unknown error');
        }

        return jsonResponse(response.result);
      }

      case 'select_dropdown_option': {
        const response = await wsServer.sendToolRequest('select_dropdown_option', {
          ref: args?.ref as string | undefined,
          selector: args?.selector as string | undefined,
          value: args?.value as string | undefined,
          label: args?.label as string | undefined,
          index: args?.index as number | undefined,
        });

        if (!response.success) {
          return errorResponse(response.error || 'Unknown error');
        }

        return jsonResponse(response.result);
      }

      case 'wait_for_element': {
        const selector = args?.selector as string;
        if (!selector) {
          return errorResponse('selector is required');
        }

        const response = await wsServer.sendToolRequest('wait_for_element', {
          selector,
          timeout: args?.timeout as number | undefined,
        });

        if (!response.success) {
          return errorResponse(response.error || 'Unknown error');
        }

        return jsonResponse(response.result);
      }

      default:
        return errorResponse(`Unknown tool: ${name}`);
    }
  });

  // Connect via stdio transport
  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Keep the server running
  log.info('MCP', 'MCP server started. Listening for tool calls via stdio.');
}
