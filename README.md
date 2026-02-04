<img src="packages/chrome-extension/icons/logo.svg" alt="Inspector Jake" width="128" height="128">

# Inspector Jake

Let AI agents inspect and interact with web pages through Chrome DevTools.

[![npm version](https://badge.fury.io/js/inspector-jake-mcp.svg)](https://www.npmjs.com/package/inspector-jake-mcp)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

## What is Inspector Jake?

Inspector Jake is an MCP (Model Context Protocol) server that connects AI assistants like Claude to Chrome DevTools. Agents can inspect page structure via ARIA trees, capture screenshots, read console logs, and interact with elements through clicks, typing, and navigation.

## Architecture

```
┌─────────────────┐                    ┌─────────────────────┐
│   AI Agent      │───MCP Protocol────▶│   MCP Server        │
│ (Claude, etc)   │                    │   inspector-jake    │
└─────────────────┘                    └──────────┬──────────┘
                                                  │ WebSocket
                                                  ▼
                                       ┌─────────────────────┐
                                       │  Chrome Extension   │
                                       │  (connected tab)    │
                                       └──────────┬──────────┘
                                                  │
                                                  ▼
                                       ┌─────────────────────┐
                                       │  DevTools Panel     │
                                       │  (element tracking) │
                                       └─────────────────────┘
```

## Quick Start

### 1. Install the MCP Server

```bash
npx inspector-jake-mcp
```

### 2. Configure Claude Desktop

Add to your Claude Desktop config (`~/.config/claude/claude_desktop_config.json` on macOS/Linux):

```json
{
  "mcpServers": {
    "inspector-jake": {
      "command": "npx",
      "args": ["inspector-jake-mcp"]
    }
  }
}
```

### 3. Load the Chrome Extension

1. Open Chrome and go to `chrome://extensions/`
2. Enable "Developer mode" (toggle in top right)
3. Click "Load unpacked"
4. Select the `packages/chrome-extension/dist` folder

### 4. Connect

1. Navigate to any webpage
2. Open DevTools (F12)
3. Click the "Jake" tab
4. Click "Connect" to your MCP session

## MCP Tools (15)

### Inspection

| Tool | Description |
|------|-------------|
| `get_page_info` | Page URL, title, viewport, and full ARIA accessibility tree with element refs |
| `get_session_info` | MCP session name, port, and browser connection status |
| `get_user_selections` | All user-pinned selections from the DevTools panel |
| `view_user_selection_image` | View a stored selection image by its ID |
| `capture_screenshot` | Screenshot by element ref, CSS selector, or full page |
| `get_console_logs` | Console output and uncaught errors (log, warn, error, info, debug, trace, assert, exceptions) |
| `run_javascript` | Execute JavaScript in the page context |

### Interaction

| Tool | Description |
|------|-------------|
| `click_element` | Click an element by ref or CSS selector |
| `type_into_element` | Type text into an input by ref or CSS selector |
| `select_dropdown_option` | Select an option from a `<select>` dropdown |
| `wait_for_element` | Wait until a CSS selector matches an element on the page |

### Navigation

| Tool | Description |
|------|-------------|
| `navigate_to_url` | Navigate the browser to a URL |
| `go_back` | Navigate back in browser history |
| `go_forward` | Navigate forward in browser history |
| `reload_page` | Reload the current page |

## Tool Examples

### get_page_info

Returns page metadata and an ARIA tree with interactive element refs (e.g., `s1e42`) that can be used with `click_element`, `type_into_element`, and other interaction tools.

**Response:**
```
Page: Example Page
URL: https://example.com
Viewport: 1920x1080

- navigation [s1e1|nav]
  - link "Home" [s1e2|a.nav-link]
  - link "About" [s1e3|a.nav-link:nth-of-type(2)]
- main [s1e4|main]
  - heading "Welcome" [level=1] [s1e5|h1]
  - textbox "Search" [s1e6|input#search]
  - button "Submit" [s1e7|button.btn]
```

### capture_screenshot

**Request:**
```json
{
  "selector": "#submit-btn"
}
```

Returns a base64-encoded PNG image of the matched element.

### click_element

**Request (by ref from get_page_info):**
```json
{
  "ref": "s1e7"
}
```

**Request (by CSS selector):**
```json
{
  "selector": "#submit-btn",
  "clickCount": 2
}
```

### get_console_logs

**Request:**
```json
{
  "types": ["error", "warn"],
  "clear": true
}
```

**Response:**
```json
{
  "logs": [
    {"type": "error", "message": "Uncaught TypeError: x is not a function", "timestamp": 1700000000000},
    {"type": "warn", "message": "Deprecated API usage", "timestamp": 1700000001000}
  ]
}
```

## Session Discovery

The extension discovers MCP servers using predefined session names, each mapping to a unique port. When the MCP server starts, it picks an available name and listens on its corresponding port. The extension scans ports to find active servers.

## Development

### Prerequisites

- Node.js 18+
- npm 9+
- Chrome browser

### Setup

```bash
git clone https://github.com/inspectorjake/inspector-jake.git
cd inspector-jake
npm install
npm run build
npm test
```

### Project Structure

```
inspector-jake/
├── packages/
│   ├── mcp-server/          # MCP server (npm package)
│   │   ├── src/
│   │   │   ├── index.ts           # CLI entry
│   │   │   ├── server.ts          # MCP server + tools
│   │   │   ├── ws-server.ts       # WebSocket for extension
│   │   │   └── response-builder.ts # Response formatting utilities
│   │   └── package.json
│   │
│   ├── chrome-extension/    # Chrome extension (Manifest V3)
│   │   ├── src/
│   │   │   ├── background/  # Service worker
│   │   │   ├── content/     # Content script
│   │   │   ├── devtools/    # DevTools panel
│   │   │   └── popup/       # Extension popup (Vue)
│   │   ├── manifest.json
│   │   └── package.json
│   │
│   └── shared/              # Shared types and utilities
│       └── package.json
│
└── package.json             # Workspace root
```

### Watch Mode

```bash
# In separate terminals:
cd packages/shared && npm run dev
cd packages/mcp-server && npm run dev
cd packages/chrome-extension && npm run dev
```

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development guidelines.

## Security

See [SECURITY.md](SECURITY.md) for security policy.

## License

MIT - see [LICENSE](LICENSE)
