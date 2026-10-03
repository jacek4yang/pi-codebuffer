import { randomUUID } from "node:crypto";
import {
  mkdirSync,
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  unlinkSync,
  rmdirSync,
} from "node:fs";
import { join } from "node:path";
import { compileEdit, applyIR, type EditRequest } from "./edit.js";
import { bytes, hash, revision, type Materialized } from "./state.js";

export interface Limits {
  scratchBytes: number;
  successes: number;
  failures: number;
  revisions: number;
  ttlMs: number;
}
export const defaults: Limits = {
  scratchBytes: 64 * 1024 * 1024,
  successes: 4,
  failures: 16,
  revisions: 8,
  ttlMs: 86400000,
};
export type Execution =
  "not_started" | "running" | "completed" | "failed" | "interrupted";
export interface Scratch {
  version: 1;
  ref: string;
  session: string;
  anchor: string | null;
  updated: number;
  pid: number;
  execution: Execution;
  delegated: boolean;
  revisions: Materialized[];
}
type RecordInfo = Omit<Scratch, "revisions"> & {
  base: string;
  diskBytes: number;
};
function recordInfo(r: Scratch, diskBytes: number): RecordInfo {
  return {
    version: r.version,
    ref: r.ref,
    session: r.session,
    anchor: r.anchor,
    updated: r.updated,
    pid: r.pid,
    execution: r.execution,
    delegated: r.delegated,
    base: r.revisions.at(-1)!.metadata.id,
    diskBytes,
  };
}
const identifier = /^[a-f0-9-]{36}$/;
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code !== "ESRCH";
  }
}
/** Private source store only. Never records outputs or replays execution. */
export class ScratchStore {
  constructor(
    readonly root: string,
    readonly limits: Limits = defaults,
  ) {}
  private index = new Map<string, { signature: string; info: RecordInfo }>();
  readonly metrics = { scans: 0, scanMs: 0, recordReads: 0, parseMs: 0 };
  private signature(path: string): string {
    this.secure(path, false);
    const s = lstatSync(path, { bigint: true });
    return [
      s.dev,
      s.ino,
      s.size,
      s.mtimeNs,
      s.ctimeNs,
      s.mode,
      s.uid,
      s.nlink,
    ].join(":");
  }
  private secure(path: string, directory: boolean): void {
    const s = lstatSync(path);
    if (
      s.isSymbolicLink() ||
      (directory ? !s.isDirectory() : !s.isFile()) ||
      (!directory && s.nlink !== 1) ||
      (s.mode & 0o077) !== 0 ||
      s.uid !== process.getuid?.()
    )
      throw new Error("UNSAFE_SCRATCH_PATH");
  }
  private path(ref: string): string {
    if (!identifier.test(ref)) throw new Error("SOURCE_EXPIRED");
    return join(this.root, ref + ".json");
  }
  private locked<T>(fn: () => T): T {
    // POSIX private mode verified. Windows ACLs cannot be established by Node mode.
    if (process.platform === "win32")
      throw new Error(
        "INCOMPATIBLE_SCRATCH_ACL: Windows scratch storage is not yet supported; legacy named buffers remain available",
      );
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    this.secure(this.root, true);
    const marker = join(this.root, ".pi-codebuffer-store-v1");
    if (!existsSync(marker)) {
      if (readdirSync(this.root).length)
        throw new Error(
          "SCRATCH_RECOVERY_REQUIRED: nonempty unmarked directory; not owned by CodeBuffer",
        );
      try {
        writeFileSync(marker, "pi-codebuffer scratch store v1\n", {
          flag: "wx",
          mode: 0o600,
        });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
    }
    this.secure(marker, false);
    if (readFileSync(marker, "utf8") !== "pi-codebuffer scratch store v1\n")
      throw new Error("UNSAFE_SCRATCH_PATH: ownership marker mismatch");
    const lock = join(this.root, "lock");
    try {
      mkdirSync(lock, { mode: 0o700 });
    } catch {
      this.secure(lock, true);
      const owner = join(lock, "owner");
      try {
        this.secure(owner, false);
      } catch {
        throw new Error(
          "SCRATCH_RECOVERY_REQUIRED: incomplete lock; inspect before removing",
        );
      }
      const pid = Number(readFileSync(owner, "utf8"));
      if (!Number.isSafeInteger(pid) || pid < 1 || alive(pid))
        throw new Error("SCRATCH_BUSY: another process owns the store");
      throw new Error(
        "SCRATCH_RECOVERY_REQUIRED: stale lock; stop owners and inspect before manual removal. Automatic lock reclamation is unsafe across processes.",
      );
    }
    const owner = join(lock, "owner");
    writeFileSync(owner, String(process.pid), { flag: "wx", mode: 0o600 });
    try {
      return fn();
    } finally {
      unlinkSync(owner);
      rmdirSync(lock);
    }
  }
  private scan(): RecordInfo[] {
    const started = performance.now();
    this.metrics.scans++;
    const names = readdirSync(this.root);
    if (names.length > 1027)
      throw new Error("SCRATCH_QUOTA: too many store entries");
    const records: RecordInfo[] = [];
    const present = new Set(
      names.filter((n) => n.endsWith(".json")).map((n) => n.slice(0, -5)),
    );
    for (const ref of this.index.keys())
      if (!present.has(ref)) this.index.delete(ref);
    let storageBytes = 0;
    for (const n of names) {
      if (n === "lock" || n === ".pi-codebuffer-store-v1") continue;
      if (!/^[a-f0-9-]{36}\.json$/.test(n))
        throw new Error(
          "SCRATCH_RECOVERY_REQUIRED: unexpected store file " + n,
        );
      const p = join(this.root, n);
      this.secure(p, false);
      const size = lstatSync(p).size;
      storageBytes += size;
      if (
        size > this.limits.scratchBytes ||
        storageBytes > this.limits.scratchBytes
      )
        throw new Error(
          "SCRATCH_QUOTA: stored data exceed configured quota; restore previous quota or inspect store",
        );
      const signature = this.signature(p);
      let cached = this.index.get(n.slice(0, -5));
      if (!cached || cached.signature !== signature) {
        const r = this.load(n.slice(0, -5));
        if (this.signature(p) !== signature)
          throw new Error("SCRATCH_BUSY: record changed during scan");
        cached = { signature, info: recordInfo(r, size) };
        this.index.set(r.ref, cached);
      }
      const info = { ...cached.info };
      if (info.execution === "running" && !alive(info.pid))
        info.execution = "interrupted";
      records.push(info);
    }
    this.metrics.scanMs += performance.now() - started;
    return records;
  }
  private load(ref: string): Scratch {
    const p = this.path(ref);
    const signature = this.signature(p);
    const started = performance.now();
    this.metrics.recordReads++;
    let r: Scratch;
    try {
      r = JSON.parse(readFileSync(p, "utf8")) as Scratch;
    } catch {
      throw new Error("SCRATCH_CORRUPT: invalid record JSON");
    }
    if (
      !r ||
      r.version !== 1 ||
      ref !== r.ref ||
      typeof r.session !== "string" ||
      r.session.length > 4096 ||
      (r.anchor !== null &&
        (typeof r.anchor !== "string" || r.anchor.length > 4096)) ||
      !Number.isFinite(r.updated) ||
      !Number.isSafeInteger(r.pid) ||
      r.pid < 1 ||
      ![
        "not_started",
        "running",
        "completed",
        "failed",
        "interrupted",
      ].includes(r.execution) ||
      typeof r.delegated !== "boolean" ||
      !Array.isArray(r.revisions) ||
      !r.revisions.length ||
      r.revisions.length > this.limits.revisions
    )
      throw new Error("SCRATCH_CORRUPT");
    for (const v of r.revisions)
      if (
        !v ||
        typeof v.source !== "string" ||
        !v.metadata ||
        !identifier.test(v.metadata.id) ||
        v.metadata.name !== "scratch" ||
        !Number.isSafeInteger(v.metadata.revision) ||
        v.metadata.revision < 1 ||
        bytes(v.source) > 262144 ||
        hash(v.source) !== v.metadata.hash
      )
        throw new Error("SCRATCH_CORRUPT");
    if (r.execution === "running" && !alive(r.pid)) r.execution = "interrupted";
    if (this.signature(p) !== signature)
      throw new Error("SCRATCH_BUSY: record changed during read");
    this.metrics.parseMs += performance.now() - started;
    return r;
  }
  private save(r: Scratch): void {
    const p = this.path(r.ref);
    const temp = join(this.root, "pending");
    writeFileSync(temp, JSON.stringify(r), { mode: 0o600, flag: "wx" });
    try {
      renameSync(temp, p);
    } catch (e) {
      unlinkSync(temp);
      throw e;
    }
    this.index.set(r.ref, {
      signature: this.signature(p),
      info: recordInfo(r, lstatSync(p).size),
    });
  }
  private reserve(records: RecordInfo[], candidate: Scratch): void {
    const now = Date.now();
    const size = (r: RecordInfo) => r.diskBytes;
    // Include old+new simultaneous atomic-replacement storage and settlement headroom.
    const previous = records.find((r) => r.ref === candidate.ref);
    let total =
      records
        .filter((r) => r.ref !== candidate.ref)
        .reduce((n, r) => n + 2 * size(r), 0) +
      2 *
        Math.max(
          previous ? size(previous) : 0,
          bytes(JSON.stringify(candidate)),
        ) +
      4096;
    const removable = records
      .filter((r) => r.ref !== candidate.ref && r.execution !== "running")
      .sort(
        (a, b) =>
          Number(a.execution !== "completed") -
            Number(b.execution !== "completed") || a.updated - b.updated,
      );
    const local = records.filter(
      (r) => r.session === candidate.session && r.ref !== candidate.ref,
    );
    let successes =
      local.filter((r) => r.execution === "completed").length +
      Number(candidate.execution === "completed");
    let failures =
      local.filter((r) => r.execution !== "completed").length +
      Number(candidate.execution !== "completed");
    let count = records.filter((r) => r.ref !== candidate.ref).length + 1;
    const evictions: RecordInfo[] = [];
    for (const r of removable) {
      const same = r.session === candidate.session;
      if (
        now - r.updated <= this.limits.ttlMs &&
        total <= this.limits.scratchBytes &&
        count <= 1024 &&
        !(
          same &&
          (r.execution === "completed"
            ? successes > this.limits.successes
            : failures > this.limits.failures)
        )
      )
        continue;
      evictions.push(r);
      total -= 2 * size(r);
      count--;
      if (same) {
        if (r.execution === "completed") successes--;
        else failures--;
      }
    }
    if (
      total > this.limits.scratchBytes ||
      count > 1024 ||
      successes > this.limits.successes ||
      failures > this.limits.failures
    )
      throw new Error(
        "SCRATCH_QUOTA: protected sources fill capacity; release a retained handle or wait for active executions",
      );
    for (const r of evictions) {
      unlinkSync(this.path(r.ref));
      this.index.delete(r.ref);
    }
  }
  create(session: string, anchor: string | null, source: string): Scratch {
    if (session.length > 4096 || (anchor !== null && anchor.length > 4096))
      throw new Error("INVALID_SCRATCH_IDENTITY");
    const v = revision("scratch", source);
    delete v.source;
    return this.locked(() => {
      const r: Scratch = {
        version: 1,
        ref: randomUUID(),
        session,
        anchor,
        updated: Date.now(),
        pid: process.pid,
        execution: v.syntax.valid ? "running" : "failed",
        delegated: false,
        revisions: [{ metadata: v, source }],
      };
      this.reserve(this.scan(), r);
      this.save(r);
      return r;
    });
  }
  repair(request: {
    ref: string;
    session: string;
    ancestry: Set<string>;
    base: string;
    edit: EditRequest;
    run: boolean;
    rerun?: "from-start";
    anchor: string | null;
  }): Scratch {
    return this.locked(() => {
      const records = this.scan();
      const found = records.find((r) => r.ref === request.ref);
      const old = found ? this.load(found.ref) : undefined;
      if (
        !old ||
        old.session !== request.session ||
        (old.anchor !== null && !request.ancestry.has(old.anchor)) ||
        (old.execution !== "running" &&
          Date.now() - old.updated > this.limits.ttlMs)
      )
        throw new Error("SOURCE_EXPIRED");
      if (old.execution === "running") throw new Error("SCRATCH_BUSY");
      const value = old.revisions.at(-1)!;
      if (value.metadata.id !== request.base)
        throw new Error("STALE_REVISION: current " + value.metadata.id);
      if (request.run && old.delegated && request.rerun !== "from-start")
        throw new Error(
          "RERUN_ACK_REQUIRED: repair runs from the beginning; include rerun: from-start after reviewing effects",
        );
      const ir = compileEdit(value.source, request.edit);
      const source = applyIR(value.source, ir);
      const next = {
        metadata: revision("scratch", source, value, undefined, ir),
        source,
      };
      const r: Scratch = {
        ...old,
        anchor: request.anchor,
        updated: Date.now(),
        pid: process.pid,
        execution:
          request.run && next.metadata.syntax.valid ? "running" : "not_started",
        revisions: [...old.revisions, next].slice(-this.limits.revisions),
      };
      this.reserve(records, r);
      this.save(r);
      return r;
    });
  }
  get(ref: string, session: string, ancestry: Set<string>): Scratch {
    return this.locked(() => {
      const r = this.scan().find((r) => r.ref === ref);
      if (
        !r ||
        r.session !== session ||
        (r.anchor !== null && !ancestry.has(r.anchor)) ||
        (r.execution !== "running" &&
          Date.now() - r.updated > this.limits.ttlMs)
      )
        throw new Error(
          "SOURCE_EXPIRED: use explicit read/recreation from your own history, or promote useful source before expiry",
        );
      return this.load(r.ref);
    });
  }
  update(r: Scratch, expected: string): void {
    this.locked(() => {
      const all = this.scan();
      const old = all.find((x) => x.ref === r.ref);
      if (!old) throw new Error("SOURCE_EXPIRED");
      if (old.base !== expected) throw new Error("STALE_REVISION");
      if (old.execution === "running" && old.pid !== process.pid)
        throw new Error("SCRATCH_BUSY");
      r.updated = Date.now();
      r.pid = process.pid;
      if (r.revisions.length > this.limits.revisions)
        r.revisions = r.revisions.slice(-this.limits.revisions);
      this.reserve(all, r);
      this.save(r);
    });
  }
  release(r: Scratch): void {
    this.locked(() => {
      const old = this.scan().find((x) => x.ref === r.ref);
      if (old?.execution === "running") throw new Error("SCRATCH_BUSY");
      if (old) unlinkSync(this.path(r.ref));
    });
  }
  /** Read-only observations, not a lock acquisition or automatic recovery. */
  inspect(): object {
    if (process.platform === "win32")
      throw new Error("INCOMPATIBLE_SCRATCH_ACL");
    if (!existsSync(this.root)) return { state: "absent", changed: false };
    this.secure(this.root, true);
    const marker = join(this.root, ".pi-codebuffer-store-v1");
    this.secure(marker, false);
    if (readFileSync(marker, "utf8") !== "pi-codebuffer scratch store v1\n")
      throw new Error("UNSAFE_SCRATCH_PATH: ownership marker mismatch");
    const names = readdirSync(this.root);
    if (names.length > 1027)
      throw new Error("SCRATCH_QUOTA: too many store entries");
    const issues: { ref?: string; error: string }[] = [];
    let records = 0,
      issueCount = 0;
    let lock: object = { state: "absent" };
    const issue = (error: unknown, ref?: string) => {
      issueCount++;
      if (issues.length < 32)
        issues.push({
          ref,
          error: error instanceof Error ? error.message : String(error),
        });
    };
    for (const name of names) {
      if (name === ".pi-codebuffer-store-v1") continue;
      if (name === "lock") {
        try {
          this.secure(join(this.root, name), true);
          const owner = join(this.root, name, "owner");
          this.secure(owner, false);
          const pid = Number(readFileSync(owner, "utf8"));
          if (!Number.isSafeInteger(pid) || pid < 1)
            throw new Error("invalid lock owner");
          lock = { state: alive(pid) ? "possibly_live" : "dead_owner", pid };
        } catch (error) {
          lock = { state: "ambiguous" };
          issue(error);
        }
      } else if (/^[a-f0-9-]{36}\.json$/.test(name)) {
        const ref = name.slice(0, -5);
        try {
          if (lstatSync(this.path(ref)).size > this.limits.scratchBytes)
            throw new Error("SCRATCH_QUOTA");
          this.load(ref);
          records++;
        } catch (error) {
          issue(error, ref);
        }
      } else
        issue(
          new Error("unexpected owned-store artifact: " + name.slice(0, 120)),
        );
    }
    return {
      changed: false,
      observation: "not an atomic snapshot",
      records,
      lock,
      issueCount,
      issues,
      recovery:
        "Stop all processes using this store before manual recovery. Preserve a private backup. Remove a stale lock only after verifying no owner can still use it; inspect pending artifacts and record hashes first. This command never deletes evidence or executes source.",
    };
  }
  status(session?: string, ancestry?: Set<string>): object {
    return this.locked(() => {
      const all = this.scan();
      return {
        diskBytes: all.reduce((n, r) => n + r.diskBytes, 0),
        indexEntries: this.index.size,
        indexBytes: [...this.index.values()].reduce(
          (n, entry) => n + bytes(JSON.stringify(entry)),
          0,
        ),
        scan: { ...this.metrics },
        handles: all.length,
        budgetBytes: this.limits.scratchBytes,
        retained: session
          ? all
              .filter(
                (r) =>
                  r.session === session &&
                  (r.anchor === null || ancestry?.has(r.anchor)),
              )
              .map((r) => ({
                ref: r.ref,
                base: r.base,
                execution: r.execution,
                updated: r.updated,
              }))
          : undefined,
      };
    });
  }
}
