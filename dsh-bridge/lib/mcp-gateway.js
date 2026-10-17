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

/** Stable Cordis plugin name. */
export const name = 'paseo-mcp-gateway';

/** The tool registry this plugin contributes to. */
export const inject = ['tools'];

export const Config = Schema.object({
  /**
   * Servers to expose, keyed by the name the model will use.
   *
   * Paseo injects exactly one (its agent MCP server); the map shape keeps the
   * gateway usable for any additional MCP server a profile may compose later.
   */
  servers: Schema.dict(Schema.object({
    url: Schema.string().required(),
    headers: Schema.dict(Schema.string()).default({}),
  })).default({}),
  /** Per-round-trip budget. */
  timeoutMs: Schema.natural().default(DEFAULT_MCP_TIMEOUT_MS),
});

/** Extension for the image media types MCP servers return. */
const IMAGE_EXTENSIONS = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' };

/** Bound on one tool description in the discovery listing. */
const DESCRIPTION_LIMIT = 160;

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
  let index = 0;
  for (const block of Array.isArray(content) ? content : []) {
    if (block === null || typeof block !== 'object') continue;
    if (block.type === 'text' && typeof block.text === 'string') {
      texts.push(block.text);
      continue;
    }
    if (block.type === 'image' && typeof block.data === 'string') {
      const mimeType = typeof block.mimeType === 'string' ? block.mimeType : 'image/png';
      const extension = IMAGE_EXTENSIONS[mimeType] ?? 'bin';
      index += 1;
      const path = join(imageDirectory(), `${server}-${tool}-${process.pid}-${index}.${extension}`);
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

  /** One lazily created client per server; a failed handshake is retried next call. */
  const clientFor = (server) => {
    let client = clients.get(server);
    if (client === undefined) {
      const { url, headers } = servers[server];
      client = new McpHttpClient({ url, headers: headers ?? {}, timeoutMs, clientInfo: { name: 'paseo-mcp-gateway', version: '0.1.0' } });
      clients.set(server, client);
    }
    return client;
  };

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
      let hostGap;
      if (all.some((tool) => typeof tool?.name === 'string' && tool.name.startsWith('browser_'))) {
        try {
          hostGap = browserHostGapOf(await client.callTool('browser_list_tabs', {}));
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
