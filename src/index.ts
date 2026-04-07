import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import express from "express";
import { z } from "zod";
import { readFile, readdir, realpath } from "fs/promises";
import { join, resolve } from "path";
import {
  startSession,
  sendToSession,
  getSessionOutput,
  waitForOutput,
  listSessions,
  killSession,
  WORKSPACE_DIR,
} from "./sessions.js";

function log(...args: unknown[]): void {
  console.error("[mcp-server]", ...args);
}

// --- Config ---
const AUTH_TOKEN = process.env.AUTH_TOKEN;
if (!AUTH_TOKEN) {
  console.error("FATAL: AUTH_TOKEN env var is required");
  process.exit(1);
}

const PORT = parseInt(process.env.PORT || "3500", 10);

// --- Path sandboxing ---
// Filesystem tools are restricted to WORKSPACE_DIR and active session cwds.
// Symlinks are resolved before checking to prevent escapes.
async function assertPathAllowed(targetPath: string): Promise<string> {
  const resolved = resolve(targetPath);
  let real: string;
  try {
    real = await realpath(resolved);
  } catch {
    // File may not exist yet — fall back to the resolved path
    real = resolved;
  }

  const allowedRoots = [WORKSPACE_DIR];
  for (const s of listSessions()) {
    allowedRoots.push(s.cwd);
  }

  for (const root of allowedRoots) {
    const realRoot = await realpath(root).catch(() => root);
    if (real === realRoot || real.startsWith(realRoot + "/")) {
      return real;
    }
  }

  throw new Error(`Access denied: path ${targetPath} is outside allowed directories`);
}

// --- MCP Server ---
function createServer(): McpServer {
  const server = new McpServer({
    name: "pokeclaw",
    version: "1.0.0",
  });

  server.tool(
    "session_start",
    "Spawn a new coding agent session. Both agents run the task and exit when done — a status of 'exited' with exitCode 0 means success, not a crash. Use session_output to read the results after the session completes.",
    {
      agent: z.enum(["codex", "claude-code"]).describe("Which coding agent to use"),
      cwd: z.string().describe("Working directory for the session"),
      task: z.string().describe("Initial prompt/task for the agent"),
    },
    async ({ agent, cwd, task }) => {
      try {
        const info = await startSession(agent, cwd, task);
        return {
          content: [{ type: "text", text: JSON.stringify(info, null, 2) }],
        };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text", text: `Error: ${msg}` }],
          isError: true,
        };
      }
    }
  );

  server.tool(
    "session_send",
    "Send a message to an existing session's stdin",
    {
      sessionId: z.string().describe("Session ID"),
      message: z.string().describe("Message to send to stdin"),
    },
    async ({ sessionId, message }) => {
      try {
        const result = sendToSession(sessionId, message);
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text", text: `Error: ${msg}` }],
          isError: true,
        };
      }
    }
  );

  server.tool(
    "session_output",
    "Get output from a session. Returns the full output log, current status, and exitCode. An exited session with exitCode 0 completed successfully — read the output for the results.",
    {
      sessionId: z.string().describe("Session ID"),
      since: z.number().optional().describe("Line offset to read from (omit for all output)"),
    },
    async ({ sessionId, since }) => {
      try {
        const result = getSessionOutput(sessionId, since);
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text", text: `Error: ${msg}` }],
          isError: true,
        };
      }
    }
  );

  server.tool(
    "session_wait",
    "Wait for a session to produce new output or exit (polls up to timeout)",
    {
      sessionId: z.string().describe("Session ID"),
      since: z.number().optional().describe("Line offset to watch from"),
      timeoutMs: z
        .number()
        .optional()
        .describe("Max time to wait in ms (default: 30000, max: 120000)"),
    },
    async ({ sessionId, since, timeoutMs }) => {
      try {
        const timeout = Math.min(timeoutMs ?? 30000, 120000);
        const result = await waitForOutput(sessionId, since, timeout);
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text", text: `Error: ${msg}` }],
          isError: true,
        };
      }
    }
  );

  // --- Filesystem tools ---

  server.tool(
    "read_file",
    "Read the contents of a file on the host",
    {
      path: z.string().describe("Absolute path to the file"),
      maxLines: z.number().optional().describe("Maximum number of lines to return (default: all)"),
      offset: z
        .number()
        .optional()
        .describe("Line offset to start reading from (0-based, default: 0)"),
    },
    async ({ path: filePath, maxLines, offset }) => {
      try {
        const safePath = await assertPathAllowed(filePath);
        const content = await readFile(safePath, "utf-8");
        let lines = content.split("\n");
        const totalLines = lines.length;
        if (offset) {
          lines = lines.slice(offset);
        }
        if (maxLines) {
          lines = lines.slice(0, maxLines);
        }
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ totalLines, lines: lines.join("\n") }, null, 2),
            },
          ],
        };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text", text: `Error: ${msg}` }],
          isError: true,
        };
      }
    }
  );

  server.tool(
    "list_directory",
    "List files and directories at a given path on the host",
    {
      path: z.string().describe("Absolute path to the directory"),
      recursive: z.boolean().optional().describe("List recursively (default: false, max depth 3)"),
    },
    async ({ path: dirPath, recursive }) => {
      try {
        const safePath = await assertPathAllowed(dirPath);
        const entries = await listDir(safePath, recursive ? 3 : 1, 0);
        return {
          content: [{ type: "text", text: JSON.stringify(entries, null, 2) }],
        };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text", text: `Error: ${msg}` }],
          isError: true,
        };
      }
    }
  );

  server.tool("session_list", "List all active sessions", {}, async () => {
    const sessions = listSessions();
    return {
      content: [{ type: "text", text: JSON.stringify(sessions, null, 2) }],
    };
  });

  server.tool(
    "session_kill",
    "Kill a session",
    {
      sessionId: z.string().describe("Session ID to kill"),
    },
    async ({ sessionId }) => {
      try {
        const info = killSession(sessionId);
        return {
          content: [{ type: "text", text: JSON.stringify(info, null, 2) }],
        };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text", text: `Error: ${msg}` }],
          isError: true,
        };
      }
    }
  );

  return server;
}

