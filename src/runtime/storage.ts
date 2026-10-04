import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { isAlive, type ProcessIdentity } from "./job-journal.js";

const MARKER = ".runtime-storage-v1";
const SESSION = ".runtime-session-v1";
const DAY = 86400000;

function directory(path: string) {
  const stat = lstatSync(path);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    stat.uid !== process.getuid?.() ||
    stat.mode & 0o077
  )
    throw new Error("UNSAFE_RUNTIME_DIRECTORY");
}
function json(path: string) {
  const stat = lstatSync(path);
  if (
    !stat.isFile() ||
    stat.nlink !== 1 ||
    stat.uid !== process.getuid?.() ||
    stat.size > 65536
  )
    throw new Error("UNSAFE_RUNTIME_METADATA");
  return JSON.parse(readFileSync(path, "utf8"));
}
function identity(value: unknown): ProcessIdentity {
  const v = value as Partial<ProcessIdentity> | null;
  if (
    !v ||
    !Number.isSafeInteger(v.pid) ||
    v.pid! < 1 ||
    typeof v.start !== "string" ||
    !/^\d{1,32}$/.test(v.start)
  )
    throw new Error("INVALID_RUNTIME_IDENTITY");
  return { pid: v.pid!, start: v.start };
}
function inactive(path: string): boolean {
  const jobs = join(path, "jobs");
  if (!existsSync(jobs)) return true;
  directory(jobs);
  if (existsSync(join(jobs, ".admission"))) return false;
  if (
    existsSync(join(jobs, ".owner")) &&
    isAlive(identity(json(join(jobs, ".owner"))))
  )
    return false;
  const journal = join(jobs, ".jobs.json");
  if (!existsSync(journal)) return true;
  const data = json(journal);
  if (
    data?.version !== 1 ||
    !Array.isArray(data.records) ||
    data.records.length > 128
  )
    throw new Error("INVALID_JOB_JOURNAL");
  return !data.records.some(
    (record: { process?: unknown }) =>
      record.process && isAlive(identity(record.process)),
  );
}
function inspectTree(root: string) {
  let entries = 0;
  let bytes = 0;
  const walk = (path: string, depth: number) => {
    if (depth > 4) throw new Error("RUNTIME_STORAGE_DEPTH");
    directory(path);
    for (const name of readdirSync(path)) {
      if (++entries > 4096) throw new Error("RUNTIME_STORAGE_ENTRIES");
      const child = join(path, name);
      const stat = lstatSync(child);
      if (stat.uid !== process.getuid?.() || stat.isSymbolicLink())
        throw new Error("UNSAFE_RUNTIME_ARTIFACT");
      if (stat.isDirectory()) walk(child, depth + 1);
      else if (stat.isFile() && stat.nlink === 1) bytes += stat.size;
      else throw new Error("UNSAFE_RUNTIME_ARTIFACT");
    }
  };
  walk(root, 0);
  return bytes;
}

/** Serialize admission and collection across Pi processes; never collect a live job. */
export function runtimeStorage<T>(
  root: string,
  id: string,
  open: (path: string) => T,
  now = Date.now(),
): T {
  if (!/^[a-f0-9]{64}$/.test(id)) throw new Error("INVALID_RUNTIME_SESSION");
  mkdirSync(root, { recursive: true, mode: 0o700 });
  directory(root);
  const marker = join(root, MARKER);
  if (!existsSync(marker)) {
    if (readdirSync(root).length) throw new Error("UNOWNED_RUNTIME_STORAGE");
    writeFileSync(marker, "1", { flag: "wx", mode: 0o600 });
  }
  if (json(marker) !== 1) throw new Error("INVALID_RUNTIME_STORAGE");
  // A crashed allocator fails closed; it is never guessed safe to delete.
  const lock = join(root, ".allocation");
  writeFileSync(lock, String(process.pid), { flag: "wx", mode: 0o600 });
  try {
    const names = readdirSync(root).filter(
      (name) => name !== MARKER && name !== ".allocation",
    );
    if (names.length > 8) throw new Error("RUNTIME_DIRECTORY_LIMIT");
    const sessions = names.map((name) => {
      if (!/^[a-f0-9]{64}$/.test(name))
        throw new Error("UNOWNED_RUNTIME_ARTIFACT");
      const path = join(root, name);
      directory(path);
      const stamp = json(join(path, SESSION));
      if (stamp?.id !== name || !Number.isSafeInteger(stamp.used))
        throw new Error("INVALID_RUNTIME_SESSION");
      return {
        name,
        path,
        used: stamp.used as number,
        inactive: inactive(path),
      };
    });
    // Inspect before deleting: never traverse symlinks or erase unexpected artifacts.
    if (inspectTree(root) > 48 * 1024 * 1024)
      throw new Error("RUNTIME_STORAGE_QUOTA");
    const candidates = sessions
      .filter((s) => s.name !== id && s.inactive)
      .sort((a, b) => a.used - b.used);
    let count = sessions.length;
    for (const old of candidates) {
      if (now - old.used < DAY && (names.includes(id) || count < 8)) continue;
      // Recheck while admission remains locked; a running owner always wins.
      if (!inactive(old.path)) continue;
      rmSync(old.path, { recursive: true });
      count--;
    }
    const path = join(root, id);
    if (!existsSync(path)) {
      if (count >= 8)
        throw new Error(
          "RUNTIME_DIRECTORY_LIMIT: all retained sessions have live owners/jobs",
        );
      mkdirSync(path, { mode: 0o700 });
      writeFileSync(join(path, SESSION), JSON.stringify({ id, used: now }), {
        flag: "wx",
        mode: 0o600,
      });
    }
    // Finish fallible metadata writes before handing ownership to a live runtime.
    writeFileSync(join(path, SESSION), JSON.stringify({ id, used: now }), {
      mode: 0o600,
    });
    return open(path);
  } finally {
    rmSync(lock);
  }
}
