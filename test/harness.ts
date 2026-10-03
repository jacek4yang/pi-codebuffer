import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "node:http";
import { once } from "node:events";
import { zstdDecompressSync } from "node:zlib";
import {
  createAgentSession,
  createCodemodeExtension,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type ExtensionFactory,
  type AgentToolResult,
} from "@earendil-works/pi-coding-agent";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { getModel } from "@earendil-works/pi-ai/compat";

export async function harness(
  options: {
    companion?: string;
    generation?: string;
    companionsFirst?: boolean;
    factories?: ExtensionFactory[];
    builtin?: boolean;
    extension?: boolean;
    models?: boolean;
  } = {},
) {
  const dir = mkdtempSync(join(tmpdir(), "codebuffer-sdk-"));
  const payloads: Record<string, unknown>[] = [];
  const wire = { responseBytes: 0 };
  let queued: object | undefined;
  let toolName = "codebuffer";
  const server = createServer(async (req, res) => {
    if (req.method !== "POST") {
      res.writeHead(426);
      res.end();
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    let data = Buffer.concat(chunks);
    if (req.headers["content-encoding"] === "zstd")
      data = zstdDecompressSync(data);
    const body = JSON.parse(data.toString()) as {
      input: Record<string, unknown>[];
    };
    payloads.push(body);
    const compact = body.input.some((i) => i.type === "compaction_trigger");
    const tool = !compact && queued;
    if (tool) queued = undefined;
    const count = payloads.length;
    const output = compact
      ? [
          {
            type: "compaction",
            id: "cmp_" + count,
            encrypted_content: "opaque-fixture-not-real",
          },
        ]
      : tool
        ? [
            {
              type: "function_call",
              id: "fc_" + count,
              call_id: "call_" + count,
              name: toolName,
              arguments: JSON.stringify(tool),
            },
          ]
        : [
            {
              type: "message",
              id: "msg_" + count,
              role: "assistant",
              content: [
                { type: "output_text", text: "fixture-ok", annotations: [] },
              ],
            },
          ];
    res.writeHead(200, { "content-type": "text/event-stream" });
    const send = (e: object) => {
      const chunk = "data: " + JSON.stringify(e) + "\n\n";
      wire.responseBytes += Buffer.byteLength(chunk);
      return res.write(chunk);
    };
    if (!compact)
      output.forEach((item, output_index) =>
        send({
          type: "response.output_item.added",
          output_index,
          item: tool ? item : { ...item, content: [] },
        }),
      );
    if (!compact && !tool) {
      send({
        type: "response.content_part.added",
        output_index: 0,
        content_index: 0,
        part: { type: "output_text", text: "", annotations: [] },
      });
      send({
        type: "response.output_text.delta",
        output_index: 0,
        content_index: 0,
        delta: "fixture-ok",
      });
    }
    output.forEach((item, output_index) =>
      send({ type: "response.output_item.done", output_index, item }),
    );
    send({
      type: "response.completed",
      response: {
        id: "resp_" + count,
        status: "completed",
        output,
        usage: { input_tokens: 100, output_tokens: 10, total_tokens: 110 },
      },
    });
    res.end();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address !== "string");
  const jwt =
    "x." +
    Buffer.from(
      JSON.stringify({
        "https://api.openai.com/auth": { chatgpt_account_id: "fixture-only" },
      }),
    ).toString("base64url") +
    ".x";
  const credentials = new InMemoryCredentialStore();
  await credentials.modify("openai-codex", async () => ({
    type: "oauth",
    access: jwt,
    refresh: "fixture",
    expires: Date.now() + 86400000,
  }));
  const model = {
    ...getModel("openai-codex", "gpt-6-astra"),
    baseUrl: "http://127.0.0.1:" + address.port + "/backend-api",
  };
  writeFileSync(
    join(dir, "config.json"),
    JSON.stringify({
      providers: { "openai-codex": { baseUrl: model.baseUrl } },
    }),
  );
  const runtime = await ModelRuntime.create({
    credentials,
    modelsPath: join(dir, "config.json"),
    modelsStorePath: join(dir, "models.json"),
  });
  const settings = SettingsManager.inMemory({
    compaction: { enabled: false, keepRecentTokens: 0, reserveTokens: 1000 },
    transport: "sse",
  });
  const sessions: AgentSession[] = [];
  async function make(manager = SessionManager.create(dir, dir)) {
    const loader = new DefaultResourceLoader({
      cwd: dir,
      agentDir: dir,
      settingsManager: settings,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      additionalExtensionPaths: [
        ...(options.companionsFirst
          ? [options.companion, options.generation].filter(
              (p): p is string => !!p,
            )
          : []),
        ...(options.extension === false
          ? []
          : [process.env.PI_CODEBUFFER_TEST_EXTENSION ?? resolve("index.ts")]),
        ...(!options.companionsFirst
          ? [options.companion, options.generation].filter(
              (p): p is string => !!p,
            )
          : []),
      ],
      extensionFactories: [
        ...(options.builtin === false
          ? []
          : [createCodemodeExtension({ mode: "on", models: options.models })]),
        ...(options.factories ?? []),
      ],
      systemPrompt: "Local deterministic extension test.",
    });
    const previousConfig = process.env.PI_CODEBUFFER;
    const previousRecovery = process.env.PI_GENERATION_RECOVERY_DIR;
    process.env.PI_GENERATION_RECOVERY_DIR = join(dir, "generation");
    process.env.PI_CODEBUFFER = JSON.stringify({
      ...JSON.parse(previousConfig ?? "{}"),
      scratchDirectory: join(dir, "scratch"),
    });
    try {
      await loader.reload();
    } finally {
      if (previousRecovery === undefined)
        delete process.env.PI_GENERATION_RECOVERY_DIR;
      else process.env.PI_GENERATION_RECOVERY_DIR = previousRecovery;
      if (previousConfig === undefined) delete process.env.PI_CODEBUFFER;
      else process.env.PI_CODEBUFFER = previousConfig;
    }
    assert.deepEqual(loader.getExtensions().errors, []);
    const { session } = await createAgentSession({
      cwd: dir,
      agentDir: dir,
      resourceLoader: loader,
      modelRuntime: runtime,
      model,
      settingsManager: settings,
      sessionManager: manager,
    });
    sessions.push(session);
    await session.bindExtensions({
      onError: (e) => {
        throw new Error(JSON.stringify(e));
      },
    });
    return session;
  }
  async function call(
    session: AgentSession,
    args: object,
    name = "codebuffer",
  ) {
    assert.equal(queued, undefined);
    queued = args;
    toolName = name;
    let output: (AgentToolResult<unknown> & { isError: boolean }) | undefined;
    const stop = session.subscribe((e) => {
      if (e.type === "tool_execution_end" && e.toolName === name)
        output = { ...e.result, isError: e.isError };
    });
    try {
      await session.prompt("Perform the queued fixture action.");
      assert(output, JSON.stringify(session.messages.at(-1)));
      return output;
    } finally {
      stop();
    }
  }
  return {
    dir,
    payloads,
    wire,
    make,
    call,
    async close() {
      sessions.forEach((s) => s.dispose());
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((e) => (e ? reject(e) : resolve())),
      );
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
export function textOf(result: AgentToolResult<unknown>): string {
  return result.content
    .filter((c) => c.type === "text")
    .map((c) => c.text)
    .join("\n");
}
export function jsonOf(
  result: AgentToolResult<unknown>,
): Record<string, unknown> {
  const first = result.content[0];
  assert(first?.type === "text");
  return JSON.parse(first.text) as Record<string, unknown>;
}
