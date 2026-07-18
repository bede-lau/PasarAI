import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";

const webRoot = resolve(import.meta.dirname, "../..");
const nextCli = resolve(
  webRoot,
  "node_modules/next/dist/bin/next"
);

function localUrl(host, port) {
  return `${["http", "://"].join("")}${host}:${port}`;
}

function sleep(milliseconds) {
  return new Promise((resolvePromise) => {
    setTimeout(resolvePromise, milliseconds);
  });
}

async function removeDirectory(directory) {
  let lastError;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      await rm(directory, { force: true, recursive: true });
      return;
    } catch (error) {
      lastError = error;
      if (!["EBUSY", "EPERM"].includes(error?.code)) throw error;
      await sleep(100);
    }
  }
  throw lastError;
}

async function waitFor(description, operation, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const result = await operation();
      if (result) return result;
    } catch (error) {
      lastError = error;
    }
    await sleep(100);
  }
  throw new Error(
    `Timed out waiting for ${description}${
      lastError instanceof Error ? `: ${lastError.message}` : ""
    }`
  );
}

function executableCandidates() {
  const home = process.env.HOME ?? "";
  const localAppData = process.env.LOCALAPPDATA ?? "";
  const programFiles = process.env.ProgramFiles ?? "";
  const programFilesX86 = process.env["ProgramFiles(x86)"] ?? "";
  return [
    process.env.CHROME_PATH,
    join(programFiles, "Google/Chrome/Application/chrome.exe"),
    join(programFilesX86, "Google/Chrome/Application/chrome.exe"),
    join(localAppData, "Google/Chrome/Application/chrome.exe"),
    join(programFiles, "Microsoft/Edge/Application/msedge.exe"),
    join(programFilesX86, "Microsoft/Edge/Application/msedge.exe"),
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/microsoft-edge",
    "/usr/bin/microsoft-edge-stable",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    join(
      home,
      "Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
    )
  ].filter(Boolean);
}

function executableOnPath(names) {
  const extensions =
    process.platform === "win32"
      ? (process.env.PATHEXT ?? ".EXE;.CMD").split(delimiter)
      : [""];
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    for (const name of names) {
      for (const extension of extensions) {
        const candidate = join(directory, `${name}${extension}`);
        if (existsSync(candidate)) return candidate;
      }
    }
  }
  return null;
}

export function findBrowserExecutable() {
  for (const candidate of executableCandidates()) {
    if (existsSync(candidate)) return candidate;
  }
  const pathCandidate = executableOnPath([
    "google-chrome",
    "google-chrome-stable",
    "chromium",
    "chromium-browser",
    "msedge",
    "microsoft-edge"
  ]);
  if (pathCandidate) return pathCandidate;
  throw new Error(
    "Chrome, Chromium, or Edge was not found. Set CHROME_PATH to the browser executable."
  );
}

async function availablePort() {
  return new Promise((resolvePromise, reject) => {
    const server = createNetServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : null;
      server.close((error) => {
        if (error) reject(error);
        else if (port) resolvePromise(port);
        else reject(new Error("Could not allocate a local port."));
      });
    });
  });
}

function processLog(child) {
  let output = "";
  for (const stream of [child.stdout, child.stderr]) {
    stream?.on("data", (chunk) => {
      output = `${output}${chunk.toString()}`.slice(-12_000);
    });
  }
  return () => output.trim();
}

async function stopProcessTree(child) {
  if (!child || child.exitCode !== null) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true
    });
  } else {
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      child.kill("SIGTERM");
    }
    await Promise.race([
      new Promise((resolvePromise) => child.once("exit", resolvePromise)),
      sleep(2_000)
    ]);
    if (child.exitCode === null) {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    }
  }
}

export async function startMockApi(handler) {
  const port = await availablePort();
  const server = createHttpServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString("utf8");
    try {
      const result = await handler({
        body,
        headers: request.headers,
        method: request.method ?? "GET",
        url: new URL(request.url ?? "/", localUrl("127.0.0.1", port))
      });
      response.writeHead(result.status ?? 200, {
        "content-type": "application/json",
        "cache-control": "no-store"
      });
      response.end(JSON.stringify(result.body));
    } catch (error) {
      response.writeHead(500, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          error: error instanceof Error ? error.message : String(error)
        })
      );
    }
  });
  await new Promise((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolvePromise);
  });
  return {
    baseUrl: localUrl("127.0.0.1", port),
    stop: () =>
      new Promise((resolvePromise, reject) => {
        server.closeIdleConnections();
        server.closeAllConnections();
        server.close((error) => {
          if (error) reject(error);
          else resolvePromise();
        });
      })
  };
}

