import { spawn, type ChildProcess } from "node:child_process";
import { constants } from "node:fs";
import { accessSync } from "node:fs";
import { randomUUID } from "node:crypto";
import {
  mkdirSync,
  lstatSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";
import {
  JobJournal,
  isAlive,
  processIdentity,
  signalOwned,
  groupMembers,
  signalProcess,
  type ProcessIdentity,
} from "./job-journal.js";

export interface JobLimits {
  active: number;
  records: number;
  logBytes: number;
  outputBytes: number;
  defaultLimitMs: number;
  maxLimitMs: number;
}
const defaults: JobLimits = {
  active: 4,
  records: 32,
  logBytes: 1024 * 1024,
  outputBytes: 16384,
  defaultLimitMs: 30 * 60000,
  maxLimitMs: 24 * 3600000,
};
export interface Launch {
  executable: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  limitMs?: number;
  stdin?: string;
}
export type JobState =
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "timed_out"
  | "orphaned"
  | "interrupted";
export interface JobView {
  id: string;
  state: JobState;
  started: number;
  ended?: number;
  exitCode?: number;
  signal?: string;
  output: string;
  log: string;
  truncated: boolean;
  storageError?: string;
  cleanupError?: string;
  deadline: number;
}
interface Record {
  view: JobView;
  child?: ChildProcess;
  identity?: ProcessIdentity;
  done: Promise<void>;
  finish: () => void;
  tail: Buffer;
  stdout: Buffer;
  stderr: Buffer;
  total: number;
  timer?: ReturnType<typeof setTimeout>;
  killTimer?: ReturnType<typeof setTimeout>;
  cleanup?: Promise<void>;
  stop?: "cancelled" | "timed_out";
}
function secure(path: string, directory: boolean) {
  const s = lstatSync(path);
  if (
    s.isSymbolicLink() ||
    (directory ? !s.isDirectory() : !s.isFile()) ||
    (!directory && s.nlink !== 1) ||
    s.uid !== process.getuid?.() ||
    s.mode & 0o077
  )
    throw new Error("UNSAFE_JOB_PATH");
}
/** One owner process, bounded records and logs. No retries, polling loop or global env mutation. */
export class Jobs {
  readonly limits: JobLimits;
  private records = new Map<string, Record>();
  private closed = false;
  notificationFailures = 0;
  private journal: JobJournal;
  constructor(
    readonly root: string,
    private notify: (view: JobView) => void = () => {},
    limits: Partial<JobLimits> = {},
  ) {
    for (const key of Object.keys(limits))
      if (!Object.hasOwn(defaults, key))
        throw new Error("INVALID_JOB_LIMIT: " + key);
    this.limits = { ...defaults, ...limits };
    for (const [key, value] of Object.entries(this.limits))
      if (
        !Number.isSafeInteger(value) ||
        value < 1 ||
        value >
          (key.endsWith("Ms")
            ? 7 * 86400000
            : key.endsWith("Bytes")
              ? 16 * 1024 * 1024
              : 128)
      )
        throw new Error("INVALID_JOB_LIMIT: " + key);
    if (
      this.limits.logBytes < 128 ||
      this.limits.outputBytes < 128 ||
      this.limits.outputBytes > this.limits.logBytes ||
      this.limits.active > this.limits.records ||
      this.limits.defaultLimitMs > this.limits.maxLimitMs
    )
      throw new Error("INVALID_JOB_LIMIT");
    if (process.platform === "win32")
      throw new Error(
        "UNSUPPORTED_JOB_PLATFORM: POSIX process-group cancellation required",
      );
    // External watchdog survives the Pi process exiting unexpectedly. Validated Linux baseline.
    accessSync("/usr/bin/timeout", constants.X_OK);
    mkdirSync(root, { recursive: true, mode: 0o700 });
    secure(root, true);
    const marker = join(root, ".codebuffer-jobs-v1");
    if (!existsSync(marker)) {
      if (readdirSync(root).length) throw new Error("UNOWNED_JOB_DIRECTORY");
      writeFileSync(marker, "codebuffer jobs v1\n", {
        mode: 0o600,
        flag: "wx",
      });
    }
    secure(marker, false);
    if (readFileSync(marker, "utf8") !== "codebuffer jobs v1\n")
      throw new Error("UNOWNED_JOB_DIRECTORY");
    this.journal = new JobJournal(root);
    try {
      this.restore(this.journal.load());
      const known = new Set([
        ".codebuffer-jobs-v1",
        ".owner",
        ".jobs.json",
        ".jobs.json.next",
        ...[...this.records.keys()].map((id) => id + ".log"),
      ]);
      if (readdirSync(root).some((name) => !known.has(name)))
        throw new Error("JOB_RECOVERY_REQUIRED: unknown files in owned store");
      this.persist();
    } catch (error) {
      this.journal.close();
      throw error;
    }
  }
  private persist() {
    this.journal.save(
      [...this.records.values()].map((r) => ({
        ...r.view,
        output: undefined,
        log: undefined,
        identity: r.identity,
      })),
    );
  }
  private persistSafely(record: Record) {
    try {
      this.persist();
    } catch {
      record.view.storageError = "JOB_JOURNAL_FAILED";
      this.stop(record, "cancelled");
    }
  }
  private restore(values: unknown[]) {
    if (values.length > this.limits.records)
      throw new Error("JOB_RECORD_LIMIT");
    for (const value of values) {
      if (!value || typeof value !== "object" || Array.isArray(value))
        throw new Error("INVALID_JOB_RECORD");
      const raw = value as JobView & { identity?: ProcessIdentity };
      if (
        typeof raw.id !== "string" ||
        !/^[a-f0-9-]{36}$/.test(raw.id) ||
        this.records.has(raw.id) ||
        ![
          "running",
          "orphaned",
          "interrupted",
          "completed",
          "failed",
          "cancelled",
          "timed_out",
        ].includes(raw.state) ||
        !Number.isFinite(raw.started) ||
        !Number.isFinite(raw.deadline) ||
        raw.deadline < raw.started
      )
        throw new Error("INVALID_JOB_RECORD");
      if (
        raw.identity &&
        (!Number.isSafeInteger(raw.identity.pid) ||
          raw.identity.pid < 1 ||
          typeof raw.identity.start !== "string" ||
          !/^\d+$/.test(raw.identity.start))
      )
        throw new Error("INVALID_JOB_IDENTITY");
      const log = join(this.root, raw.id + ".log");
      secure(log, false);
      if (lstatSync(log).size > this.limits.logBytes)
        throw new Error("JOB_LOG_LIMIT");
      const tail = readFileSync(log);
      const pending = ["running", "orphaned"].includes(raw.state);
      const live = raw.identity
        ? isAlive(raw.identity)
        : Date.now() < raw.deadline;
      const view: JobView = {
        id: raw.id,
        state: pending ? (live ? "orphaned" : "interrupted") : raw.state,
        started: raw.started,
        deadline: raw.deadline,
        output: "",
        log,
        truncated: true,
      };
      if (typeof raw.ended === "number" && Number.isFinite(raw.ended))
        view.ended = raw.ended;
      if (!pending && Number.isSafeInteger(raw.exitCode))
        view.exitCode = raw.exitCode;
      if (
        !pending &&
        typeof raw.signal === "string" &&
        /^SIG[A-Z0-9]{1,24}$/.test(raw.signal)
      )
        view.signal = raw.signal;
      for (const key of ["storageError", "cleanupError"] as const)
        if (typeof raw[key] === "string" && /^[A-Z_]{1,64}$/.test(raw[key]!))
          view[key] = raw[key];
      this.records.set(raw.id, {
        view,
        identity: raw.identity,
        done: Promise.resolve(),
        finish() {},
        tail,
        stdout: tail,
        stderr: Buffer.alloc(0),
        total: tail.length,
      });
    }
  }
  start(input: Launch): string {
    if (this.closed) throw new Error("JOBS_CLOSED");
    const spec = structuredClone(input);
    const limit = spec.limitMs ?? this.limits.defaultLimitMs;
    if (
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > this.limits.maxLimitMs
    )
      throw new Error("INVALID_LIMIT");
    if (
      spec.stdin !== undefined &&
      (typeof spec.stdin !== "string" || Buffer.byteLength(spec.stdin) > 262144)
    )
      throw new Error("STDIN_LIMIT");
    if (
      !spec.executable ||
      spec.executable.includes("\0") ||
      spec.args.some((a) => typeof a !== "string" || a.includes("\0"))
    )
      throw new Error("INVALID_COMMAND");
    if (
      [...this.records.values()].filter((r) =>
        ["running", "orphaned"].includes(this.get(r.view.id).state),
      ).length >= this.limits.active
    )
      throw new Error("ACTIVE_JOB_LIMIT");
    while (this.records.size >= this.limits.records) {
      const old = [...this.records.values()].find(
        (r) => !["running", "orphaned"].includes(this.get(r.view.id).state),
      );
      if (!old) throw new Error("JOB_RECORD_LIMIT");
      secure(old.view.log, false);
      rmSync(old.view.log);
      this.records.delete(old.view.id);
      this.persist();
    }
    secure(this.root, true);
    const id = randomUUID();
    const log = join(this.root, id + ".log");
    writeFileSync(log, "", { flag: "wx", mode: 0o600 });
    let child: ChildProcess;
    try {
      child = spawn(
        "/usr/bin/timeout",
        [
          "--signal=TERM",
          "--kill-after=1s",
          `${limit / 1000}s`,
          spec.executable,
          ...spec.args,
        ],
        {
          cwd: spec.cwd,
          env: spec.env,
          detached: true,
          stdio: [spec.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
        },
      );
    } catch (error) {
      rmSync(log);
      throw error;
    }
    let finish!: () => void;
    const record: Record = {
      view: {
        id,
        state: "running",
        started: Date.now(),
        output: "",
        log,
        truncated: false,
        deadline: Date.now() + limit + 1000,
      },
      child,
      identity: child.pid ? processIdentity(child.pid) : undefined,
      tail: Buffer.alloc(0),
      stdout: Buffer.alloc(0),
      stderr: Buffer.alloc(0),
      total: 0,
      done: new Promise<void>((resolve) => {
        finish = resolve;
      }),
      finish: () => finish(),
    };
    this.records.set(id, record);
    const receive = (chunk: Buffer, stream: "stdout" | "stderr") => {
      record.total += chunk.length;
      // Never concatenate an unbounded producer chunk with the retained tail.
      const tail = chunk.subarray(
        Math.max(0, chunk.length - this.limits.logBytes),
      );
      record[stream] = Buffer.concat([record[stream], tail]).subarray(
        -this.limits.logBytes,
      );
      // Pipe delivery order is not cross-stream ordering. Keep diagnostics even if
      // a large queued stdout chunk arrives after stderr.
      const marker = record.stderr.length
        ? Buffer.from("\n[stderr]\n")
        : Buffer.alloc(0);
      record.stderr = record.stderr.subarray(
        -Math.max(0, this.limits.logBytes - marker.length),
      );
      const room = Math.max(
        0,
        this.limits.logBytes - marker.length - record.stderr.length,
      );
      record.stdout = room ? record.stdout.subarray(-room) : Buffer.alloc(0);
      record.tail = Buffer.concat([record.stdout, marker, record.stderr]);
      record.view.truncated = record.total > this.limits.outputBytes;
      try {
        secure(log, false);
        writeFileSync(log, record.tail);
      } catch {
        this.stop(record, "cancelled");
      }
    };
    child.stdin?.on("error", () => {
      /* early process exit is reported by close/exitCode */
    });
    if (spec.stdin !== undefined) child.stdin?.end(spec.stdin);
    child.stdout?.on("data", (chunk) => receive(chunk, "stdout"));
    child.stderr?.on("data", (chunk) => receive(chunk, "stderr"));
    child.once("error", (error) =>
      receive(Buffer.from("Process start failed: " + error.message), "stderr"),
    );
    child.once("close", async (code, signal) => {
      clearTimeout(record.timer);
      await this.cleanup(record);
      record.view.state =
        record.stop ??
        (code === 124 && Date.now() - record.view.started >= limit
          ? "timed_out"
          : code === 0
            ? "completed"
            : "failed");
      record.view.ended = Date.now();
      if (code !== null) record.view.exitCode = code;
      if (signal) record.view.signal = signal;
      this.persistSafely(record);
      record.finish();
      try {
        this.notify(this.get(id));
      } catch {
        this.notificationFailures++;
      }
    });
    record.timer = setTimeout(() => this.stop(record, "timed_out"), limit);
    this.persistSafely(record);
    return id;
  }
  private stop(record: Record, reason: "cancelled" | "timed_out") {
    if (record.view.state !== "running" || record.stop) return;
    record.stop = reason;
    void this.cleanup(record);
  }
  private cleanup(record: Record): Promise<void> {
    if (record.cleanup) return record.cleanup;
    let members: ProcessIdentity[] = [];
    try {
      if (record.identity) members = groupMembers(record.identity);
    } catch {
      record.view.cleanupError = "PROCESS_SCAN_FAILED";
    }
    const signal = (value: NodeJS.Signals) => {
      try {
        if (record.identity && isAlive(record.identity))
          signalOwned(record.identity, value);
        for (const member of members) signalProcess(member, value);
      } catch {
        record.view.cleanupError = "PROCESS_CLEANUP_FAILED";
      }
    };
    signal("SIGTERM");
    record.cleanup = members.length
      ? new Promise<void>((resolve) => {
          record.killTimer = setTimeout(() => {
            signal("SIGKILL");
            resolve();
          }, 1000);
        })
      : Promise.resolve();
    return record.cleanup;
  }
  cancel(id: string) {
    const r = this.records.get(id);
    if (!r) throw new Error("JOB_EXPIRED");
    if (r.view.state === "orphaned") {
      if (!r.identity)
        throw new Error(
          "JOB_IDENTITY_UNKNOWN: wait for the recorded watchdog deadline",
        );
      signalOwned(r.identity, "SIGKILL");
      return;
    }
    this.stop(r, "cancelled");
  }
  get(id: string): JobView {
    const r = this.records.get(id);
    if (!r) throw new Error("JOB_EXPIRED");
    if (
      r.view.state === "orphaned" &&
      (r.identity ? !isAlive(r.identity) : Date.now() >= r.view.deadline)
    ) {
      r.view.state = "interrupted";
      r.view.ended = Date.now();
      this.persistSafely(r);
    }
    let tail = r.tail.subarray(-this.limits.outputBytes);
    // Do not expose a replacement character caused only by cutting a UTF-8 continuation.
    while (tail.length && (tail[0]! & 0xc0) === 0x80) tail = tail.subarray(1);
    return { ...r.view, output: tail.toString("utf8") };
  }
  annotate(
    id: string,
    field: "storageError" | "cleanupError",
    code: string,
  ): JobView {
    if (!/^[A-Z_]{1,64}$/.test(code)) throw new Error("INVALID_JOB_DIAGNOSTIC");
    const record = this.records.get(id);
    if (!record) throw new Error("JOB_EXPIRED");
    record.view[field] = code;
    this.persistSafely(record);
    return this.get(id);
  }
  identity(id: string): ProcessIdentity | undefined {
    const record = this.records.get(id);
    if (!record) throw new Error("JOB_EXPIRED");
    return record.identity ? { ...record.identity } : undefined;
  }
  list(): JobView[] {
    return [...this.records.keys()].map((id) => this.get(id));
  }
  async wait(id: string, waitMs: number): Promise<JobView> {
    if (!Number.isSafeInteger(waitMs) || waitMs < 0 || waitMs > 60000)
      throw new Error("INVALID_WAIT");
    const r = this.records.get(id);
    if (!r) throw new Error("JOB_EXPIRED");
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        r.done,
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, waitMs);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
    return this.get(id);
  }
  async close(): Promise<void> {
    this.closed = true;
    for (const r of this.records.values()) this.stop(r, "cancelled");
    await Promise.all([...this.records.values()].map((r) => r.done));
    this.journal.close();
  }
}
