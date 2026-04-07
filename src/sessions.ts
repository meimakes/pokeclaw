import { execFileSync, spawn } from "child_process";
import { existsSync, mkdirSync, realpathSync } from "fs";
import { isAbsolute, join, resolve } from "path";
import { v4 as uuidv4 } from "uuid";
import type { AgentType, Session, SessionInfo, SessionProcess, SessionStatus } from "./types.js";
import { RingBuffer } from "./types.js";

// node-pty is a native module — import dynamically to handle missing builds gracefully
let pty: typeof import("node-pty") | null = null;
try {
  pty = await import("node-pty");
} catch {
  log("WARNING: node-pty not available. Codex sessions will not work.");
}

function log(...args: unknown[]): void {
  console.error("[sessions]", ...args);
}

const IDLE_TIMEOUT = parseInt(process.env.IDLE_TIMEOUT || "1800000", 10);
export const WORKSPACE_DIR = process.env.WORKSPACE_DIR || process.cwd();

// Resolve agent binaries once at startup so spawns use absolute paths.
const CODEX_BINARY = resolveBinary(["codex", "/usr/local/bin/codex", "/opt/homebrew/bin/codex"]);
const CLAUDE_BINARY = resolveBinary([
  "claude",
  "/opt/homebrew/bin/claude",
  "/usr/local/bin/claude",
]);

// Only these env vars are forwarded to child processes.
// Prevents leaking AUTH_TOKEN, internal service credentials, etc.
const CHILD_ENV_ALLOWLIST = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "TERM",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TMPDIR",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_CACHE_HOME",
  // API keys the agents need
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  // Node config
  "NODE_EXTRA_CA_CERTS",
  "NODE_NO_WARNINGS",
  // SSH/Git
  "SSH_AUTH_SOCK",
  "GIT_AUTHOR_NAME",
  "GIT_AUTHOR_EMAIL",
  "GIT_COMMITTER_NAME",
  "GIT_COMMITTER_EMAIL",
];

function buildChildEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of CHILD_ENV_ALLOWLIST) {
    if (process.env[key] != null) {
      env[key] = process.env[key]!;
    }
  }
  // Also forward any var explicitly prefixed CHILD_ENV_ (stripped)
  for (const [key, val] of Object.entries(process.env)) {
    if (key.startsWith("CHILD_ENV_") && val != null) {
      env[key.slice("CHILD_ENV_".length)] = val;
    }
  }
  return env;
}

const sessions = new Map<string, Session>();

/**
 * Parse a stream-json event from Claude Code into a human-readable log line.
 * Returns null for events that aren't worth surfacing.
 */
function summarizeEvent(event: Record<string, unknown>): string | null {
  switch (event.type) {
    case "system": {
      const sub = event.subtype as string | undefined;
      const model = event.model as string | undefined;
      if (sub === "init") return `[init] session started, model=${model}`;
      return null;
    }
    case "assistant": {
      const msg = event.message as Record<string, unknown> | undefined;
      const content = msg?.content as Array<Record<string, unknown>> | undefined;
      if (!content) return null;
      const parts: string[] = [];
      for (const block of content) {
        if (block.type === "text" && block.text) {
          parts.push(block.text as string);
        } else if (block.type === "tool_use") {
          const inp = block.input as Record<string, unknown> | undefined;
          if (block.name === "Write" || block.name === "Edit") {
            parts.push(`[tool] ${block.name}: ${inp?.file_path ?? ""}`);
          } else if (block.name === "Bash") {
            const cmd = String(inp?.command ?? "").slice(0, 200);
            parts.push(`[tool] Bash: ${cmd}`);
          } else if (block.name === "Read") {
            parts.push(`[tool] Read: ${inp?.file_path ?? ""}`);
          } else {
            parts.push(`[tool] ${block.name}`);
          }
        }
      }
      return parts.length ? parts.join("\n") : null;
    }
    case "result": {
      const subtype = event.subtype as string | undefined;
      const duration = event.duration_ms as number | undefined;
      const turns = event.num_turns as number | undefined;
      const cost = event.total_cost_usd as number | undefined;
      const result = event.result as string | undefined;
      return `[result] ${subtype} (${duration}ms, ${turns} turns, $${cost?.toFixed(4) ?? "?"}) — ${result?.slice(0, 500) ?? ""}`;
    }
    default:
      return null;
  }
}

// Cleanup interval: check for stale sessions every 60s
setInterval(() => {
  const now = Date.now();
  for (const [id, session] of sessions) {
    if (session.status !== "running") continue;
    const lastActive = new Date(session.lastActivity).getTime();
    if (now - lastActive > IDLE_TIMEOUT) {
      log(`Session ${id} idle for ${IDLE_TIMEOUT}ms, killing`);
      killSession(id);
    }
  }
}, 60_000);

