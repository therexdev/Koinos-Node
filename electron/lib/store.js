"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("node:crypto");
const { isDeepStrictEqual } = require("node:util");
const reserved = k => ["__proto__", "constructor", "prototype"].includes(k);

const isCriticalKoinosSettings = filePath =>
  path.basename(filePath) === "settings.json";

function parseFile(filePath) {
  const value = JSON.parse(fs.readFileSync(filePath, "utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Settings must be an object.");
  if (isCriticalKoinosSettings(filePath.replace(/\.last-good$/, "")) && Object.hasOwn(value, "producer")) {
    const p = value.producer;
    if (!p || !["local", "external"].includes(p.mode) || !p.addresses || typeof p.addresses !== "object" || Array.isArray(p.addresses)) throw new Error("Invalid producer custody settings.");
  }
  return value;
}

function atomicWrite(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${crypto.randomBytes(8).toString("hex")}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600, flag: "wx" });
    fs.renameSync(tmp, filePath);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

// Minimal JSON-file store with atomic, private writes.
//
// Koinos producer custody is security-sensitive: silently replacing an
// unreadable custody file with defaults can make an explicitly external/cold
// producer appear local after a restart. That one store therefore gets a
// verified last-known-good backup and a fail-closed health flag. Other stores
// keep the historical missing/corrupt -> defaults behavior.
class JsonStore {
  constructor(filePath, defaults = {}) {
    this.filePath = filePath;
    this.data = structuredClone(defaults);
    this.loadError = null;
    this.recoveredFromBackup = false;
    this.backupError = null;
    this.critical = isCriticalKoinosSettings(filePath);
    this.backupPath = this.critical ? `${filePath}.last-good` : null;

    const primaryExists = fs.existsSync(filePath);
    const backupExists = this.backupPath && fs.existsSync(this.backupPath);

    if (primaryExists) {
      try {
        this.data = deepMerge(structuredClone(defaults), parseFile(filePath));
      } catch (primaryError) {
        if (backupExists) {
          try {
            this.data = deepMerge(structuredClone(defaults), parseFile(this.backupPath));
            this.recoveredFromBackup = true;
            atomicWrite(this.filePath, this.data);
          } catch (backupError) {
            if (this.critical) {
              this.loadError = new Error(`Koinos node settings are unreadable and recovery failed: ${primaryError.message}; backup: ${backupError.message}`);
            }
          }
        } else if (this.critical) {
          this.loadError = new Error(`Koinos node settings are unreadable and no last-known-good backup exists: ${primaryError.message}`);
        }
      }
    } else if (backupExists) {
      try {
        this.data = deepMerge(structuredClone(defaults), parseFile(this.backupPath));
        this.recoveredFromBackup = true;
        atomicWrite(this.filePath, this.data);
      } catch (backupError) {
        if (this.critical) this.loadError = new Error(`Koinos node settings backup is unreadable: ${backupError.message}`);
      }
    }

    // Seed/refresh the recovery copy only from a verified primary. Failure to
    // refresh the backup does not invalidate a good primary; the prior backup
    // remains usable and health() exposes the backup warning for diagnostics.
    if (this.critical && !this.loadError && fs.existsSync(this.filePath)) {
      try {
        const verified = parseFile(this.filePath);
        atomicWrite(this.backupPath, verified);
      } catch (error) {
        this.backupError = error;
      }
    }
  }

  get(key, fallback) {
    const v = key.split(".").reduce((o, k) => (o == null || reserved(k) || !Object.hasOwn(o, k) ? undefined : o[k]), this.data);
    return v === undefined ? fallback : v;
  }

  set(key, value) {
    const parts = key.split(".");
    if (parts.some(p => !p || reserved(p))) throw new Error("Invalid settings path");
    if (this.loadError && key !== "producer") throw new Error("Producer custody settings are unresolved. Stop the node and save the intended custody mode first.");
    const before = structuredClone(this.data);
    let obj = this.data;
    for (const part of parts.slice(0, -1)) {
      if (!Object.hasOwn(obj, part) || typeof obj[part] !== "object" || obj[part] === null) obj[part] = {};
      obj = obj[part];
    }
    obj[parts[parts.length - 1]] = value;
    try {
      this.save();
      // A deliberate, verified save is also how a user repairs a previously
      // unreadable critical settings file by re-confirming custody mode.
      this.loadError = null;
    } catch (error) {
      this.data = before;
      throw error;
    }
  }

  all() {
    return this.data;
  }

  health() {
    return {
      ok: !this.loadError,
      error: this.loadError?.message || null,
      recoveredFromBackup: this.recoveredFromBackup,
      backupError: this.backupError?.message || null,
    };
  }

  save() {
    if (!this.critical) {
      atomicWrite(this.filePath, this.data);
      return;
    }

    // Preserve the previous verified primary before replacing it. If the new
    // write fails, there is still a known-good recovery point.
    if (fs.existsSync(this.filePath)) {
      try {
        const previous = parseFile(this.filePath);
        atomicWrite(this.backupPath, previous);
      } catch {
        // Never overwrite an existing last-known-good backup with bad input.
      }
    }

    atomicWrite(this.filePath, this.data);
    const reread = parseFile(this.filePath);
    if (!isDeepStrictEqual(reread, this.data)) {
      throw new Error("Koinos node settings verification failed after save.");
    }

    try {
      atomicWrite(this.backupPath, reread);
      const backupReread = parseFile(this.backupPath);
      if (!isDeepStrictEqual(backupReread, reread)) throw new Error("Last-known-good settings verification failed.");
      this.backupError = null;
    } catch (error) {
      // The verified primary is authoritative. Keep operating, but retain the
      // warning so diagnostics can say that redundancy needs attention.
      this.backupError = error;
    }
  }
}

function deepMerge(base, extra) {
  for (const [k, v] of Object.entries(extra || {})) {
    if (reserved(k)) continue;
    if (
      v &&
      typeof v === "object" &&
      !Array.isArray(v) &&
      base[k] &&
      typeof base[k] === "object" &&
      !Array.isArray(base[k])
    ) {
      base[k] = deepMerge({ ...base[k] }, v);
    } else {
      base[k] = v;
    }
  }
  return base;
}

module.exports = { JsonStore, deepMerge };
