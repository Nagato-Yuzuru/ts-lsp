// Drives the launcher over stdio the way Claude Code does: definition, references, hover,
// and pushed diagnostics after an edit, against a copy of test/fixture.

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isObject, type JsonObject } from "../plugin/bin/json.ts";

// Wire shapes this test reads. The server is trusted to send them; a wrong shape fails the run.
type Position = { line: number; character: number };
type Range = { start: Position; end: Position };
type Location = { uri: string; range: Range };
type LocationLink = { targetUri: string; targetSelectionRange: Range };
type Diagnostic = { code?: number | string; range: Range };
type Notification = { method: string; params: JsonObject };

export type SessionResult = {
  launcherLog: string;
  exitCode: number | null;
  definition: string[];
  references: string[];
  hover: string;
  diagnostics: string[];
};

export const launcher = fileURLToPath(new URL("../plugin/bin/launch.ts", import.meta.url));

const TIMEOUT_MS = 60_000;
const EDITED_B = 'import { greet } from "./a.js";\n\nexport const msg: number = greet(1);\n';

export async function runSession(project: string, env: NodeJS.ProcessEnv = process.env): Promise<SessionResult> {
  const srcDir = join(project, "src");
  const server = spawn(process.execPath, [launcher], {
    env: { ...env, CLAUDE_PROJECT_DIR: project },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const exited = new Promise<number | null>((r) => server.on("exit", (code) => r(code)));
  let launcherLog = "";
  server.stderr.on("data", (d: Buffer) => (launcherLog += d.toString()));

  let nextId = 1;
  const pending = new Map<number, (message: JsonObject) => void>();
  const notifications: Notification[] = [];
  let onNotification: (() => void) | undefined;
  let buf = Buffer.alloc(0);

  server.stdout.on("data", (chunk: Buffer) => {
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
      const sep = buf.indexOf("\r\n\r\n");
      if (sep < 0) return;
      const len = Number(/Content-Length: (\d+)/i.exec(buf.subarray(0, sep).toString())?.[1]);
      if (buf.length < sep + 4 + len) return;
      const msg: unknown = JSON.parse(buf.subarray(sep + 4, sep + 4 + len).toString());
      buf = buf.subarray(sep + 4 + len);
      if (!isObject(msg)) throw new Error("non-object LSP message");
      if (msg.id !== undefined && typeof msg.method === "string") {
        send({ id: msg.id, result: null }); // server->client request
      } else if (typeof msg.id === "number") {
        pending.get(msg.id)?.(msg);
      } else if (typeof msg.method === "string" && isObject(msg.params)) {
        notifications.push({ method: msg.method, params: msg.params });
        onNotification?.();
      }
    }
  });

  function send(msg: JsonObject) {
    const body = JSON.stringify({ jsonrpc: "2.0", ...msg });
    server.stdin.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
  }

  function request<T>(method: string, params?: JsonObject): Promise<T> {
    const id = nextId++;
    send({ id, method, params });
    return new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error(`${method} timed out`)), TIMEOUT_MS);
      pending.set(id, (m) => {
        clearTimeout(t);
        if (isObject(m.error)) rej(new Error(String(m.error.message)));
        else res(m.result as T); // see "Wire shapes" above
      });
    });
  }

  function waitFor(pred: (n: Notification) => boolean, what: string): Promise<Notification> {
    return new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error(`timed out waiting for ${what}`)), TIMEOUT_MS);
      const check = () => {
        const hit = notifications.find(pred);
        if (!hit) return;
        clearTimeout(t);
        onNotification = undefined;
        res(hit);
      };
      onNotification = check;
      check();
    });
  }

  const uri = (f: string) => pathToFileURL(join(srcDir, f)).href;
  const basename = (u: string) => u.split("/").pop() ?? u;
  try {
    await request("initialize", {
      processId: process.pid,
      rootUri: pathToFileURL(project).href,
      workspaceFolders: [{ uri: pathToFileURL(project).href, name: "p" }],
      capabilities: { textDocument: { publishDiagnostics: {}, hover: { contentFormat: ["markdown", "plaintext"] } } },
    });
    send({ method: "initialized", params: {} });
    for (const f of ["a.ts", "b.ts"]) {
      const text = readFileSync(join(srcDir, f), "utf8");
      send({
        method: "textDocument/didOpen",
        params: { textDocument: { uri: uri(f), languageId: "typescript", version: 1, text } },
      });
    }

    const at = { textDocument: { uri: uri("b.ts") }, position: { line: 2, character: 20 } }; // inside `greet` in the call
    const def = await request<Location | (Location | LocationLink)[]>("textDocument/definition", at);
    const definition = [def]
      .flat()
      .map((l) =>
        "targetUri" in l
          ? `${basename(l.targetUri)}:${l.targetSelectionRange.start.line}`
          : `${basename(l.uri)}:${l.range.start.line}`,
      );
    const refs = await request<Location[]>("textDocument/references", { ...at, context: { includeDeclaration: true } });
    const references = refs.map((l) => `${basename(l.uri)}:${l.range.start.line}`).sort();
    const hover = JSON.stringify((await request<{ contents: unknown } | null>("textDocument/hover", at))?.contents);

    send({
      method: "textDocument/didChange",
      params: { textDocument: { uri: uri("b.ts"), version: 2 }, contentChanges: [{ text: EDITED_B }] },
    });
    const diag = await waitFor(
      (n) =>
        n.method === "textDocument/publishDiagnostics" &&
        n.params.uri === uri("b.ts") &&
        Array.isArray(n.params.diagnostics) &&
        n.params.diagnostics.length > 0,
      "diagnostics on b.ts after edit",
    );
    const diagnostics = (diag.params.diagnostics as Diagnostic[]).map((d) => `TS${d.code}@${d.range.start.line}`);

    await request("shutdown");
    send({ method: "exit" });
    return { launcherLog, exitCode: await exited, definition, references, hover, diagnostics };
  } catch (err) {
    server.kill();
    throw new Error(`${err instanceof Error ? err.message : String(err)}\nlauncher stderr:\n${launcherLog}`, {
      cause: err,
    });
  }
}
