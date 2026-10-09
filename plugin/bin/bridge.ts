// Diagnostics bridge for `tsc --lsp`.
//
// tsc 7 reports file diagnostics only on request (textDocument/diagnostic); it pushes
// publishDiagnostics for tsconfig files alone. Claude Code only listens for pushes.
// The bridge relays every frame unchanged and, after each didOpen/didChange/didSave,
// pulls diagnostics for all open documents and pushes them to the client.

import type { Readable, Writable } from "node:stream";
import { isObject, type JsonObject } from "./json.ts";

export type Endpoint = { output: Readable; input: Writable };

type DocumentEvent =
  | { kind: "open" | "change"; uri: string; version: number }
  | { kind: "save" }
  | { kind: "close"; uri: string };

type PullResult =
  | { kind: "published"; diagnostics: unknown[] }
  | { kind: "unchanged" }
  | { kind: "failed"; message: string };

const HEADER_END = Buffer.from("\r\n\r\n");
const OWN_ID_PREFIX = "ts-lsp-bridge:";

// Splits an LSP byte stream into frames; calls onFrame(rawFrame, parsedMessage).
function frameReader(onFrame: (raw: Buffer, message: JsonObject) => void): (chunk: Buffer) => void {
  let buf = Buffer.alloc(0);
  return (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
      const sep = buf.indexOf(HEADER_END);
      if (sep < 0) return;
      const length = Number(/Content-Length:\s*(\d+)/i.exec(buf.subarray(0, sep).toString("ascii"))?.[1]);
      if (!Number.isFinite(length)) throw new Error("LSP frame without Content-Length");
      const end = sep + HEADER_END.length + length;
      if (buf.length < end) return;
      const raw = buf.subarray(0, end);
      buf = buf.subarray(end);
      const message: unknown = JSON.parse(raw.subarray(sep + HEADER_END.length).toString("utf8"));
      if (!isObject(message)) throw new Error("LSP frame body is not a JSON object");
      onFrame(raw, message);
    }
  };
}

function frame(message: JsonObject): Buffer {
  const body = Buffer.from(JSON.stringify({ jsonrpc: "2.0", ...message }), "utf8");
  return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "ascii"), body]);
}

function parseDocumentEvent(message: JsonObject): DocumentEvent | undefined {
  const doc = isObject(message.params) ? message.params.textDocument : undefined;
  if (!isObject(doc) || typeof doc.uri !== "string") return undefined;
  switch (message.method) {
    case "textDocument/didOpen":
    case "textDocument/didChange":
      if (typeof doc.version !== "number") return undefined;
      return {
        kind: message.method === "textDocument/didOpen" ? "open" : "change",
        uri: doc.uri,
        version: doc.version,
      };
    case "textDocument/didSave":
      return { kind: "save" };
    case "textDocument/didClose":
      return { kind: "close", uri: doc.uri };
    default:
      return undefined;
  }
}

function parsePullResult(message: JsonObject): PullResult {
  if (isObject(message.error)) return { kind: "failed", message: String(message.error.message) };
  const result = message.result;
  if (isObject(result) && result.kind === "full" && Array.isArray(result.items)) {
    return { kind: "published", diagnostics: result.items };
  }
  return { kind: "unchanged" };
}

// Wires client <-> server streams through the bridge.
export function bridge({ client, server, log }: { client: Endpoint; server: Endpoint; log: (msg: string) => void }) {
  const open = new Map<string, number>(); // uri -> latest document version seen from the client
  const inFlight = new Map<string, { uri: string; version: number }>(); // own request id -> pulled document
  let nextId = 0;

  const pullOpenDocuments = () => {
    for (const [uri, version] of open) {
      const id = `${OWN_ID_PREFIX}${nextId++}`;
      inFlight.set(id, { uri, version });
      server.input.write(frame({ id, method: "textDocument/diagnostic", params: { textDocument: { uri } } }));
    }
  };

  // Claims the server's response to one of the bridge's own pulls; anything else belongs to the client.
  const takePull = (message: JsonObject) => {
    const id = message.id;
    if (typeof id !== "string" || "method" in message) return undefined;
    const pull = inFlight.get(id);
    inFlight.delete(id);
    return pull;
  };

  client.output.on(
    "data",
    frameReader((raw, message) => {
      server.input.write(raw);
      const event = parseDocumentEvent(message);
      switch (event?.kind) {
        case undefined:
          return;
        case "open":
        case "change":
          open.set(event.uri, event.version);
          return pullOpenDocuments();
        case "save":
          return pullOpenDocuments();
        case "close":
          open.delete(event.uri);
          return;
        default:
          return event satisfies never;
      }
    }),
  );

  server.output.on(
    "data",
    frameReader((raw, message) => {
      const pull = takePull(message);
      if (!pull) return void client.input.write(raw);
      const result = parsePullResult(message);
      switch (result.kind) {
        case "failed":
          return log(`diagnostic pull for ${pull.uri} failed: ${result.message}`);
        case "unchanged":
          return;
        case "published":
          // A newer edit has its own pull queued behind this one; publishing this would flash stale results.
          if (open.get(pull.uri) !== pull.version) return;
          client.input.write(
            frame({
              method: "textDocument/publishDiagnostics",
              params: { uri: pull.uri, diagnostics: result.diagnostics },
            }),
          );
          return;
        default:
          return result satisfies never;
      }
    }),
  );

  client.output.on("end", () => server.input.end());
}
