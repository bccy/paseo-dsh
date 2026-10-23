/**
 * Paseo MCP gateway: three discovery/call meta-tools instead of 61 injected schemas.
 *
 * Paseo injects its own MCP server into every agent so the model can manage agents,
 * terminals, schedules and a browser. Mounting it as `@deepseek-ai/dsh-mcp-client`
 * costs ~33 KB of tool declarations in every request — a third of a fresh session's
 * context — while most sessions call at most a handful of those tools.
 *
 * The plugin keeps the same server reachable but declares three small tools:
 * `mcp_list_tools` (what exists), `mcp_tool_schema` (how to call one), and
 * `mcp_call_tool` (call it). The gateway replaces the client plugin at the same
 * injection point — Paseo still injects the per-session URL and token through the
 * `--patch` overlay, now as this plugin's config, so the address and credentials
 * keep flowing without hardcoding anything.
 *
 * Two transports, one meta-tool surface. Paseo's own server is streamable HTTP,
 * but a plugin's browser bridge is a stdio child process, and its 25 tool
 * schemas cost ~20 KB of every request — exactly the cost this gateway exists to
 * remove. So the same three meta-tools proxy both: `clientFor` reads the
 * transport off the config shape (`url` vs `command`) and rejects an entry that
 * names neither or both, instead of mounting a connection that cannot work.
 *
 * Failure policy: a failed server, unknown tool or MCP-side error throws with the
 * server/tool named, so the turn records a failed tool instead of a fake success.
 *
 * @module dsh-paseo-bridge/mcp-gateway
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Schema from '@deepseek-ai/schemastery';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { DEFAULT_MCP_TIMEOUT_MS, McpHttpClient, browserHostGapOf, unavailableBrowserTools } from './mcp-http.js';
import { McpStdioClient } from './mcp-stdio.js';
import { registerSubagentArchiveTool } from './subagent-archive.js';

/** Stable Cordis plugin name. */
export const name = 'paseo-mcp-gateway';

/** The tool registry this plugin contributes to. */
export const inject = ['tools'];

/**
 * One server connection, addressed by transport.
 *
 * `Schema.union` picks a branch by *matching* it, not by excluding the other:
 * an entry carrying both `url` and `command` validates against the HTTP branch
 * and keeps the stray `command` as an extra property, and the stdio branch does
 * the same in reverse. That is fine for parsing but ambiguous for connecting, so
 * `transportOf` below is the authority on which client gets built and refuses
 * both-at-once instead of silently preferring one.
 */
const HttpServer = Schema.object({
  url: Schema.string().required(),
  headers: Schema.dict(Schema.string()).default({}),
});

const StdioServer = Schema.object({
  command: Schema.string().required(),
  args: Schema.array(Schema.string()).default([]),
  env: Schema.dict(Schema.string()).default({}),
  cwd: Schema.string(),
});

export const Config = Schema.object({
  /**
   * Servers to expose, keyed by the name the model will use.
   *
   * Paseo injects its HTTP agent server and, from a plugin, a stdio browser
   * bridge; the map shape keeps the gateway usable for any additional MCP
   * server a profile may compose later.
   */
  servers: Schema.dict(Schema.union([HttpServer, StdioServer])).default({}),
  /** Per-round-trip budget. */
  timeoutMs: Schema.natural().default(DEFAULT_MCP_TIMEOUT_MS),
});

/**
 * Decide which transport a server entry describes.
 *
 * Strict on purpose: a shape that names no transport, or both, throws with the
 * server name instead of falling back to one of them. The failure this prevents
 * is the quiet kind — a typo'd `command` key would otherwise mount an HTTP
 * client against `undefined` and only fail much later, inside a model turn,
 * with a message that names the transport instead of the config.
 *
 * @param server - Configured server name, used in the error.
 * @param entry - The validated config entry.
 * @returns `'http'` or `'stdio'`.
 */
export function transportOf(server, entry) {
  if (entry === null || typeof entry !== 'object') {
    throw new Error(`mcp: server "${server}" must be an object with either { url } or { command }`);
  }
  const hasUrl = typeof entry.url === 'string' && entry.url !== '';
  const hasCommand = typeof entry.command === 'string' && entry.command !== '';
  if (hasUrl && hasCommand) {
    throw new Error(`mcp: server "${server}" configures both "url" and "command"; pick one transport`);
  }
  if (!hasUrl && !hasCommand) {
    throw new Error(`mcp: server "${server}" configures neither "url" nor "command"; cannot pick a transport`);
  }
  return hasUrl ? 'http' : 'stdio';
}

/** Extension for the image media types MCP servers return. */
const IMAGE_EXTENSIONS = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' };

/** Bound on one tool description in the discovery listing. */
const DESCRIPTION_LIMIT = 160;

/**
 * Tool names that answer "is a browser host attached?", in probe order.
 *
 * Two servers expose the same capability under different names: Paseo's own agent
 * server calls it `browser_list_tabs`, the Server Browser bridge calls it
 * `browser_tabs`. The first name present in a server's listing is the one probed,
 * so neither server needs a special case here.
 */