function isGitRepo(dir: string): boolean {
  return existsSync(join(dir, ".git"));
}

function resolveBinary(candidates: string[]): string | null {
  for (const candidate of candidates) {
    if (candidate.includes("/") && existsSync(candidate)) return candidate;
    try {
      const resolved = execFileSync("/usr/bin/which", [candidate], {
        encoding: "utf8",
      }).trim();
      if (resolved) return resolved;
    } catch {
      // try next
    }
  }
  return null;
}

// Canonicalized workspace root, resolved once at startup.
const REAL_WORKSPACE = realpathSync(WORKSPACE_DIR);

function resolveSessionCwd(cwd: string): string {
  const resolved = isAbsolute(cwd) ? resolve(cwd) : resolve(WORKSPACE_DIR, cwd);

  // Create the directory before canonicalizing so realpath has something to resolve
  if (!existsSync(resolved)) {
    mkdirSync(resolved, { recursive: true });
    log(`Created session directory ${resolved}`);
  }

  // Canonicalize to resolve symlinks, then check against the real workspace root
  const real = realpathSync(resolved);
  if (real !== REAL_WORKSPACE && !real.startsWith(REAL_WORKSPACE + "/")) {
    throw new Error(`Session cwd escapes workspace: ${cwd} (resolved to ${real})`);
  }
  return real;
}

export async function startSession(
  agent: AgentType,
  cwd: string,
  task: string
): Promise<SessionInfo> {
  const sessionId = uuidv4();
  const sessionCwd = resolveSessionCwd(cwd);
  const outputBuffer = new RingBuffer(10000);
  const now = new Date().toISOString();
  const session: Session = {
    sessionId,
    agent,
    cwd: sessionCwd,
    status: "running",
    startedAt: now,
    lastActivity: now,
    outputBuffer,
    process: null,
  };

  sessions.set(sessionId, session);

  let sessionProcess: SessionProcess;

  if (agent === "codex") {
    if (!pty) {
      throw new Error("node-pty is not available. Cannot spawn Codex sessions.");
    }

    if (!CODEX_BINARY) {
      throw new Error("Codex CLI not found in PATH on the MCP host");
    }

    // Codex requires a git repo
    if (!isGitRepo(sessionCwd)) {
      const { execSync } = await import("child_process");
      execSync("git init", { cwd: sessionCwd });
      log(`Initialized git repo at ${sessionCwd}`);
    }

    const escapedTask = task.replace(/'/g, "'\\''");
    const ptyProcess = pty.spawn(CODEX_BINARY, ["--yolo", "exec", escapedTask], {
      name: "xterm-256color",
      cols: 200,
      rows: 50,
      cwd: sessionCwd,
      env: buildChildEnv(),
    });

    ptyProcess.onData((data: string) => {
      outputBuffer.pushMultiple(data);
      session.lastActivity = new Date().toISOString();
    });

    ptyProcess.onExit(({ exitCode }: { exitCode: number; signal?: number }) => {
      session.status = "exited";
      session.exitCode = exitCode;
      session.process = null;
      log(`Codex session ${sessionId} exited with code ${exitCode}`);
    });

    sessionProcess = {
      write: (data: string) => ptyProcess.write(data),
      kill: () => ptyProcess.kill(),
      pid: ptyProcess.pid,
    };
  } else {
    // claude-code: use regular spawn with --print mode
    if (!CLAUDE_BINARY) {
      throw new Error("Claude Code CLI not found in PATH on the MCP host");
    }

    const child = spawn(
      CLAUDE_BINARY,
      [
        "--print",
        "--verbose",
        "--output-format",
        "stream-json",
        "--dangerously-skip-permissions",
        "--append-system-prompt",
        `You are working in ${sessionCwd}. Do not access files or directories outside this path.`,
        task,
      ],
      {
        cwd: sessionCwd,
        env: buildChildEnv(),
        stdio: ["ignore", "pipe", "pipe"],
      }
    );

    // stdout is stream-json: one JSON object per line
    let stdoutBuf = "";
    child.stdout?.on("data", (data: Buffer) => {
      stdoutBuf += data.toString();
      const lines = stdoutBuf.split("\n");
      stdoutBuf = lines.pop() ?? ""; // keep incomplete last line in buffer
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line);
          const summary = summarizeEvent(event);
          if (summary) {
            outputBuffer.push(summary);
          }
        } catch {
          outputBuffer.push(line);
        }
      }
      session.lastActivity = new Date().toISOString();
    });

    child.stderr?.on("data", (data: Buffer) => {
      outputBuffer.push(`[stderr] ${data.toString().trim()}`);
      session.lastActivity = new Date().toISOString();
    });

    child.on("exit", (code) => {
      session.status = "exited";
      session.exitCode = code;
      session.process = null;
      log(`Claude Code session ${sessionId} exited with code ${code}`);
    });

    child.on("error", (err) => {
      session.status = "error";
      session.process = null;
      outputBuffer.push(`ERROR: ${err.message}`);
      log(`Claude Code session ${sessionId} error: ${err.message}`);
    });

    sessionProcess = {
      write: () => {}, // stdin is ignored for --print mode
      kill: (signal?: string) => {
        child.kill((signal as NodeJS.Signals) || "SIGTERM");
      },
      pid: child.pid,
    };
  }

  session.process = sessionProcess;
  log(`Started ${agent} session ${sessionId} (pid=${sessionProcess.pid}) in ${sessionCwd}`);

  // Wait briefly so immediate failures (bad binary, missing API key, etc.)
  // get captured before we return to the caller.
  await new Promise((resolve) => setTimeout(resolve, 1500));

  const earlyOutput = outputBuffer.getLines(0);
  const info = toSessionInfo(session);
  return {
    ...info,
    pid: sessionProcess.pid,
    initialOutput: earlyOutput.lines.join("\n"),
  };
}

