import { tools } from "./tools";

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: unknown;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

type FrameStyle = "content-length" | "json-line";

export function createServer() {
  return new McpServer();
}

class McpServer {
  async run() {
    let buffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);

    for await (const chunk of process.stdin) {
      buffer = Buffer.concat([buffer, Buffer.from(chunk)]);

      while (true) {
        const frame = readFrame(buffer);
        if (!frame) break;
        buffer = frame.rest;
        await this.handleMessage(frame.body, frame.style);
      }
    }
  }

  private async handleMessage(body: string, style: FrameStyle) {
    const request = parseRequest(body);
    if (!request) return;

    if (request.id === undefined) {
      await this.handleNotification(request);
      return;
    }

    const response = await this.dispatch(request);
    writeMessage(response, style);
  }

  private async handleNotification(_request: JsonRpcRequest) {
    return;
  }

  private async dispatch(request: JsonRpcRequest): Promise<JsonRpcResponse> {
    try {
      if (request.method === "initialize") {
        return result(request.id, {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "opencode-lens-mcp", version: "0.1.0" },
        });
      }

      if (request.method === "tools/list") {
        return result(request.id, { tools: tools.map((tool) => tool.definition) });
      }

      if (request.method === "tools/call") {
        const params = asRecord(request.params);
        const name = typeof params?.name === "string" ? params.name : undefined;
        const tool = tools.find((candidate) => candidate.definition.name === name);
        if (!tool) return failure(request.id, -32602, `unknown tool: ${name ?? "<missing>"}`);
        const output = await tool.call(params?.arguments ?? {});
        return result(request.id, { content: [{ type: "text", text: JSON.stringify(output, null, 2) }] });
      }

      return failure(request.id, -32601, `method not found: ${request.method}`);
    } catch (error) {
      return failure(request.id, -32000, error instanceof Error ? error.message : String(error));
    }
  }
}

function readFrame(buffer: Buffer) {
  const firstByte = firstNonWhitespaceByte(buffer);
  if (firstByte === 0x7b || firstByte === 0x5b) {
    const lineEnd = buffer.indexOf("\n");
    if (lineEnd < 0) return undefined;

    const end = lineEnd > 0 && buffer[lineEnd - 1] === 0x0d ? lineEnd - 1 : lineEnd;
    return {
      body: buffer.subarray(0, end).toString("utf8"),
      rest: buffer.subarray(lineEnd + 1),
      style: "json-line" as const,
    };
  }

  const headerInfo = findHeaderEnd(buffer);
  if (!headerInfo) return undefined;

  const header = buffer.subarray(0, headerInfo.index).toString("utf8");
  const length = contentLength(header);
  if (length === undefined) return undefined;

  const bodyStart = headerInfo.index + headerInfo.length;
  const bodyEnd = bodyStart + length;
  if (buffer.length < bodyEnd) return undefined;

  return {
    body: buffer.subarray(bodyStart, bodyEnd).toString("utf8"),
    rest: buffer.subarray(bodyEnd),
    style: "content-length" as const,
  };
}

function firstNonWhitespaceByte(buffer: Buffer) {
  for (const byte of buffer) {
    if (byte !== 0x20 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0d) return byte;
  }
  return undefined;
}

function findHeaderEnd(buffer: Buffer) {
  const crlf = buffer.indexOf("\r\n\r\n");
  const lf = buffer.indexOf("\n\n");
  if (crlf < 0 && lf < 0) return undefined;
  if (crlf >= 0 && (lf < 0 || crlf < lf)) return { index: crlf, length: 4 };
  return { index: lf, length: 2 };
}

function contentLength(header: string) {
  for (const line of header.split("\r\n")) {
    const [name, value] = line.split(":", 2);
    if (name?.toLowerCase() !== "content-length") continue;
    const length = Number(value?.trim());
    return Number.isInteger(length) && length >= 0 ? length : undefined;
  }
  return undefined;
}

function parseRequest(body: string): JsonRpcRequest | undefined {
  try {
    const input = JSON.parse(body);
    if (!input || input.jsonrpc !== "2.0" || typeof input.method !== "string") return undefined;
    return input;
  } catch {
    return undefined;
  }
}

function writeMessage(message: JsonRpcResponse, style: FrameStyle) {
  const body = JSON.stringify(message);
  if (style === "json-line") {
    process.stdout.write(`${body}\n`);
    return;
  }
  process.stdout.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
}

function result(id: string | number | null | undefined, value: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id: id ?? null, result: value };
}

function failure(id: string | number | null | undefined, code: number, message: string): JsonRpcResponse {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
}

function asRecord(input: unknown) {
  return typeof input === "object" && input !== null && !Array.isArray(input) ? (input as Record<string, unknown>) : undefined;
}
