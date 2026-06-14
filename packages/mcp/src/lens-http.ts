import { createConnection } from "node:net";

export async function requestUnixJson<T>(
  socketPath: string,
  path: string,
  options: { method?: "GET" | "POST"; body?: unknown; timeoutMs?: number } = {},
) {
  const response = await requestUnix(socketPath, path, options.method ?? "GET", options.body, options.timeoutMs ?? 2_000);
  const parsed = parseHttpResponse(response);
  if (parsed.status < 200 || parsed.status >= 300) {
    throw new LensHttpRequestError(parsed.status, parsed.body);
  }
  return JSON.parse(parsed.body) as T;
}

export async function requestUnixJsonResult<T>(
  socketPath: string,
  path: string,
  options: { method?: "GET" | "POST"; body?: unknown; timeoutMs?: number } = {},
) {
  try {
    return { ok: true as const, data: await requestUnixJson<T>(socketPath, path, options) };
  } catch (error) {
    return {
      ok: false as const,
      error: error instanceof Error ? error.message : String(error),
      status: error instanceof LensHttpRequestError ? error.status : undefined,
      body: error instanceof LensHttpRequestError ? parseMaybeJson(error.body) : undefined,
    };
  }
}

export class LensHttpRequestError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
  ) {
    super(`lens returned HTTP ${status}`);
  }
}

function requestUnix(socketPath: string, path: string, method: "GET" | "POST", body: unknown, timeoutMs: number) {
  return new Promise<string>((resolve, reject) => {
    const socket = createConnection({ path: socketPath });
    const chunks: Buffer[] = [];
    let settled = false;
    const timeout = setTimeout(() => {
      fail(new Error("lens request timed out"));
    }, timeoutMs);

    function done(response: string) {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      socket.destroy();
      resolve(response);
    }

    function fail(error: Error) {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      socket.destroy();
      reject(error);
    }

    socket.on("connect", () => {
      const encodedBody = body === undefined ? undefined : JSON.stringify(body);
      const headers = [`${method} ${path} HTTP/1.1`, "Host: opencode-lens", "Connection: close"];
      if (encodedBody !== undefined) {
        headers.push("Content-Type: application/json", `Content-Length: ${Buffer.byteLength(encodedBody)}`);
      }
      socket.write([...headers, "", encodedBody ?? ""].join("\r\n"));
    });

    socket.on("data", (chunk) => {
      chunks.push(Buffer.from(chunk));
      const response = readCompleteResponse(chunks);
      if (response) done(response);
    });
    socket.on("error", (error) => {
      fail(error);
    });
    socket.on("end", () => {
      done(Buffer.concat(chunks).toString("utf8"));
    });
  });
}

function readCompleteResponse(chunks: Buffer[]) {
  const buffer = Buffer.concat(chunks);
  const split = buffer.indexOf("\r\n\r\n");
  if (split < 0) return undefined;

  const header = buffer.subarray(0, split).toString("utf8");
  const contentLength = getContentLength(header);
  if (contentLength === undefined) return undefined;
  if (buffer.length - split - 4 < contentLength) return undefined;
  return buffer.subarray(0, split + 4 + contentLength).toString("utf8");
}

function parseHttpResponse(response: string) {
  const split = response.indexOf("\r\n\r\n");
  if (split < 0) throw new Error("invalid lens HTTP response");

  const header = response.slice(0, split);
  const body = response.slice(split + 4);
  const status = Number(header.split(" ")[1]);
  if (!Number.isInteger(status)) throw new Error("invalid lens HTTP status");

  return { status, body };
}

function getContentLength(header: string) {
  for (const line of header.split("\r\n")) {
    const split = line.indexOf(":");
    if (split < 0) continue;
    if (line.slice(0, split).trim().toLowerCase() !== "content-length") continue;
    const length = Number(line.slice(split + 1).trim());
    return Number.isInteger(length) && length >= 0 ? length : undefined;
  }
  return undefined;
}

function parseMaybeJson(input: string) {
  try {
    return JSON.parse(input);
  } catch {
    return input;
  }
}
