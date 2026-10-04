import { randomUUID } from "node:crypto";
import {
  mkdirSync,
  existsSync,
  readdirSync,
  lstatSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { ScratchStore, type Scratch } from "../scratch.js";
import { ExecutionContext, proxyKeys, type Route } from "./context.js";
import { prepareEnvironment, quote, type Language } from "./environment.js";
import { hostProgram } from "./program.js";
import { Jobs, type JobView, type Launch, type JobLimits } from "./jobs.js";
export interface Scope {
  session: string;
  anchor: string | null;
  ancestry: Set<string>;
}
export interface HostInput {
  code?: string;
  ref?: string;
  base?: string;
  run?: boolean;
  rerun?: "from-start";
  wait?: number;
  limit?: number;
  route?: Route;
}
export interface HostDraft {
  ref: string;
  base: string;
  language: Language;
  bytes: number;
  execution: Scratch["execution"];
}
export interface HostPlan {
  draft: HostDraft;
  command: string;
  launch: Launch;
  scope: Scope;
  rerun?: "from-start";
  waitMs: number;
  environment: string;
}
export class Host {
  readonly jobs: Jobs;
  private pending = new Set<HostPlan>();
  private closing?: Promise<void>;
  private sources = new Map<string, { plan: HostPlan; record: Scratch }>();
  private environments: string;
  constructor(
    readonly scratch: ScratchStore,
    readonly context: ExecutionContext,
    root: string,
    notify: (view: JobView) => void = () => {},
    limits: Partial<JobLimits> = {},
  ) {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    this.environments = join(root, "environments");
    mkdirSync(this.environments, { mode: 0o700, recursive: true });
    for (const path of [root, this.environments]) {
      const s = lstatSync(path);
      if (
        s.isSymbolicLink() ||
        !s.isDirectory() ||
        s.uid !== process.getuid?.() ||
        s.mode & 0o077
      )
        throw new Error("UNSAFE_RUNTIME_DIRECTORY");
    }
    this.jobs = new Jobs(
      join(root, "jobs"),
      (view) => {
        const source = this.sources.get(view.id);
        if (source) {
          try {
            source.record.execution =
              view.state === "completed"
                ? "completed"
                : view.state === "failed"
                  ? "failed"
                  : "interrupted";
            this.scratch.update(source.record, source.plan.draft.base);
          } catch {
            this.jobs.annotate(
              view.id,
              "storageError",
              "BUFFER_SETTLEMENT_FAILED",
            );
          }
          try {
            this.removeEnvironment(source.plan.environment);
          } catch {
            this.jobs.annotate(
              view.id,
              "cleanupError",
              "ENVIRONMENT_CLEANUP_FAILED",
            );
          }
          this.sources.delete(view.id);
        }
        notify(this.jobs.get(view.id));
      },
      limits,
    );
    try {
      this.collectEnvironments();
    } catch (error) {
      void this.jobs.close();
      throw error;
    }
  }
  private removeEnvironment(path: string) {
    const s = lstatSync(path);
    const marker = join(path, ".codebuffer-env-v1");
    const m = lstatSync(marker);
    if (
      s.isSymbolicLink() ||
      !s.isDirectory() ||
      s.mode & 0o077 ||
      s.uid !== process.getuid?.() ||
      m.isSymbolicLink() ||
      !m.isFile() ||
      m.nlink !== 1 ||
      m.mode & 0o077 ||
      readFileSync(marker, "utf8") !== "codebuffer environment v1\n"
    )
      throw new Error("UNSAFE_ENVIRONMENT_CLEANUP");
    rmSync(path, { recursive: true });
  }
  private collectEnvironments() {
    const names = readdirSync(this.environments);
    if (names.length > 128 || names.some((n) => !/^e-[a-f0-9-]{36}$/.test(n)))
      throw new Error("ENVIRONMENT_RECOVERY_REQUIRED");
    // A previous owner's orphan may still need PATH shims. Do not delete them early.
    if (this.jobs.list().some((j) => j.state === "orphaned")) return;
    const live = new Set([...this.pending].map((p) => p.environment));
    for (const source of this.sources.values())
      live.add(source.plan.environment);
    for (const name of names) {
      const path = join(this.environments, name);
      if (!live.has(path)) this.removeEnvironment(path);
    }
  }
  prepare(
    language: Language,
    input: HostInput,
    scope: Scope,
    inherited: NodeJS.ProcessEnv = process.env,
  ): HostDraft | HostPlan {
    if (this.closing) throw new Error("HOST_CLOSED");
    if ((input.code !== undefined) === (input.ref !== undefined))
      throw new Error("INPUT_CONFLICT: provide code or ref/base");
    if (
      input.code !== undefined &&
      (input.base !== undefined || input.rerun !== undefined)
    )
      throw new Error("INPUT_CONFLICT");
    const waitMs = (input.wait ?? 5) * 1000;
    const limitMs =
      input.limit === undefined
        ? this.jobs.limits.defaultLimitMs
        : input.limit * 1000;
    if (
      !Number.isSafeInteger(waitMs) ||
      waitMs < 0 ||
      waitMs > 60000 ||
      !Number.isSafeInteger(limitMs) ||
      limitMs < 1 ||
      limitMs > this.jobs.limits.maxLimitMs
    )
      throw new Error("INVALID_WAIT_OR_LIMIT");
    const record =
      input.code !== undefined
        ? this.scratch.create(scope.session, scope.anchor, input.code, {
            language,
            run: false,
          })
        : this.scratch.get(input.ref!, scope.session, scope.ancestry);
    if (record.language !== language) throw new Error("LANGUAGE_MISMATCH");
    const value = record.revisions.at(-1)!;
    if (input.ref && value.metadata.id !== input.base)
      throw new Error("STALE_REVISION");
    const draft: HostDraft = {
      ref: record.ref,
      base: value.metadata.id,
      language,
      bytes: Buffer.byteLength(value.source),
      execution: record.execution,
    };
    if (input.run === false) return draft;
    if (record.execution === "running") throw new Error("SCRATCH_BUSY");
    if (record.delegated && input.rerun !== "from-start")
      throw new Error("RERUN_ACK_REQUIRED");
    this.collectEnvironments();
    if (
      this.pending.size +
        this.jobs
          .list()
          .filter((j) => ["running", "orphaned"].includes(j.state)).length >=
        this.jobs.limits.active ||
      readdirSync(this.environments).length >= this.jobs.limits.active
    )
      throw new Error("ACTIVE_JOB_LIMIT");
    const environment = join(this.environments, "e-" + randomUUID());
    const snapshot = this.context.snapshot();
    try {
      const prepared = prepareEnvironment(
        snapshot,
        language,
        environment,
        inherited,
        input.route,
      );
      const program = hostProgram(language, prepared.executable, value.source);
      const launch: Launch = {
        executable: prepared.executable,
        ...program,
        env: prepared.env,
        cwd: snapshot.cwd,
        limitMs,
      };
      const changes: string[] = [];
      const assignments: string[] = [];
      for (const key of new Set([
        ...proxyKeys,
        ...Object.keys(inherited),
        ...Object.keys(prepared.env),
      ])) {
        if (prepared.env[key] === inherited[key]) continue;
        if (prepared.env[key] === undefined) changes.push("-u", key);
        else assignments.push(key + "=" + prepared.env[key]);
      }
      const marker = "CODEBUFFER_" + randomUUID().replaceAll("-", "");
      const command =
        "cd -- " +
        quote(snapshot.cwd) +
        " && " +
        [
          "/usr/bin/env",
          ...changes,
          ...assignments,
          "/usr/bin/timeout",
          "--signal=TERM",
          "--kill-after=1s",
          `${limitMs / 1000}s`,
          prepared.executable,
          ...program.args,
        ]
          .map(quote)
          .join(" ") +
        " <<'" +
        marker +
        "'\n" +
        value.source +
        "\n" +
        marker;
      const plan: HostPlan = {
        draft,
        command,
        launch,
        scope: structuredClone(scope),
        rerun: input.rerun,
        waitMs,
        environment,
      };
      this.pending.add(plan);
      return plan;
    } catch (error) {
      if (existsSync(environment)) this.removeEnvironment(environment);
      throw error;
    }
  }
  discard(plan: HostPlan) {
    if (!this.pending.delete(plan)) return;
    this.removeEnvironment(plan.environment);
  }
  /** Invoke only after the public final-command tool policy has authorized this exact plan. */
  async execute(
    plan: HostPlan,
    signal?: AbortSignal,
  ): Promise<HostDraft & { job: JobView }> {
    if (!this.pending.has(plan)) throw new Error("PLAN_EXPIRED");
    let record: Scratch;
    try {
      signal?.throwIfAborted();
      record = this.scratch.repair({
        ref: plan.draft.ref,
        base: plan.draft.base,
        session: plan.scope.session,
        ancestry: plan.scope.ancestry,
        anchor: plan.scope.anchor,
        run: true,
        rerun: plan.rerun,
      });
      record.delegated = true;
      this.scratch.update(record, plan.draft.base);
    } catch (error) {
      this.discard(plan);
      throw error;
    }
    let id: string;
    try {
      id = this.jobs.start(plan.launch);
    } catch (error) {
      record.execution = "interrupted";
      this.scratch.update(record, plan.draft.base);
      this.discard(plan);
      throw error;
    }
    this.pending.delete(plan);
    this.sources.set(id, { plan, record });
    // Keep the buffer busy even if Pi crashes while its external watchdog survives.
    const identity = this.jobs.identity(id);
    if (identity) {
      record.process = identity;
      try {
        this.scratch.update(record, plan.draft.base);
      } catch (error) {
        this.jobs.cancel(id);
        await this.jobs.wait(id, 2000);
        throw new Error(
          `SOURCE_PIN_FAILED: job=${id} ref=${record.ref}: ${String(error)}`,
        );
      }
    }
    const cancel = () => this.jobs.cancel(id);
    signal?.addEventListener("abort", cancel, { once: true });
    if (signal?.aborted) cancel();
    try {
      const job = await this.jobs.wait(id, plan.waitMs);
      return {
        ...plan.draft,
        execution:
          job.state === "running"
            ? "running"
            : job.state === "completed"
              ? "completed"
              : job.state === "failed"
                ? "failed"
                : "interrupted",
        job,
      };
    } finally {
      signal?.removeEventListener("abort", cancel);
    }
  }
  close(): Promise<void> {
    if (!this.closing)
      this.closing = (async () => {
        for (const plan of this.pending) this.discard(plan);
        await this.jobs.close();
      })();
    return this.closing;
  }
}
