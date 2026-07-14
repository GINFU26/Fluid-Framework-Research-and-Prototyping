import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, WebSocket } from "ws";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 3030);
const DIST_DIR = path.join(__dirname, "dist");
const AI_PROXY_TARGET = process.env.AI_PROXY_TARGET?.replace(/\/$/, "");
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_BASE_URL = (process.env.OPENAI_BASE_URL ?? "https://api.openai.com").replace(/\/$/, "");
const OPENAI_MODEL = process.env.OPENAI_MODEL;
const AZURE_OPENAI_API_KEY = process.env.AZURE_OPENAI_API_KEY;
const AZURE_OPENAI_ENDPOINT = process.env.AZURE_OPENAI_ENDPOINT?.replace(/\/$/, "");
const AZURE_OPENAI_DEPLOYMENT = process.env.AZURE_OPENAI_DEPLOYMENT;
const AZURE_OPENAI_API_VERSION = process.env.AZURE_OPENAI_API_VERSION ?? "2025-01-01-preview";
const AZURE_OPENAI_CHAT_COMPLETIONS_URL = process.env.AZURE_OPENAI_CHAT_COMPLETIONS_URL;

const MIME_TYPES = new Map([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".map", "application/json; charset=utf-8"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"],
  [".wasm", "application/wasm"],
]);

const rooms = new Map();

