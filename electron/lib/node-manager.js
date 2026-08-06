"use strict";

const fs = require("fs");
const path = require("path");
const { execFile, spawn } = require("child_process");
const { NETWORKS } = require("./constants");

const OP_LOG_LIMIT = 400;

// Manages a per-network Koinos node directory containing the official
// docker-compose.yml plus generated .env and config files, and drives it
// through `docker compose`.
class NodeManager {
  constructor({ templateRoot, dataRoot, onEvent }) {
    this.templateRoot = templateRoot;
    this.dataRoot = dataRoot;
    this.onEvent = onEvent || (() => {});
    this._composeCmd = null;
    this._op = null; // { name, network, running, startedAt, lines, code, error }
  }

  dirs(networkId) {
    const root = path.join(this.dataRoot, networkId);
    return {
      root,
      config: path.join(root, "config"),
      basedir: path.join(root, "basedir"),
      producerKeyDir: path.join(root, "basedir", "block_producer"),
    };
  }

  // ---------- file generation ----------

  ensureFiles(networkId, producerAddress) {
    const net = NETWORKS[networkId];
    if (!net) throw new Error(`Unknown network: ${networkId}`);
    const d = this.dirs(networkId);
    fs.mkdirSync(d.config, { recursive: true });
    fs.mkdirSync(d.basedir, { recursive: true });

    const tpl = (...p) => path.join(this.templateRoot, ...p);
    fs.copyFileSync(tpl("docker-compose.yml"), path.join(d.root, "docker-compose.yml"));
    fs.copyFileSync(tpl("common", "koinos_descriptors.pb"), path.join(d.config, "koinos_descriptors.pb"));
    fs.copyFileSync(tpl("common", "rabbitmq.conf"), path.join(d.config, "rabbitmq.conf"));
    fs.copyFileSync(tpl(net.templateDir, "genesis_data.json"), path.join(d.config, "genesis_data.json"));

    fs.writeFileSync(path.join(d.config, "config.yml"), buildConfigYml(net, producerAddress));
    fs.writeFileSync(path.join(d.root, ".env"), buildEnv(net, d.basedir, !!producerAddress));
    return d;
  }

  filesReady(networkId) {
    const d = this.dirs(networkId);
    return (
      fs.existsSync(path.join(d.root, "docker-compose.yml")) &&
      fs.existsSync(path.join(d.config, "config.yml"))
    );
  }

  readProducerPublicKey(networkId) {
    try {
      const p = path.join(this.dirs(networkId).producerKeyDir, "public.key");
      const v = fs.readFileSync(p, "utf8").trim();
      return v || null;
    } catch {
      return null;
    }
  }

  // ---------- docker plumbing ----------

  _exec(bin, args, opts = {}) {
    return new Promise((resolve) => {
      execFile(
        bin,
        args,
        {
          timeout: opts.timeout ?? 30000,
          cwd: opts.cwd,
          maxBuffer: 8 * 1024 * 1024,
          env: process.env,
          windowsHide: true,
        },
        (error, stdout, stderr) =>
          resolve({
            ok: !error,
            stdout: String(stdout || ""),
            stderr: String(stderr || ""),
            error: error ? String(error.message).split("\n")[0] : null,
          })
      );
    });
  }

  async composeCmd() {
    if (this._composeCmd) return this._composeCmd;
    if ((await this._exec("docker", ["compose", "version"], { timeout: 15000 })).ok) {
      this._composeCmd = { bin: "docker", pre: ["compose"] };
    } else if ((await this._exec("docker-compose", ["version"], { timeout: 15000 })).ok) {
      this._composeCmd = { bin: "docker-compose", pre: [] };
    }
    return this._composeCmd;
  }

  async dockerInfo() {
    const info = await this._exec("docker", ["info", "--format", "{{.ServerVersion}}"], {
      timeout: 15000,
    });
    if (!info.ok) {
      const raw = `${info.stderr} ${info.error ?? ""}`.toLowerCase();
      const daemonDown = /connect|daemon|sock|pipe|permission|refused/.test(raw);
      const error = daemonDown
        ? "Docker is installed but the Docker engine isn't running (or isn't accessible). Start Docker and try again."
        : "Docker was not found. Install Docker Desktop (or Docker Engine + Compose).";
      return { ok: false, error };
    }
    if (!(await this.composeCmd())) {
      return { ok: false, error: "Docker Compose was not found (need `docker compose` v2 or `docker-compose`)." };
    }
    return { ok: true, serverVersion: info.stdout.trim() };
  }

  async _compose(networkId, args, opts = {}) {
    const cmd = await this.composeCmd();
    if (!cmd) throw new Error("Docker Compose not available");
    const net = NETWORKS[networkId];
    const d = this.dirs(networkId);
    return this._exec(cmd.bin, [...cmd.pre, "-p", net.composeProject, ...args], {
      cwd: d.root,
      ...opts,
    });
  }