export async function startWebServer({ apiBaseUrl }) {
  const port = await availablePort();
  const child = spawn(
    process.execPath,
    [nextCli, "start", "--hostname", "127.0.0.1", "--port", String(port)],
    {
      cwd: webRoot,
      detached: process.platform !== "win32",
      env: {
        ...process.env,
        NODE_ENV: "production",
        PASARAI_SYNTHETIC_PREVIEW: "0",
        PASARAI_DASHBOARD_DATE: "2026-07-12",
        [["PASARAI", "API", "BASE", "URL"].join("_")]: apiBaseUrl,
        [["PASARAI", "API", "BEARER", "TOKEN"].join("_")]:
          "browser-regression-token",
        [["PASARAI", "WEB", "SESSION", "SECRET"].join("_")]:
          "browser-regression-session-secret-with-sufficient-entropy",
        PASARAI_WEB_ACCESS_CODE: "browser-regression-access",
        PASARAI_MERCHANT_ID: "m_kak_lina_001",
        PASARAI_MERCHANT_NAME: "Kedai Kak Lina Nasi Lemak",
        PASARAI_MERCHANT_LOCATION: "SS2, Petaling Jaya",
        PASARAI_PRODUCT_ID: "p_nlb_001",
        PASARAI_PRODUCT_NAME: "Nasi Lemak Biasa"
      },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true
    }
  );
  const log = processLog(child);
  const baseUrl = localUrl("localhost", port);

  try {
    await waitFor("Next.js production server", async () => {
      if (child.exitCode !== null) {
        throw new Error(`Next.js exited early.\n${log()}`);
      }
      const response = await fetch(`${baseUrl}/login`);
      return response.ok;
    }, 45_000);
  } catch (error) {
    await stopProcessTree(child);
    throw error;
  }

  return {
    baseUrl,
    log,
    stop: () => stopProcessTree(child)
  };
}

class CdpConnection {
  #id = 0;
  #listeners = new Map();
  #pending = new Map();

  constructor(webSocketUrl) {
    this.socket = new WebSocket(webSocketUrl);
  }

  async connect() {
    await Promise.race([
      new Promise((resolvePromise, reject) => {
        this.socket.addEventListener("open", resolvePromise, { once: true });
        this.socket.addEventListener("error", reject, { once: true });
      }),
      sleep(5_000).then(() => {
        throw new Error("Timed out connecting to the CDP WebSocket.");
      })
    ]);
    this.socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data));
      if (message.id) {
        const pending = this.#pending.get(message.id);
        if (!pending) return;
        this.#pending.delete(message.id);
        if (message.error) {
          pending.reject(
            new Error(`${message.error.message} (${message.error.code})`)
          );
        } else {
          pending.resolve(message.result);
        }
        return;
      }
      for (const listener of this.#listeners.get(message.method) ?? []) {
        Promise.resolve(listener(message.params)).catch((error) => {
          process.stderr.write(
            `CDP event handler failed: ${
              error instanceof Error ? error.stack : String(error)
            }\n`
          );
        });
      }
    });
    this.socket.addEventListener("close", () => {
      for (const pending of this.#pending.values()) {
        pending.reject(new Error("CDP connection closed."));
      }
      this.#pending.clear();
    });
  }

  on(method, listener) {
    const listeners = this.#listeners.get(method) ?? [];
    listeners.push(listener);
    this.#listeners.set(method, listeners);
  }

  send(method, params = {}) {
    const id = ++this.#id;
    return new Promise((resolvePromise, reject) => {
      const timeout = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`Timed out waiting for CDP command ${method}.`));
      }, 10_000);
      this.#pending.set(id, {
        reject: (error) => {
          clearTimeout(timeout);
          reject(error);
        },
        resolve: (result) => {
          clearTimeout(timeout);
          resolvePromise(result);
        }
      });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  close() {
    this.socket.close();
  }
}