const httpServer = createServer(async (req, res) => {
  setSharedHeaders(res);

  if (req.url?.startsWith("/healthz")) {
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  if (req.url?.startsWith("/ai-proxy")) {
    await handleAiProxy(req, res);
    return;
  }

  serveStatic(req, res);
});

const wss = new WebSocketServer({ server: httpServer });

function getRoom(docId) {
  if (!rooms.has(docId)) rooms.set(docId, new Set());
  return rooms.get(docId);
}

function broadcast(room, sender, data, isBinary) {
  for (const client of room) {
    if (client !== sender && client.readyState === WebSocket.OPEN) {
      client.send(data, { binary: isBinary });
    }
  }
}

wss.on("connection", (ws, req) => {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
  const docId = url.searchParams.get("docId") ?? "default";
  const resetRoom = url.searchParams.get("reset") === "1";
  const room = getRoom(docId);

  if (resetRoom) {
    for (const client of [...room]) {
      if (client !== ws && client.readyState === WebSocket.OPEN) client.close(4000, "room reset");
    }
    room.clear();
  }

  room.add(ws);
  console.log(`[relay] joined "${docId}" (${room.size} clients)`);

  ws.on("message", (data, isBinary) => {
    broadcast(room, ws, data, isBinary);
  });

  ws.on("close", () => {
    room.delete(ws);
    console.log(`[relay] left "${docId}" (${room.size} remaining)`);
  });

  ws.on("error", (err) => console.error("[relay] error:", err.message));
});

httpServer.listen(PORT, () => {
  console.log(`[server] running on http://localhost:${PORT}`);
  console.log(`[server] AI proxy ${getAiProxyMode()}`);
});

function setSharedHeaders(res) {
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
  res.setHeader("X-Content-Type-Options", "nosniff");
}

async function handleAiProxy(req, res) {
  if (!AI_PROXY_TARGET && !OPENAI_API_KEY && !isAzureOpenAiConfigured()) {
    res.writeHead(503, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({
      error: "AI proxy is disabled for this showcase because no demo AI backend is configured.",
    }));
    return;
  }

  try {
    const requestUrl = new URL(req.url ?? "/ai-proxy", `http://localhost:${PORT}`);
    const upstreamUrl = getAiUpstreamUrl(requestUrl);
    let body = await readRequestBody(req);
    const headers = new Headers();
    const contentType = req.headers["content-type"];
    if (contentType) headers.set("content-type", Array.isArray(contentType) ? contentType[0] : contentType);

    if (!AI_PROXY_TARGET && isAzureOpenAiConfigured()) {
      headers.set("api-key", AZURE_OPENAI_API_KEY);
      body = adaptOpenAiPayloadForAzure(body);
    } else if (!AI_PROXY_TARGET && OPENAI_API_KEY) {
      headers.set("authorization", `Bearer ${OPENAI_API_KEY}`);
      body = maybeOverrideOpenAiModel(body);
    }

    const upstream = await fetch(upstreamUrl, {
      method: req.method ?? "GET",
      headers,
      body: body.length > 0 && req.method !== "GET" && req.method !== "HEAD" ? body : undefined,
    });

    res.writeHead(upstream.status, {
      "Content-Type": upstream.headers.get("content-type") ?? "application/json; charset=utf-8",
    });
    const buffer = Buffer.from(await upstream.arrayBuffer());
    res.end(buffer);
  } catch (error) {
    res.writeHead(502, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({
      error: error instanceof Error ? error.message : "AI proxy request failed.",
    }));
  }
}

function maybeOverrideOpenAiModel(body) {
  if (!OPENAI_MODEL || body.length === 0) return body;

  try {
    const payload = JSON.parse(body.toString("utf8"));
    if (payload && typeof payload === "object" && "model" in payload) {
      payload.model = OPENAI_MODEL;
      return Buffer.from(JSON.stringify(payload));
    }
  } catch {
    // Leave non-JSON bodies untouched.
  }

  return body;
}

function adaptOpenAiPayloadForAzure(body) {
  if (body.length === 0) return body;

  try {
    const payload = JSON.parse(body.toString("utf8"));
    if (payload && typeof payload === "object") {
      delete payload.model;
      return Buffer.from(JSON.stringify(payload));
    }
  } catch {
    // Leave non-JSON bodies untouched.
  }

  return body;
}

function getAiProxyMode() {
  if (AI_PROXY_TARGET) return `enabled -> ${AI_PROXY_TARGET}`;
  if (isAzureOpenAiConfigured()) return "enabled -> Azure OpenAI";
  if (OPENAI_API_KEY) return `enabled -> ${OPENAI_BASE_URL}`;
  return "disabled";
}

function getAiUpstreamUrl(requestUrl) {
  let upstreamPath = requestUrl.pathname.replace(/^\/ai-proxy/, "") || "/";

  if (AI_PROXY_TARGET) {
    return `${AI_PROXY_TARGET}${upstreamPath}${requestUrl.search}`;
  }

  if (isAzureOpenAiConfigured()) {
    return getAzureOpenAiChatCompletionsUrl();
  }

  if (OPENAI_API_KEY) {
    upstreamPath = upstreamPath.replace(/^\/openai(?=\/v1\/)/, "");
    return `${OPENAI_BASE_URL}${upstreamPath}${requestUrl.search}`;
  }

  throw new Error("AI proxy is disabled.");
}

function isAzureOpenAiConfigured() {
  return Boolean(
    AZURE_OPENAI_API_KEY &&
      (AZURE_OPENAI_CHAT_COMPLETIONS_URL || (AZURE_OPENAI_ENDPOINT && AZURE_OPENAI_DEPLOYMENT)),
  );
}

function getAzureOpenAiChatCompletionsUrl() {
  if (AZURE_OPENAI_CHAT_COMPLETIONS_URL) return AZURE_OPENAI_CHAT_COMPLETIONS_URL;

  const deployment = encodeURIComponent(AZURE_OPENAI_DEPLOYMENT);
  const apiVersion = encodeURIComponent(AZURE_OPENAI_API_VERSION);
  return `${AZURE_OPENAI_ENDPOINT}/openai/deployments/${deployment}/chat/completions?api-version=${apiVersion}`;
}

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

async function serveStatic(req, res) {
  if (!existsSync(DIST_DIR)) {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Build output not found. Run npm run build before npm start.");
    return;
  }

  const requestUrl = new URL(req.url ?? "/", `http://localhost:${PORT}`);
  const pathname = decodeURIComponent(requestUrl.pathname);
  const filePath = resolveStaticPath(pathname);
  const contentPath = filePath && existsSync(filePath) && statSync(filePath).isFile()
    ? filePath
    : path.join(DIST_DIR, "index.html");

  try {
    const ext = path.extname(contentPath).toLowerCase();
    const type = MIME_TYPES.get(ext) ?? "application/octet-stream";
    const stat = statSync(contentPath);
    res.writeHead(200, {
      "Content-Type": type,
      "Content-Length": stat.size,
      "Cache-Control": contentPath.endsWith("index.html") ? "no-store" : "public, max-age=31536000, immutable",
    });
    createReadStream(contentPath).pipe(res);
  } catch {
    res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Unable to serve demo asset.");
  }
}

function resolveStaticPath(pathname) {
  const requested = pathname === "/" ? "/index.html" : pathname;
  const normalized = path.normalize(requested).replace(/^[/\\]+/, "").replace(/^(\.\.[/\\])+/, "");
  const fullPath = path.resolve(DIST_DIR, normalized);
  const distRoot = path.resolve(DIST_DIR);
  return fullPath === distRoot || fullPath.startsWith(`${distRoot}${path.sep}`) ? fullPath : null;
}
