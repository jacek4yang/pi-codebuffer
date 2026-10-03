import { performance } from "node:perf_hooks";
import { State, ENTRY, bytes, type Revision } from "./state.js";
interface Entry {
  id: string;
  type: string;
  customType?: string;
  data?: unknown;
}
/** One branch only: prefix identity, not names/revision numbers, controls reuse. */
export class BranchIndex {
  private ids: string[] = [];
  private state: State | undefined;
  private session = "";
  private retained = 0;
  reconstructions = 0;
  reconstructionMs = 0;
  constructor(readonly budget = 32 * 1024 * 1024) {}
  get(session: string, branch: readonly Entry[]): State {
    const relevant = branch.filter(
      (e) => e.type === "custom" && e.customType === ENTRY,
    );
    if (
      !this.state ||
      session !== this.session ||
      this.ids.length > relevant.length ||
      this.ids.some((id, i) => id !== relevant[i]!.id)
    ) {
      this.ids = [];
      this.state = new State([], this.budget / 2);
      this.retained = 0;
      this.session = session;
    }
    try {
      for (const e of relevant.slice(this.ids.length)) {
        const started = performance.now();
        this.state.apply(e.data);
        this.reconstructionMs += performance.now() - started;
        this.ids.push(e.id);
        this.retained += bytes(JSON.stringify(e)) + 64;
        const r = e.data as Revision;
        if (r.kind === "revision") {
          this.reconstructions++;
        }
      }
    } catch {
      this.state = undefined;
      this.ids = [];
      this.retained = 0;
      throw new Error("STATE_CORRUPT");
    }
    const result = this.state;
    if (this.retained > this.budget / 2) {
      this.state = undefined;
      this.ids = [];
      this.retained = 0;
    }
    return result;
  }
  status(): object {
    return {
      accountedBytes: this.retained + (this.state?.cacheBytes ?? 0),
      budgetBytes: this.budget,
      reconstructions: this.reconstructions,
      reconstructionMs: this.reconstructionMs,
    };
  }
}
export function durableBytes(
  entries: readonly { type: string; customType?: string; data?: unknown }[],
): number {
  return entries.reduce(
    (n, e) =>
      n +
      (e.type === "custom" && e.customType === ENTRY
        ? bytes(JSON.stringify(e.data))
        : 0),
    0,
  );
}