export function sendToSession(
  sessionId: string,
  message: string
): { output: string; offset: number } {
  const session = sessions.get(sessionId);
  if (!session) throw new Error(`Session ${sessionId} not found`);
  if (session.status !== "running")
    throw new Error(`Session ${sessionId} is not running (status: ${session.status})`);
  if (!session.process) throw new Error(`Session ${sessionId} has no active process`);

  const beforeOffset = session.outputBuffer.length;
  session.process.write(message + "\n");
  session.lastActivity = new Date().toISOString();

  // Return output captured so far since before send
  const { lines, offset } = session.outputBuffer.getLines(beforeOffset);
  return { output: lines.join("\n"), offset };
}

export function getSessionOutput(
  sessionId: string,
  since?: number
): {
  output: string;
  offset: number;
  status: SessionStatus;
  exitCode?: number | null;
  completedSuccessfully?: boolean;
} {
  const session = sessions.get(sessionId);
  if (!session) throw new Error(`Session ${sessionId} not found`);

  const { lines, offset } = session.outputBuffer.getLines(since);
  return {
    output: lines.join("\n"),
    offset,
    status: session.status,
    exitCode: session.exitCode,
    // Explicit success flag so callers don't mistake a completed task for a crash
    ...(session.status === "exited" && { completedSuccessfully: session.exitCode === 0 }),
  };
}

export async function waitForOutput(
  sessionId: string,
  since?: number,
  timeoutMs: number = 30000
): Promise<{
  output: string;
  offset: number;
  status: SessionStatus;
  exitCode?: number | null;
  completedSuccessfully?: boolean;
}> {
  const deadline = Date.now() + timeoutMs;
  const startOffset = since ?? 0;

  while (Date.now() < deadline) {
    const session = sessions.get(sessionId);
    if (!session) throw new Error(`Session ${sessionId} not found`);

    const { lines, offset } = session.outputBuffer.getLines(startOffset);
    const hasNewOutput = lines.length > 0 && lines.some((l) => l.length > 0);
    const isDone = session.status !== "running";

    if (hasNewOutput || isDone) {
      return {
        output: lines.join("\n"),
        offset,
        status: session.status,
        exitCode: session.exitCode,
        ...(session.status === "exited" && { completedSuccessfully: session.exitCode === 0 }),
      };
    }

    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  // Timed out — return whatever we have
  return getSessionOutput(sessionId, startOffset);
}

export function listSessions(): SessionInfo[] {
  return Array.from(sessions.values()).map(toSessionInfo);
}

export function getSessionCwd(sessionId: string): string {
  const session = sessions.get(sessionId);
  if (!session) throw new Error(`Session ${sessionId} not found`);
  return session.cwd;
}

export function killSession(sessionId: string): SessionInfo {
  const session = sessions.get(sessionId);
  if (!session) throw new Error(`Session ${sessionId} not found`);

  if (session.process && session.status === "running") {
    session.process.kill("SIGTERM");

    // Force kill after 5 seconds
    setTimeout(() => {
      if (session.status === "running" && session.process) {
        try {
          session.process.kill("SIGKILL");
        } catch {
          // process may already be dead
        }
        session.status = "killed";
        session.process = null;
      }
    }, 5000);

    session.status = "killed";
    session.process = null;
  }

  return toSessionInfo(session);
}

function toSessionInfo(session: Session): SessionInfo {
  return {
    sessionId: session.sessionId,
    agent: session.agent,
    cwd: session.cwd,
    status: session.status,
    startedAt: session.startedAt,
    lastActivity: session.lastActivity,
    ...(session.exitCode != null && { exitCode: session.exitCode }),
    ...(session.status === "exited" && { completedSuccessfully: session.exitCode === 0 }),
  };
}