// --- Helpers ---
interface DirEntry {
  name: string;
  type: "file" | "directory";
  children?: DirEntry[];
}

async function listDir(
  dirPath: string,
  maxDepth: number,
  currentDepth: number
): Promise<DirEntry[]> {
  const entries = await readdir(dirPath, { withFileTypes: true });
  const result: DirEntry[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
    const entryInfo: DirEntry = {
      name: entry.name,
      type: entry.isDirectory() ? "directory" : "file",
    };
    if (entry.isDirectory() && currentDepth + 1 < maxDepth) {
      entryInfo.children = await listDir(join(dirPath, entry.name), maxDepth, currentDepth + 1);
    }
    result.push(entryInfo);
  }
  return result;
}

// --- HTTP Server with Auth & Rate Limiting ---
const app = express();

const MAX_SSE_CONNECTIONS = parseInt(process.env.MAX_SSE_CONNECTIONS || "50", 10);
const SSE_IDLE_TIMEOUT = parseInt(process.env.SSE_IDLE_TIMEOUT || "300000", 10); // 5 min
const RATE_LIMIT_RPM = parseInt(process.env.RATE_LIMIT_RPM || "120", 10);

// Per-IP sliding window rate limiter for POST /messages
const rateBuckets = new Map<string, { count: number; resetAt: number }>();

function rateLimit(req: express.Request, res: express.Response, next: express.NextFunction): void {
  const ip = req.ip || req.socket.remoteAddress || "unknown";
  const now = Date.now();
  let bucket = rateBuckets.get(ip);
  if (!bucket || now > bucket.resetAt) {
    bucket = { count: 0, resetAt: now + 60_000 };
    rateBuckets.set(ip, bucket);
  }
  bucket.count++;
  if (bucket.count > RATE_LIMIT_RPM) {
    res.status(429).json({ error: "Rate limit exceeded" });
    return;
  }
  next();
}

