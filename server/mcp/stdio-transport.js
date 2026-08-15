import { TOOLS } from './tool-catalog.js';
import { callTool } from './tool-dispatch.js';

function asTextContent(value) {
  if (typeof value === 'string') return value;
  return JSON.stringify(value, null, 2);
}

function send(payload) {
  const body = JSON.stringify(payload);
  const header = `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n`;
  process.stdout.write(header + body);
}

function sendResponse(id, result) {
  send({ jsonrpc: '2.0', id, result });
}

function sendError(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

async function handleMessage(message) {
  const { id, method, params = {} } = message || {};

  if (method === 'initialize') {
    sendResponse(id, {
      protocolVersion: '2024-11-05',
      capabilities: {
        tools: {}
      },
      serverInfo: {
        name: 'driftstone-mcp',
        version: '0.1.0'
      }
    });
    return;
  }

  if (method === 'notifications/initialized') {
    return;
  }

  if (method === 'tools/list') {
    sendResponse(id, { tools: TOOLS });
    return;
  }

  if (method === 'tools/call') {
    try {
      const result = await callTool(params?.name, params?.arguments || {});
      sendResponse(id, {
        content: [
          {
            type: 'text',
            text: asTextContent(result)
          }
        ],
        structuredContent: result,
        isError: false
      });
    } catch (error) {
      sendResponse(id, {
        content: [
          {
            type: 'text',
            text: error instanceof Error ? error.message : String(error)
          }
        ],
        isError: true
      });
    }
    return;
  }

  sendError(id, -32601, `Method not found: ${method}`);
}

export function startStdioTransport() {
  let buffer = Buffer.alloc(0);

  process.stdin.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);

    while (true) {
      const headerEnd = buffer.indexOf(Buffer.from('\r\n\r\n'));
      if (headerEnd === -1) break;

      const header = buffer.slice(0, headerEnd).toString('utf8');
      const match = header.match(/Content-Length:\s*(\d+)/i);
      if (!match) {
        buffer = buffer.slice(headerEnd + 4);
        continue;
      }

      const contentLength = Number(match[1]);
      const bodyStart = headerEnd + 4;
      if (buffer.length < bodyStart + contentLength) break;

      const body = buffer.slice(bodyStart, bodyStart + contentLength).toString('utf8');
      buffer = buffer.slice(bodyStart + contentLength);

      try {
        handleMessage(JSON.parse(body));
      } catch {
        sendError(null, -32700, 'Parse error');
      }
    }
  });
}
