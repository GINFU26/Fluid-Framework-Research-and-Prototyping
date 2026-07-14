import { spawn } from "node:child_process";
import net from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import WebSocket from "ws";

const port = await getFreePort();
const origin = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, ["server.mjs"], {
  cwd: process.cwd(),
  env: { ...process.env, PORT: String(port) },
  stdio: ["ignore", "pipe", "pipe"],
});

let stderr = "";
server.stderr.on("data", (chunk) => {
  stderr += chunk.toString();
});

let first;
let second;

try {
  await waitForHealth(`${origin}/healthz`);

  const room = `smoke-${Date.now()}`;
  const socketUrl = `ws://127.0.0.1:${port}/?docId=${room}`;
  first = await openSocket(socketUrl);
  second = await openSocket(socketUrl);

  const textMessage = JSON.stringify({ type: "presence", userName: "Reviewer A" });
  const binaryMessage = Buffer.from([1, 3, 3, 7]);

  const textReceived = receiveOnce(second);
  first.send(textMessage);
  const text = await textReceived;
  if (text.isBinary || text.data.toString() !== textMessage) {
    throw new Error("Text relay message did not arrive unchanged.");
  }

  const binaryReceived = receiveOnce(first);
  second.send(binaryMessage);
  const binary = await binaryReceived;
  if (!binary.isBinary || !Buffer.from(binary.data).equals(binaryMessage)) {
    throw new Error("Binary relay message did not arrive unchanged.");
  }

  console.log("Relay smoke passed: health, text forwarding, and binary forwarding.");
} finally {
  first?.close();
  second?.close();
  server.kill();
  await Promise.race([
    new Promise((resolve) => server.once("exit", resolve)),
    delay(2_000),
  ]);
}

if (server.exitCode && server.exitCode !== 0) {
  throw new Error(`Prototype server exited with ${server.exitCode}: ${stderr.trim()}`);
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const listener = net.createServer();
    listener.once("error", reject);
    listener.listen(0, "127.0.0.1", () => {
      const address = listener.address();
      if (!address || typeof address === "string") {
        listener.close();
        reject(new Error("Could not allocate a local port."));
        return;
      }
      const { port: availablePort } = address;
      listener.close((error) => error ? reject(error) : resolve(availablePort));
    });
  });
}

async function waitForHealth(url) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) {
      throw new Error(`Prototype server exited before becoming healthy: ${stderr.trim()}`);
    }
    try {
      const response = await fetch(url);
      if (response.ok && (await response.json()).ok === true) return;
    } catch {
      // The server may still be starting.
    }
    await delay(100);
  }
  throw new Error(`Prototype server did not become healthy: ${stderr.trim()}`);
}

function openSocket(url) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    const timer = setTimeout(() => {
      socket.terminate();
      reject(new Error("WebSocket connection timed out."));
    }, 5_000);
    socket.once("open", () => {
      clearTimeout(timer);
      resolve(socket);
    });
    socket.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

function receiveOnce(socket) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error("Relay message timed out."));
    }, 5_000);
    socket.once("message", (data, isBinary) => {
      clearTimeout(timer);
      resolve({ data, isBinary });
    });
  });
}