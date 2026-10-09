#!/usr/bin/env node
// Starts the TypeScript language server that matches the project's TypeScript:
// TS >= 7 ships its own LSP (`tsc --lsp --stdio`) and no tsserver.js, while
// TS <= 6 is served by typescript-language-server, which drives tsserver.js.
//
// tsc 7 only answers diagnostic pulls, so its traffic runs through bridge.ts.
//
// stdout belongs to the LSP protocol; everything this script says goes to stderr.

import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { bridge } from "./bridge.ts";
import { isObject } from "./json.ts";

type Command = { file: string; args: string[] };

type Server = { kind: "tsc" | "typescript-language-server"; source: string; command: Command };

type Package = { dir: string; name: string; version: string; bin: unknown };

const log = (msg: string) => process.stderr.write(`ts-lsp: ${msg}\n`);

function parsePackage(manifest: string): Package {
  const pkg: unknown = JSON.parse(readFileSync(manifest, "utf8"));
  if (!isObject(pkg) || typeof pkg.name !== "string" || typeof pkg.version !== "string") {
    throw new Error(`${manifest} lacks name or version`);
  }
  return { dir: dirname(manifest), name: pkg.name, version: pkg.version, bin: pkg.bin };
}

// Walks up from `from` to the nearest node_modules/<name>, the way Node resolves it.
function findPackage(name: string, from: string): Package | undefined {
  for (let dir = from; ; dir = dirname(dir)) {
    const manifest = join(dir, "node_modules", name, "package.json");
    if (existsSync(manifest)) return parsePackage(manifest);
    if (dirname(dir) === dir) return undefined;
  }
}

// Runs a package's bin script with this Node, bypassing node_modules/.bin shims.
function binCommand(pkg: Package, bin: string, args: string[]): Command {
  const rel = typeof pkg.bin === "string" ? pkg.bin : isObject(pkg.bin) ? pkg.bin[bin] : undefined;
  if (typeof rel !== "string") throw new Error(`${pkg.name}@${pkg.version} declares no "${bin}" bin`);
  return { file: process.execPath, args: [join(pkg.dir, rel), ...args] };
}

const major = (version: string) => Number.parseInt(version, 10);

const TSC_ARGS = ["--lsp", "--stdio"];
const TLS_ARGS = ["--stdio"];

function resolveServer(root: string): Server {
  const ts = findPackage("typescript", root);
  if (ts) {
    const source = `project TypeScript ${ts.version} at ${ts.dir}`;
    if (major(ts.version) >= 7) return { kind: "tsc", source, command: binCommand(ts, "tsc", TSC_ARGS) };
    const tls = findPackage("typescript-language-server", root);
    const command = tls
      ? binCommand(tls, "typescript-language-server", TLS_ARGS)
      : { file: "typescript-language-server", args: TLS_ARGS };
    return { kind: "typescript-language-server", source, command };
  }

  const probe = spawnSync("tsc", ["--version"], { encoding: "utf8" });
  const version = probe.stdout?.match(/Version (\d+\.\S+)/)?.[1];
  if (version && major(version) >= 7) {
    return { kind: "tsc", source: `global tsc ${version}`, command: { file: "tsc", args: TSC_ARGS } };
  }
  return {
    kind: "typescript-language-server",
    source: version ? `global tsc ${version}` : "no TypeScript found",
    command: { file: "typescript-language-server", args: TLS_ARGS },
  };
}

function start(server: Server): ChildProcess {
  const { file, args } = server.command;
  switch (server.kind) {
    case "typescript-language-server":
      return spawn(file, args, { stdio: "inherit" });
    case "tsc": {
      const child = spawn(file, args, { stdio: ["pipe", "pipe", "inherit"] });
      bridge({
        client: { output: process.stdin, input: process.stdout },
        server: { output: child.stdout, input: child.stdin },
        log,
      });
      return child;
    }
    default:
      return server.kind satisfies never;
  }
}

const server = resolveServer(process.env.CLAUDE_PROJECT_DIR || process.cwd());
const { file, args } = server.command;
log(`${server.source} -> ${[file, ...args].join(" ")}${server.kind === "tsc" ? " (diagnostics bridged)" : ""}`);

const child = start(server);

child.on("error", (err) => {
  log(`failed to start ${file}: ${err.message}`);
  if (server.kind === "typescript-language-server") {
    log("install it in the project (pnpm add -D typescript-language-server) or globally");
  }
  process.exit(127);
});

const forwarded: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"];
for (const sig of forwarded) process.on(sig, () => child.kill(sig));

child.on("exit", (code, signal) => {
  if (signal) {
    for (const sig of forwarded) process.removeAllListeners(sig);
    process.kill(process.pid, signal);
  } else {
    process.exit(code ?? 1);
  }
});