const BROWSER_HOST_PROBES = ['browser_list_tabs', 'browser_tabs'];

/**
 * Process-wide sequence for image file names.
 *
 * The name has to be unique across *calls*, not merely across the blocks of one
 * call: the model calls the same MCP tool repeatedly (screenshot → click →
 * screenshot), so a per-call index would hand the second call the same paths as
 * the first and silently overwrite those files. Every earlier tool-result row
 * that names a path would then resolve to newer bytes — a wrong picture with no
 * error anywhere. One temp directory per process, hence one module counter.
 */
let imageSequence = 0;

/**
 * Image blocks are written next to the session's temp files and reported by path:
 * the gateway cannot admit MCP images into DSH's attachment store the way the
 * official client does, and inlining base64 would cost more context than the
 * schemas this plugin removes. The model reads the file with `read_image`.
 */
function imageDirectory() {
  imageDirectory.directory ??= mkdtempSync(join(tmpdir(), 'paseo-mcp-images-'));
  return imageDirectory.directory;
}

/** Translate one MCP `content` array into model-facing text plus image paths. */
function projectContent(server, tool, content) {
  const texts = [];
  const images = [];
  for (const block of Array.isArray(content) ? content : []) {
    if (block === null || typeof block !== 'object') continue;
    if (block.type === 'text' && typeof block.text === 'string') {
      texts.push(block.text);
      continue;
    }
    if (block.type === 'image' && typeof block.data === 'string') {
      const mimeType = typeof block.mimeType === 'string' ? block.mimeType : 'image/png';
      const extension = IMAGE_EXTENSIONS[mimeType] ?? 'bin';
      imageSequence += 1;
      const path = join(imageDirectory(), `${server}-${tool}-${process.pid}-${imageSequence}.${extension}`);
      writeFileSync(path, Buffer.from(block.data, 'base64'));
      images.push({ path, mimeType });
      continue;
    }
    // Resources and anything newer than this client knows: keep the payload
    // verbatim rather than silently dropping what the tool returned.
    texts.push(JSON.stringify(block));
  }
  return { text: texts.join('\n').trim(), images };
}

/**
 * Register the three meta-tools over the configured servers.
 *
 * The plugin is a no-op without servers, so composing it in a profile without
 * Paseo's overlay costs nothing.
 */
