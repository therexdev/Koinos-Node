"use strict";

const fs = require("fs");
const path = require("path");
const https = require("https");
const crypto = require("crypto");
const { execFile, spawn } = require("child_process");
const { NETWORKS } = require("./constants");
const { parseSha256File, analyzeMembers, requiredSpace, fmtBytes } = require("./quicksync-utils");

const OP_LOG_LIMIT = 400;
const ARCHIVE_NAME = "koinos-backup.tar.gz";

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

  // ---------- quick sync (restore from the official chain backup) ----------

  restoreDir(networkId) {
    return path.join(this.dirs(networkId).root, "restore");
  }

  async quickSyncInfo(networkId) {
    const net = NETWORKS[networkId];
    if (!net?.backup) throw new Error("Quick sync is only available on mainnet");
    const head = await httpHead(net.backup.url);
    let freeBytes = null;
    try {
      fs.mkdirSync(this.dataRoot, { recursive: true });
      const s = fs.statfsSync(this.dataRoot);
      freeBytes = Number(s.bavail) * Number(s.bsize);
    } catch {
      /* stat not available on this platform */
    }
    let metadata = null;
    try {
      metadata = (await httpGetText(net.backup.metadataUrl)).slice(0, 1500);
    } catch {
      /* metadata is informative only */
    }
    let resumeFrom = 0;
    try {
      resumeFrom = fs.statSync(path.join(this.restoreDir(networkId), ARCHIVE_NAME)).size;
    } catch {
      /* no partial download */
    }
    const services = await this.services(networkId).catch(() => []);
    return {
      archiveBytes: head.size,
      lastModified: head.lastModified,
      resumeFrom,
      freeBytes,
      requiredBytes: requiredSpace(head.size),
      metadata,
      nodeRunning: services.some((s) => /running|up/i.test(s.state)),
    };
  }

  // Fire-and-forget; progress is exposed through currentOp() like start/stop.
  async quickSync(networkId) {
    const net = NETWORKS[networkId];
    if (!net?.backup) throw new Error("Quick sync is only available on mainnet");
    if (this._op?.running) {
      throw new Error(`Another node operation ("${this._op.name}") is still running`);
    }
    const op = {
      name: "quick-sync",
      network: networkId,
      running: true,
      startedAt: Date.now(),
      finishedAt: null,
      lines: [],
      code: null,
      error: null,
      progress: { stage: "starting", pct: null },
    };
    this._op = op;
    this._qsAbort = new AbortController();
    this._runQuickSync(networkId, net, op)
      .then(() => {
        op.running = false;
        op.finishedAt = Date.now();
        op.code = 0;
        this.onEvent({
          type: "node",
          message: "Quick sync complete — chain data restored from backup. Start the node to catch up to head.",
        });
      })
      .catch((e) => {
        op.running = false;
        op.finishedAt = Date.now();
        op.code = 1;
        op.error = String(e?.message ?? e);
        this.onEvent({ type: "node", level: "error", message: `Quick sync failed: ${op.error}` });
      });
    return { started: true };
  }

  cancelQuickSync() {
    if (this._op?.name === "quick-sync" && this._op.running) {
      this._qsAbort?.abort();
      return { cancelling: true };
    }
    return { cancelling: false };
  }

  async _runQuickSync(networkId, net, op) {
    const signal = this._qsAbort.signal;
    const say = (stage, line, pct = null, extra = {}) => {
      op.progress = { stage, pct, ...extra };
      if (line) {
        op.lines.push(line);
        if (op.lines.length > OP_LOG_LIMIT) op.lines.splice(0, op.lines.length - OP_LOG_LIMIT);
      }
      if (signal.aborted) throw new Error("Cancelled");
    };
    const d = this.dirs(networkId);
    const restoreDir = this.restoreDir(networkId);
    const archivePath = path.join(restoreDir, ARCHIVE_NAME);
    const stagingDir = path.join(restoreDir, "extracted");
    fs.mkdirSync(restoreDir, { recursive: true });
    fs.mkdirSync(d.basedir, { recursive: true }); // never touches config/.env — a producer setup stays intact

    // 1. Stop the node if it's running.
    say("stopping", "Stopping the node (if running)…");
    const running = (await this.services(networkId).catch(() => [])).some((s) =>
      /running|up/i.test(s.state)
    );
    if (running) {
      const r = await this._compose(networkId, ["stop"], { timeout: 180000 });
      if (!r.ok) throw new Error(`Could not stop the node: ${r.error}`);
      say("stopping", "Node stopped.");
    }

    // 2. Download checksum + archive (with resume).
    say("download", "Fetching published checksum…");
    const publishedSha = parseSha256File(await httpGetText(net.backup.sha256Url));
    const head = await httpHead(net.backup.url);
    let from = 0;
    try {
      const st = fs.statSync(archivePath);
      // Resume only when the remote file is unchanged and we have less than all of it.
      const marker = readJson(path.join(restoreDir, "download.json"));
      if (marker?.etag === head.etag && st.size <= head.size) {
        from = st.size;
      } else {
        fs.rmSync(archivePath, { force: true });
      }
    } catch {
      /* no partial file */
    }
    writeJson(path.join(restoreDir, "download.json"), { etag: head.etag, size: head.size });
    if (from < head.size) {
      say("download", from > 0
        ? `Resuming download at ${fmtBytes(from)} of ${fmtBytes(head.size)}…`
        : `Downloading chain backup (${fmtBytes(head.size)}) — this is a large file…`);
      await httpDownload(net.backup.url, archivePath, {
        resumeFrom: from,
        signal,
        onProgress: (done, total) => {
          op.progress = {
            stage: "download",
            pct: (done / total) * 100,
            doneBytes: done,
            totalBytes: total,
          };
        },
      });
    }
    say("download", "Download complete.");

    // 3. Verify the checksum.
    say("verify", "Verifying SHA-256 checksum (reads the whole archive)…");
    const actualSha = await sha256File(archivePath, (done, total) => {
      op.progress = { stage: "verify", pct: (done / total) * 100 };
      if (signal.aborted) throw new Error("Cancelled");
    });
    if (actualSha !== publishedSha) {
      fs.rmSync(archivePath, { force: true });
      throw new Error("Checksum mismatch — the downloaded backup was corrupt and has been deleted. Run quick sync again.");
    }
    say("verify", "Checksum OK.");

    // 4. List members and validate the layout (never extract blindly).
    say("inspect", "Inspecting archive contents (decompresses once, takes a while)…");
    const list = await this._exec("tar", ["-tzf", archivePath], {
      timeout: 3 * 3600 * 1000,
      maxBuffer: 128 * 1024 * 1024,
    });
    if (!list.ok) throw new Error(`Could not list the archive: ${list.error}`);
    const layout = analyzeMembers(list.stdout);
    if (!layout.ok) {
      throw new Error(`${layout.error}. The published backup layout changed — restore manually per docs.koinos.io.`);
    }
    say("inspect", `Archive layout OK (prefix "${layout.prefix || "(none)"}").`);

    // 5. Extract only chain/ and block_store/ into staging.
    say("extract", "Extracting chain and block_store (can take a long time)…");
    fs.rmSync(stagingDir, { recursive: true, force: true });
    fs.mkdirSync(stagingDir, { recursive: true });
    const ex = await this._exec(
      "tar",
      ["-xzf", archivePath, "-C", stagingDir, `${layout.prefix}chain`, `${layout.prefix}block_store`],
      { timeout: 6 * 3600 * 1000, maxBuffer: 16 * 1024 * 1024 }
    );
    if (!ex.ok) throw new Error(`Extraction failed: ${ex.error} ${ex.stderr.slice(-300)}`);
    const stagedChain = path.join(stagingDir, ...`${layout.prefix}chain`.split("/").filter(Boolean));
    const stagedBlockStore = path.join(stagingDir, ...`${layout.prefix}block_store`.split("/").filter(Boolean));
    if (!fs.existsSync(stagedChain) || !fs.existsSync(stagedBlockStore)) {
      throw new Error("Extraction finished but chain/ or block_store/ is missing from staging");
    }

    // 6. Move current state aside (rollback dir), then install the staged data.
    // p2p identity, config, .env and wallets are never touched.
    say("install", "Installing restored chain data…");
    const rollback = path.join(restoreDir, `previous-${new Date().toISOString().replace(/[:.]/g, "-")}`);
    fs.mkdirSync(rollback, { recursive: true });
    for (const dir of ["chain", "block_store", "mempool", "transaction_store", "account_history", "contract_meta_store"]) {
      const src = path.join(d.basedir, dir);
      if (fs.existsSync(src)) fs.renameSync(src, path.join(rollback, dir));
    }
    fs.renameSync(stagedChain, path.join(d.basedir, "chain"));
    fs.renameSync(stagedBlockStore, path.join(d.basedir, "block_store"));

    // 7. Clean up what's no longer needed (keep the rollback copy).
    say("cleanup", "Cleaning up download and staging files…");
    fs.rmSync(stagingDir, { recursive: true, force: true });
    fs.rmSync(archivePath, { force: true });
    fs.rmSync(path.join(restoreDir, "download.json"), { force: true });
    say("done", `Done. Previous state kept in ${rollback} — delete it once the node runs fine.`, 100);
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

// ---------- plain-https helpers (no extra dependencies) ----------

function requestWithRedirects(url, options, maxRedirects = 5) {
  return new Promise((resolve, reject) => {
    const go = (target, redirectsLeft) => {
      const req = https.request(target, options, (res) => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
          res.resume();
          if (redirectsLeft <= 0) return reject(new Error("Too many redirects"));
          return go(new URL(res.headers.location, target).toString(), redirectsLeft - 1);
        }
        resolve(res);
      });
      req.on("error", reject);
      if (options.signal) {
        options.signal.addEventListener("abort", () => req.destroy(new Error("Cancelled")), { once: true });
      }
      req.end();
    };
    go(url, maxRedirects);
  });
}