// Auth middleware
function authenticate(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction
): void {
  const authHeader = req.headers.authorization;
  if (!authHeader || authHeader !== `Bearer ${AUTH_TOKEN}`) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  next();
}

// Track transports, per-connection MCP servers, and activity timestamps
const transports = new Map<string, SSEServerTransport>();
const servers = new Map<string, McpServer>();
const sseLastActivity = new Map<string, number>();

// Evict dead or idle SSE connections every 30s
setInterval(() => {
  const now = Date.now();
  for (const [id, lastActive] of sseLastActivity) {
    const transport = transports.get(id);
    const isSocketDead =
      transport && !(transport as unknown as { res?: { writable?: boolean } }).res?.writable;
    if (isSocketDead || now - lastActive > SSE_IDLE_TIMEOUT) {
      log(`Evicting SSE connection: ${id} (${isSocketDead ? "dead socket" : "idle"})`);
      transports.delete(id);
      servers.delete(id);
      sseLastActivity.delete(id);
    }
  }
}, 30_000);

// SSE endpoint — establishes the persistent connection
app.get("/sse", authenticate, async (req, res) => {
  // If at capacity, evict the oldest connection to make room
  if (transports.size >= MAX_SSE_CONNECTIONS) {
    let oldestId: string | null = null;
    let oldestTime = Infinity;
    for (const [id, lastActive] of sseLastActivity) {
      if (lastActive < oldestTime) {
        oldestTime = lastActive;
        oldestId = id;
      }
    }
    if (oldestId) {
      log(`Evicting oldest SSE connection to make room: ${oldestId}`);
      transports.delete(oldestId);
      servers.delete(oldestId);
      sseLastActivity.delete(oldestId);
    }
  }
  log("New SSE connection");
  const transport = new SSEServerTransport("/messages", res);
  const sessionId = transport.sessionId;
  const mcpServer = createServer();

  transports.set(sessionId, transport);
  servers.set(sessionId, mcpServer);
  sseLastActivity.set(sessionId, Date.now());

  res.on("close", () => {
    transports.delete(sessionId);
    servers.delete(sessionId);
    sseLastActivity.delete(sessionId);
    log(`SSE connection closed: ${sessionId}`);
  });

  await mcpServer.connect(transport);
});

// Messages endpoint — receives JSON-RPC from client
app.post("/messages", authenticate, rateLimit, async (req, res) => {
  const sessionId = req.query.sessionId as string;
  const transport = transports.get(sessionId);
  if (!transport) {
    res.status(400).json({ error: "No active SSE connection for this session" });
    return;
  }
  sseLastActivity.set(sessionId, Date.now());
  await transport.handlePostMessage(req, res);
});

// Health check — no session details without auth
app.get("/health", (req, res) => {
  const authHeader = req.headers.authorization;
  const authed = authHeader === `Bearer ${AUTH_TOKEN}`;
  if (authed) {
    res.json({ status: "ok", sessions: listSessions().length });
  } else {
    res.json({ status: "ok" });
  }
});

const httpServer = app.listen(PORT, () => {
  log(`Coding Agent MCP server listening on port ${PORT}`);
  log(`SSE endpoint: http://localhost:${PORT}/sse`);
  log(`Messages endpoint: http://localhost:${PORT}/messages`);
});

// --- Graceful shutdown ---
function shutdown(signal: string) {
  log(`Received ${signal}, shutting down...`);

  // Kill all running sessions
  for (const session of listSessions()) {
    if (session.status === "running") {
      try {
        killSession(session.sessionId);
        log(`Killed session ${session.sessionId}`);
      } catch {
        // already dead
      }
    }
  }

  // Close HTTP server (stops accepting new connections)
  httpServer.close(() => {
    log("HTTP server closed");
    process.exit(0);
  });

  // Force exit after 10s if graceful shutdown stalls
  setTimeout(() => {
    log("Forced exit after timeout");
    process.exit(1);
  }, 10_000).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