export function apply(ctx, config = {}) {
  // Registered before the server check: archiving subagents is independent of
  // any MCP server, and the one session that needs it is exactly one that may
  // have no servers mounted.
  registerSubagentArchiveTool(ctx);

  const servers = config?.servers ?? {};
  const serverNames = Object.keys(servers);
  if (serverNames.length === 0) return;
  const timeoutMs = config?.timeoutMs ?? DEFAULT_MCP_TIMEOUT_MS;
  const clients = new Map();

  /** Resolve the requested server name, defaulting to the only configured one. */
  const serverFor = (requested) => {
    if (requested === undefined || requested === null || requested === '') {
      if (serverNames.length === 1) return serverNames[0];
      throw new Error(`mcp: "server" is required when several are configured (${serverNames.join(', ')})`);
    }
    if (!Object.hasOwn(servers, requested)) {
      throw new Error(`mcp: unknown server "${requested}"; configured: ${serverNames.join(', ')}`);
    }
    return requested;
  };

  /**
   * One lazily created client per server; a failed handshake is retried next call.
   *
   * The transport comes from the config shape, so a server that names neither
   * fails here — at the first call, with the server named — rather than mounting
   * a client that cannot connect.
   */
  const clientFor = (server) => {
    let client = clients.get(server);
    if (client === undefined) {
      const entry = servers[server];
      const clientInfo = { name: 'paseo-mcp-gateway', version: '0.1.0' };
      client = transportOf(server, entry) === 'stdio'
        ? new McpStdioClient({
          command: entry.command,
          args: entry.args ?? [],
          env: entry.env ?? {},
          cwd: entry.cwd,
          timeoutMs,
          clientInfo,
        })
        : new McpHttpClient({ url: entry.url, headers: entry.headers ?? {}, timeoutMs, clientInfo });
      clients.set(server, client);
    }
    return client;
  };

  /**
   * Reap stdio children when the plugin unloads.
   *
   * A stdio client owns a child process, and a bridge runtime is torn down by
   * disposing its fiber (`dsh-bridge/lib/index.js:121` already relies on that
   * effect ordering). Registering the effect up front — rather than once a
   * client exists — keeps the disposer registration in one place: it iterates
   * whatever `clients` holds at unload time, so a server first called late is
   * still reaped. `dispose()` is a no-op on the HTTP client, which has no
   * resource to release beyond its `AbortController` per request.
   */
  ctx.effect(() => () => Promise.allSettled([...clients.values()].map((client) => client.dispose?.())));

  ctx.tools.register(defineTool({
    name: 'mcp_list_tools',
    description: 'List the tools a connected MCP server exposes (Paseo agent/browser control lives here). '
      + 'Call this before mcp_tool_schema/mcp_call_tool. Pass "query" to filter by substring.',
    parameters: {
      server: { type: 'string', description: 'Server name; omit when only one is configured.' },
      query: { type: 'string', description: 'Case-insensitive substring matched against tool name and description.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          server: { type: 'string', required: true },
          total: { type: 'number', required: true },
          tools: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                name: { type: 'string', required: true },
                description: { type: 'string', required: true },
              },
            },
          },
          unavailable: {
            type: 'array',
            required: true,
            description: 'Browser tools that cannot run until a desktop browser host connects.',
            items: { type: 'string' },
          },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `${value.server}: ${value.total} tool(s)\n${value.tools.map((tool) => `- ${tool.name}: ${tool.description}`).join('\n')}`
          + (value.unavailable.length === 0
            ? ''
            : `\n\n[unavailable] ${value.unavailable.length} browser tool(s) need a connected desktop browser host: ${value.unavailable.join(', ')}`),
      }],
    },
    async execute(args) {
      const server = serverFor(args.server);
      const client = clientFor(server);
      const all = await client.listTools();
      // Browser tools are registered whether or not a host is attached, so prove
      // the host before promising them: an unreachable listing is cheap to learn
      // here and expensive to discover as a failed model turn. Paseo answers the
      // probe as an ordinary result (`browser_no_host`) rather than a JSON-RPC
      // error, so both shapes go through `browserHostGapOf`.
      //
      // The probe tool differs by server, so it is picked from the listing rather
      // than hard-coded: Paseo's own HTTP server names it `browser_list_tabs`, the
      // Server Browser bridge names the same capability `browser_tabs`. Probing
      // with a name the server does not expose would fail on every listing and
      // leave `unavailable` permanently empty — a dead probe that looks alive.
      let hostGap;
      const names = new Set((Array.isArray(all) ? all : []).map((tool) => tool?.name));
      const probe = BROWSER_HOST_PROBES.find((name) => names.has(name));
      if (probe !== undefined) {
        try {
          hostGap = browserHostGapOf(await client.callTool(probe, {}));
        } catch (error) {
          hostGap = browserHostGapOf(error);
        }
      }
      const unavailable = unavailableBrowserTools(all, hostGap);
      const query = String(args.query ?? '').trim().toLowerCase();
      const matched = query === ''
        ? all
        : all.filter((tool) => `${tool.name} ${tool.description ?? ''}`.toLowerCase().includes(query));
      return {
        server,
        total: all.length,
        tools: matched.map((tool) => ({
          name: tool.name,
          description: String(tool.description ?? '').replace(/\s+/g, ' ').slice(0, DESCRIPTION_LIMIT),
        })),
        unavailable,
      };
    },
  }));

  ctx.tools.register(defineTool({
    name: 'mcp_tool_schema',
    description: 'Show one MCP tool\'s description and input schema. Call before mcp_call_tool to learn its arguments.',
    parameters: {
      tool: { type: 'string', required: true, description: 'Tool name as returned by mcp_list_tools.' },
      server: { type: 'string', description: 'Server name; omit when only one is configured.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          server: { type: 'string', required: true },
          name: { type: 'string', required: true },
          description: { type: 'string', required: true },
          parameters: { type: 'object', additionalProperties: true, required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `${value.server}/${value.name}\n${value.description}\nparameters: ${JSON.stringify(value.parameters)}`,
      }],
    },
    async execute(args) {
      const server = serverFor(args.server);
      const tools = await clientFor(server).listTools();
      const found = tools.find((tool) => tool.name === args.tool);
      if (found === undefined) {
        throw new Error(`mcp: server "${server}" exposes no tool "${args.tool}"; start from mcp_list_tools`);
      }
      return {
        server,
        name: found.name,
        description: String(found.description ?? ''),
        parameters: found.inputSchema ?? { type: 'object' },
      };
    },
  }));

  ctx.tools.register(defineTool({
    name: 'mcp_call_tool',
    description: 'Call one MCP tool with JSON arguments (learn them from mcp_tool_schema). '
      + 'Images are written to files and returned by path; open them with read_image.',
    parameters: {
      tool: { type: 'string', required: true, description: 'Tool name as returned by mcp_list_tools.' },
      arguments: { type: 'object', additionalProperties: true, description: 'Arguments object matching the tool schema.' },
      server: { type: 'string', description: 'Server name; omit when only one is configured.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          server: { type: 'string', required: true },
          tool: { type: 'string', required: true },
          content: { type: 'string', required: true },
          images: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                path: { type: 'string', required: true },
                mimeType: { type: 'string', required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.content
          + (value.images.length === 0
            ? ''
            : `\n[images]\n${value.images.map((image) => `- ${image.path} (${image.mimeType})`).join('\n')}`),
      }],
    },
    async execute(args) {
      const server = serverFor(args.server);
      const result = await clientFor(server).callTool(args.tool, args.arguments ?? {});
      const { text, images } = projectContent(server, args.tool, result?.content);
      if (result?.isError === true) {
        throw new Error(`mcp: ${server}/${args.tool} reported an error: ${text === '' ? '(no message)' : text}`);
      }
      return { server, tool: args.tool, content: text, images };
    },
  }));
}