async function httpHead(url) {
  const res = await requestWithRedirects(url, { method: "HEAD", timeout: 30000 });
  res.resume();
  if (res.statusCode !== 200) throw new Error(`Backup host returned HTTP ${res.statusCode}`);
  return {
    size: Number(res.headers["content-length"] ?? 0),
    lastModified: res.headers["last-modified"] ?? null,
    etag: res.headers.etag ?? null,
    acceptRanges: /bytes/.test(res.headers["accept-ranges"] ?? ""),
  };
}

async function httpGetText(url) {
  const res = await requestWithRedirects(url, { method: "GET", timeout: 30000 });
  if (res.statusCode !== 200) {
    res.resume();
    throw new Error(`HTTP ${res.statusCode} fetching ${url}`);
  }
  let data = "";
  res.setEncoding("utf8");
  for await (const chunk of res) {
    data += chunk;
    if (data.length > 1024 * 1024) break;
  }
  return data;
}

async function httpDownload(url, dest, { resumeFrom = 0, onProgress, signal }) {
  const headers = resumeFrom > 0 ? { Range: `bytes=${resumeFrom}-` } : {};
  const res = await requestWithRedirects(url, { method: "GET", headers, signal });
  if (resumeFrom > 0 && res.statusCode !== 206) {
    // Server ignored the range; start over.
    res.resume();
    if (res.statusCode === 200) {
      fs.rmSync(dest, { force: true });
      return httpDownload(url, dest, { resumeFrom: 0, onProgress, signal });
    }
    throw new Error(`Backup host returned HTTP ${res.statusCode}`);
  }
  if (resumeFrom === 0 && res.statusCode !== 200) {
    res.resume();
    throw new Error(`Backup host returned HTTP ${res.statusCode}`);
  }
  const total = resumeFrom + Number(res.headers["content-length"] ?? 0);
  let done = resumeFrom;
  await new Promise((resolve, reject) => {
    const out = fs.createWriteStream(dest, { flags: resumeFrom > 0 ? "a" : "w" });
    let lastTick = 0;
    res.on("data", (chunk) => {
      done += chunk.length;
      const now = Date.now();
      if (onProgress && now - lastTick > 500) {
        lastTick = now;
        onProgress(done, total);
      }
    });
    res.on("error", reject);
    out.on("error", reject);
    out.on("finish", resolve);
    res.pipe(out);
  });
  onProgress?.(done, total);
  return { size: done };
}

function sha256File(filePath, onProgress) {
  return new Promise((resolve, reject) => {
    const total = fs.statSync(filePath).size;
    const hash = crypto.createHash("sha256");
    const stream = fs.createReadStream(filePath);
    let done = 0;
    let lastTick = 0;
    stream.on("data", (chunk) => {
      hash.update(chunk);
      done += chunk.length;
      const now = Date.now();
      if (onProgress && now - lastTick > 500) {
        lastTick = now;
        try {
          onProgress(done, total);
        } catch (e) {
          stream.destroy(e);
        }
      }
    });
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

function readJson(p) {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

function writeJson(p, v) {
  fs.writeFileSync(p, JSON.stringify(v));
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
