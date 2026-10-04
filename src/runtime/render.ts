import {
  highlightCode,
  getLanguageFromPath,
  type ToolRenderers,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

/** Terminal-control filtering is display safety, not secret redaction. */
export function displayText(value: string, expanded: boolean): string {
  const cap = expanded ? 16000 : 240;
  const safe = [...value.slice(0, cap)]
    .map((c) => {
      const n = c.codePointAt(0)!;
      return (n < 32 && c !== "\n" && c !== "\t") ||
        (n >= 127 && n < 160) ||
        (n >= 0x202a && n <= 0x202e) ||
        (n >= 0x2066 && n <= 0x2069)
        ? "�"
        : c;
    })
    .join("");
  const lines = safe.split("\n");
  const count = expanded ? 200 : 3;
  return (
    lines.slice(0, count).join("\n") +
    (value.length > cap || lines.length > count
      ? "\n… preview truncated; inspect source/log for more"
      : "")
  );
}
function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
export function executionRenderers(name: string): ToolRenderers {
  return {
    renderCall(args, theme, context) {
      const input = record(args);
      const path = typeof input.path === "string" ? input.path : undefined;
      let output = theme.fg("toolTitle", theme.bold(name));
      if (path) output += " " + theme.fg("accent", displayText(path, false));
      if (typeof input.ref === "string")
        output += " " + theme.fg("muted", displayText(input.ref, false));
      if (input.run === false)
        output += theme.fg("warning", " · draft (not executed)");
      for (const key of ["wait", "limit", "route"])
        if (input[key] !== undefined)
          output += theme.fg(
            "dim",
            ` · ${key}=${displayText(String(input[key]), false)}`,
          );
      const source = input.command ?? input.code ?? input.content;
      if (typeof source === "string") {
        const preview = displayText(source, context.expanded);
        const language =
          name === "node" || name === "code"
            ? "javascript"
            : name === "python" || name === "bash"
              ? name
              : path
                ? getLanguageFromPath(path)
                : undefined;
        let rendered = preview;
        try {
          rendered = highlightCode(preview, language).join("\n");
        } catch {
          /* theme/language unavailable */
        }
        output += "\n" + rendered;
      } else if (name === "edit") {
        output += theme.fg(
          "dim",
          ` · ${String(input.format ?? "edit")} (requested)`,
        );
        if (context.expanded) {
          if (typeof input.patch === "string")
            output +=
              "\n" +
              displayText(input.patch, true)
                .split("\n")
                .map((line) =>
                  theme.fg(
                    line.startsWith("+")
                      ? "success"
                      : line.startsWith("-")
                        ? "error"
                        : "dim",
                    line,
                  ),
                )
                .join("\n");
          else if (Array.isArray(input.edits))
            for (const value of input.edits.slice(0, 16)) {
              const edit = record(value);
              if (typeof edit.old === "string")
                output +=
                  "\n" + theme.fg("error", "− " + displayText(edit.old, false));
              if (typeof edit.start === "number")
                output +=
                  "\n" +
                  theme.fg("muted", `[${edit.start},${String(edit.end)})`);
              const added = edit.replacement ?? edit.text;
              if (typeof added === "string")
                output +=
                  "\n" + theme.fg("success", "+ " + displayText(added, false));
            }
          else if (typeof input.text === "string")
            output +=
              "\n" + theme.fg("success", "+ " + displayText(input.text, true));
        }
      } else if (context.expanded)
        output += "\n" + displayText(JSON.stringify(input, null, 2), true);
      return new Text(output, 0, 0);
    },
    renderResult(result, options, theme, context) {
      const body = result.content
        .filter((c) => c.type === "text")
        .map((c) => c.text)
        .join("\n");
      let parsed: Record<string, unknown> = {};
      try {
        parsed = record(JSON.parse(body));
      } catch {
        /* native/plain output */
      }
      const job = record(parsed.job);
      const failed = context.isError;
      const label = options.isPartial
        ? "running…"
        : typeof job.state === "string"
          ? `${job.state}${job.exitCode == null ? "" : ` · exit ${job.exitCode}`}`
          : failed
            ? "failed"
            : "result";
      const color = failed
        ? "error"
        : job.state === "running" || options.isPartial
          ? "warning"
          : "success";
      let output = theme.fg(color, label);
      if (typeof parsed.ref === "string")
        output += theme.fg("muted", " · " + displayText(parsed.ref, false));
      if (options.expanded) output += "\n" + displayText(body, true);
      else if (failed)
        output += "\n" + theme.fg("error", displayText(body, false));
      else if (typeof job.output === "string" && job.output)
        output += "\n" + displayText(job.output, false);
      return new Text(output, 0, 0);
    },
  };
}
