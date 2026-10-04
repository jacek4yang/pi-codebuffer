import {
  readdirSync,
  existsSync,
  lstatSync,
  readFileSync,
  writeFileSync,
  renameSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
export interface ProcessIdentity {
  pid: number;
  start: string;
}
export function processIdentity(pid: number): ProcessIdentity | undefined {
  try {
    const value = readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = value.slice(value.lastIndexOf(")") + 2).split(" ");
    if (fields[0] === "Z" || !fields[19]) return undefined;
    return { pid, start: fields[19] };
  } catch {
    return undefined;
  }
}
export function isAlive(identity?: ProcessIdentity): boolean {
  return !!identity && processIdentity(identity.pid)?.start === identity.start;
}
export function signalOwned(identity: ProcessIdentity, signal: NodeJS.Signals) {
  if (!isAlive(identity)) return;
  const stat = readFileSync(`/proc/${identity.pid}/stat`, "utf8");
  const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
  if (
    Number(fields[2]) !== identity.pid ||
    lstatSync(`/proc/${identity.pid}`).uid !== process.getuid?.()
  )
    throw new Error("JOB_PROCESS_IDENTITY_CHANGED");
  try {
    process.kill(-identity.pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}
export function groupMembers(group: ProcessIdentity): ProcessIdentity[] {
  const pids = readdirSync("/proc").filter((name) => /^\d+$/.test(name));
  if (pids.length > 16384) throw new Error("PROCESS_SCAN_LIMIT");
  const found: ProcessIdentity[] = [];
  for (const text of pids) {
    const pid = Number(text);
    try {
      const value = readFileSync(`/proc/${pid}/stat`, "utf8");
      const fields = value.slice(value.lastIndexOf(")") + 2).split(" ");
      if (
        fields[0] !== "Z" &&
        Number(fields[2]) === group.pid &&
        BigInt(fields[19]!) >= BigInt(group.start) &&
        lstatSync(`/proc/${pid}`).uid === process.getuid?.()
      )
        found.push({ pid, start: fields[19]! });
    } catch {
      /* exited while enumerating */
    }
  }
  return found;
}
export function signalProcess(
  identity: ProcessIdentity,
  signal: NodeJS.Signals,
) {
  if (!isAlive(identity)) return;
  if (lstatSync(`/proc/${identity.pid}`).uid !== process.getuid?.())
    throw new Error("JOB_PROCESS_IDENTITY_CHANGED");
  try {
    process.kill(identity.pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}
function read(path: string): unknown {
  const s = lstatSync(path);
  if (
    !s.isFile() ||
    s.isSymbolicLink() ||
    s.nlink !== 1 ||
    s.uid !== process.getuid?.() ||
    s.mode & 0o077 ||
    s.size > 65536
  )
    throw new Error("UNSAFE_JOB_JOURNAL");
  return JSON.parse(readFileSync(path, "utf8"));
}
function identity(value: unknown): ProcessIdentity {
  const v = value as ProcessIdentity;
  if (
    !v ||
    !Number.isSafeInteger(v.pid) ||
    v.pid < 1 ||
    typeof v.start !== "string" ||
    !/^\d+$/.test(v.start)
  )
    throw new Error("INVALID_JOB_OWNER");
  return { pid: v.pid, start: v.start };
}
/** Single live owner; crashed-owner takeover never assumes a PID still names the same process. */
export class JobJournal {
  private owner: ProcessIdentity & { nonce: string };
  private lock: string;
  private file: string;
  constructor(root: string) {
    const owner = processIdentity(process.pid);
    if (!owner)
      throw new Error(
        "UNSUPPORTED_JOB_RECOVERY_PLATFORM: Linux proc identity required",
      );
    this.owner = { ...owner, nonce: randomUUID() };
    this.lock = join(root, ".owner");
    this.file = join(root, ".jobs.json");
    const admission = join(root, ".admission");
    // Every opener enters the same short exclusive section. A crash inside it
    // fails closed for explicit inspection rather than racing to reclaim a lock.
    writeFileSync(admission, JSON.stringify(this.owner), {
      flag: "wx",
      mode: 0o600,
    });
    try {
      if (existsSync(this.lock)) {
        const previous = identity(read(this.lock));
        if (isAlive(previous)) throw new Error("JOB_STORE_BUSY");
        unlinkSync(this.lock);
      }
      writeFileSync(this.lock, JSON.stringify(this.owner), {
        flag: "wx",
        mode: 0o600,
      });
    } finally {
      unlinkSync(admission);
    }
  }
  load(): unknown[] {
    if (!existsSync(this.file)) return [];
    const raw = read(this.file) as { version?: number; records?: unknown[] };
    if (
      raw?.version !== 1 ||
      !Array.isArray(raw.records) ||
      raw.records.length > 128
    )
      throw new Error("INVALID_JOB_JOURNAL");
    return raw.records;
  }
  save(records: unknown[]) {
    if (
      !isAlive(this.owner) ||
      JSON.stringify(read(this.lock)) !== JSON.stringify(this.owner)
    )
      throw new Error("JOB_OWNER_CHANGED");
    const text = JSON.stringify({ version: 1, records });
    if (Buffer.byteLength(text) > 65536) throw new Error("JOB_JOURNAL_QUOTA");
    const temp = this.file + ".next";
    if (existsSync(temp)) {
      read(temp);
      unlinkSync(temp);
    }
    writeFileSync(temp, text, { flag: "wx", mode: 0o600 });
    renameSync(temp, this.file);
  }
  close() {
    if (
      existsSync(this.lock) &&
      JSON.stringify(read(this.lock)) === JSON.stringify(this.owner)
    )
      unlinkSync(this.lock);
  }
}