  // Long-running compose command (up/down) with live output capture.
  async _composeOp(networkId, opName, args) {
    if (this._op?.running) {
      throw new Error(`Another node operation ("${this._op.name}") is still running`);
    }
    const cmd = await this.composeCmd();
    if (!cmd) throw new Error("Docker Compose not available");
    const net = NETWORKS[networkId];
    const d = this.dirs(networkId);
    const op = {
      name: opName,
      network: networkId,
      running: true,
      startedAt: Date.now(),
      finishedAt: null,
      lines: [],
      code: null,
      error: null,
    };
    this._op = op;
    const push = (chunk) => {
      for (const line of String(chunk).split(/\r?\n/)) {
        const t = line.trim();
        if (!t) continue;
        op.lines.push(t);
        if (op.lines.length > OP_LOG_LIMIT) op.lines.splice(0, op.lines.length - OP_LOG_LIMIT);
      }
    };
    this.onEvent({ type: "node", message: `${opName} started (${net.label})` });
    return new Promise((resolve) => {
      const child = spawn(cmd.bin, [...cmd.pre, "-p", net.composeProject, ...args], {
        cwd: d.root,
        env: process.env,
        windowsHide: true,
      });
      child.stdout.on("data", push);
      child.stderr.on("data", push);
      child.on("error", (e) => {
        op.running = false;
        op.finishedAt = Date.now();
        op.error = String(e.message);
        this.onEvent({ type: "node", level: "error", message: `${opName} failed: ${op.error}` });
        resolve(op);
      });
      child.on("close", (code) => {
        op.running = false;
        op.finishedAt = Date.now();
        op.code = code;
        if (code !== 0 && !op.error) {
          op.error = op.lines.slice(-3).join(" | ") || `exit code ${code}`;
        }
        this.onEvent({
          type: "node",
          level: code === 0 ? "info" : "error",
          message: code === 0 ? `${opName} finished` : `${opName} failed: ${op.error}`,
        });
        resolve(op);
      });
    });
  }

  // ---------- lifecycle ----------

  // producerAddress null -> sync-only node (no block_producer service).
  async start(networkId, producerAddress) {
    this.ensureFiles(networkId, producerAddress);
    // Fire and forget; callers poll status() / currentOp().
    this._composeOp(networkId, "start", ["up", "-d", "--remove-orphans"]);
    return { started: true };
  }

  async stop(networkId) {
    if (!this.filesReady(networkId)) return { stopped: true, note: "Node was never started" };
    this._composeOp(networkId, "stop", ["down"]);
    return { stopping: true };
  }

  currentOp() {
    if (!this._op) return null;
    const { lines, ...rest } = this._op;
    return { ...rest, tail: lines.slice(-15) };
  }

  async services(networkId) {
    if (!this.filesReady(networkId)) return [];
    const r = await this._compose(networkId, ["ps", "--format", "json"], { timeout: 20000 });
    if (!r.ok) return [];
    return parseComposePs(r.stdout);
  }

  async logs(networkId, service, tail = 120) {
    const args = ["logs", "--no-color", "--tail", String(Math.min(Number(tail) || 120, 1000))];
    if (service) args.push(String(service));
    const r = await this._compose(networkId, args, { timeout: 25000 });
    if (!r.ok) throw new Error(r.error || "Failed to read logs");
    return (r.stdout + (r.stderr ? `\n${r.stderr}` : "")).trim();
  }

  async status(networkId) {
    const docker = await this.dockerInfo();
    const services = docker.ok ? await this.services(networkId) : [];
    const running = services.filter((s) => /running|up/i.test(s.state)).length;
    return {
      docker,
      filesReady: this.filesReady(networkId),
      services,
      runningCount: running,
      isRunning: running > 0,
      producerPublicKey: this.readProducerPublicKey(networkId),
      op: this.currentOp(),
      dataDir: this.dirs(networkId).root,
    };
  }
}

function parseComposePs(stdout) {
  const rows = [];
  const text = stdout.trim();
  if (!text) return rows;
  // docker compose v2 emits one JSON object per line; older versions emit an array.
  let objects = [];
  try {
    const parsed = JSON.parse(text);
    objects = Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    for (const line of text.split("\n")) {
      try {
        objects.push(JSON.parse(line));
      } catch {
        /* skip non-JSON lines */
      }
    }
  }
  for (const o of objects) {
    rows.push({
      name: o.Name ?? o.name ?? "",
      service: o.Service ?? o.service ?? "",
      state: o.State ?? o.state ?? "",
      status: o.Status ?? o.status ?? "",
      health: o.Health ?? o.health ?? "",
    });
  }
  return rows;
}

function buildEnv(net, basedirAbs, producing) {
  const profiles = producing ? "jsonrpc,block_producer" : "jsonrpc";
  const lines = [
    "# Generated by Koinos Node Desktop — regenerated on every node start.",
    `BASEDIR=${basedirAbs}`,
    "",
    `AMQP_PORT=${net.ports.amqp}`,
    `AMQP_ADMIN_PORT=${net.ports.amqpAdmin}`,
    `P2P_PORT=${net.ports.p2p}`,
    `JSONRPC_PORT=${net.ports.jsonrpc}`,
    `GRPC_PORT=${net.ports.grpc}`,
    `REST_PORT=${net.ports.rest}`,
    "",
    `COMPOSE_PROFILES=${profiles}`,
    "",
    ...Object.entries(net.imageTags).map(([k, v]) => `${k}=${v}`),
    "",
  ];
  return lines.join("\n");
}

function buildConfigYml(net, producerAddress) {
  const producerLines = producerAddress
    ? `  producer: ${producerAddress}                # Address that receives block rewards (this app's wallet)`
    : `  # producer:                                 # Set automatically when block production is enabled`;
  const seeds = net.p2pSeeds.map((s) => `    - ${s}`).join("\n");
  return `# Generated by Koinos Node Desktop — based on koinos/koinos config-example.
# Regenerated on every node start; manual edits will be overwritten.

global:
  amqp: amqp://guest:guest@amqp:5672/
  log-level: info
  log-color: false
  log-datetime: true
  log-dir: logs
  instance-id: KoinosDesktop
  fork-algorithm: pob
  blacklist:
    - block_store.add_block
    - chain.propose_block

block_producer:
  algorithm: pob
${producerLines}

grpc:
  endpoint: 0.0.0.0:50051

jsonrpc:
  listen: /tcp/8080

p2p:
  listen: /ip4/0.0.0.0/tcp/8888
  peer:
${seeds}
`;
}

module.exports = { NodeManager, buildEnv, buildConfigYml, parseComposePs };