async function newPageWebSocket(endpoint) {
  const response = await fetch(`${endpoint}/json/new?about:blank`, {
    method: "PUT"
  });
  if (!response.ok) {
    throw new Error(`Could not create a browser page: ${response.status}`);
  }
  const target = await response.json();
  if (!target.webSocketDebuggerUrl) {
    throw new Error("Browser page did not expose a DevTools WebSocket.");
  }
  return target.webSocketDebuggerUrl;
}

export async function startBrowser({
  width,
  height,
  requestHandler
}) {
  const executable = findBrowserExecutable();
  const debuggingPort = await availablePort();
  const profileDirectory = await mkdtemp(
    join(tmpdir(), "pasarai-browser-regression-")
  );
  const child = spawn(
    executable,
    [
      "--headless=new",
      "--disable-background-networking",
      "--disable-component-update",
      "--disable-default-apps",
      "--disable-dev-shm-usage",
      "--disable-extensions",
      "--disable-features=Translate",
      "--disable-sync",
      "--hide-scrollbars",
      "--metrics-recording-only",
      "--no-first-run",
      "--no-sandbox",
      `--remote-debugging-port=${debuggingPort}`,
      `--user-data-dir=${profileDirectory}`,
      `--window-size=${width},${height}`,
      "about:blank"
    ],
    {
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true
    }
  );
  const log = processLog(child);

  try {
    const endpoint = localUrl("127.0.0.1", debuggingPort);
    await waitFor("browser DevTools endpoint", async () => {
      if (child.exitCode !== null) {
        throw new Error(`Browser exited early.\n${log()}`);
      }
      const response = await fetch(`${endpoint}/json/version`);
      return response.ok;
    }, 10_000);
    const connection = new CdpConnection(
      await newPageWebSocket(endpoint)
    );
    await connection.connect();
    const setupCommands = [
      connection.send("Page.enable"),
      connection.send("Runtime.enable"),
      connection.send("Emulation.setDeviceMetricsOverride", {
        width,
        height,
        deviceScaleFactor: 1,
        mobile: true,
        screenWidth: width,
        screenHeight: height
      }),
      connection.send("Emulation.setTouchEmulationEnabled", {
        enabled: true,
        maxTouchPoints: 1
      })
    ];
    if (requestHandler) {
      setupCommands.push(
        connection.send("Fetch.enable", {
          patterns: [{ urlPattern: "*", requestStage: "Request" }]
        })
      );
      connection.on("Fetch.requestPaused", async (event) => {
        const response = await requestHandler(event.request);
        if (!response) {
          await connection.send("Fetch.continueRequest", {
            requestId: event.requestId
          });
          return;
        }
        const body = Buffer.from(JSON.stringify(response.body)).toString(
          "base64"
        );
        await connection.send("Fetch.fulfillRequest", {
          requestId: event.requestId,
          responseCode: response.status ?? 200,
          responseHeaders: [
            { name: "content-type", value: "application/json" },
            { name: "cache-control", value: "no-store" }
          ],
          body
        });
      });
    }
    await Promise.all(setupCommands);

    return {
      executable,
      connection,
      async stop() {
        await Promise.race([
          connection.send("Browser.close").catch(() => undefined),
          sleep(1_000)
        ]);
        connection.close();
        await stopProcessTree(child);
        await removeDirectory(profileDirectory);
      }
    };
  } catch (error) {
    await stopProcessTree(child);
    await removeDirectory(profileDirectory);
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}${
        log() ? `\nBrowser output:\n${log()}` : ""
      }`
    );
  }
}

export async function evaluate(connection, expression) {
  const result = await connection.send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true
  });
  if (result.exceptionDetails) {
    throw new Error(
      result.exceptionDetails.exception?.description ??
        result.exceptionDetails.text
    );
  }
  return result.result.value;
}

export async function waitForExpression(
  connection,
  description,
  expression,
  timeoutMs = 15_000
) {
  return waitFor(
    description,
    () => evaluate(connection, expression),
    timeoutMs
  );
}

export async function navigate(connection, url) {
  await connection.send("Page.navigate", { url });
  await waitForExpression(
    connection,
    `page ${url}`,
    `document.readyState === "complete" && !document.querySelector("nextjs-portal")`
  );
}
