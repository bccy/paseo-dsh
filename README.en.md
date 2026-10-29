# DeepSeek Harness × Paseo (native)

English · [中文](README.md)

Bring [DSH](https://www.npmjs.com/package/@deepseek-ai/dsh) into Paseo as a
**first-class provider**. No Paseo fork, no DSH fork: everything goes through
public extension points — a direct-provider plugin on the Paseo side and a
profile bundle on the DSH side.

> This is not an ACP integration. ACP cannot carry three of the things below;
> Paseo's native provider protocol carries all of them.

**One-line install:** `paseo plugin add npm:paseo-dsh` · npm package
[npmjs.com/package/paseo-dsh](https://www.npmjs.com/package/paseo-dsh) · after
install the only step left is [your model route](#install-one-line), described
below.

| Capability | Over ACP | This project |
| --- | --- | --- |
| `ask_user_question` cards | ❌ the model never sees the tool and nothing can answer it | ✅ native Paseo card, step through every question, one submission |
| Plan mode | ❌ ACP carries no modes/plans | ✅ Build / Plan switch in the composer; the plan is shown before approval |
| Thinking effort | ⚠️ depends on the model | ✅ rendered from each model's **declared** levels |
| Steering | — | ✅ injected into the current turn instead of queued for the next |
| Images (multimodal) | ⚠️ usually not carried | ✅ attachments are admitted and delivered by route modality (the profile must declare image input) |
| Slash commands / skills | ⚠️ often a command subset | ✅ the `/` menu lists DSH commands and user-invocable skills; commands run in the runtime, skills are injected by `/name` |
| Permission modes (sandbox) | ❌ no shared switch | ✅ **Permissions** dropdown in the composer switches DSH's sandbox and approval presets |
| Agent presets | ❌ | ✅ when the profile mounts the agent-preset registry, a **Preset** dropdown appears (chosen at session creation, locked after the first turn) |
| Session resume / import | ❌ no history, no import | ✅ reopening replays history through Paseo's `history: replay`; **import** native DSH sessions (`session.list`, read from `~/.dsh/sessions`) |
| Stop and keep chatting | — | ✅ cancels the current turn only; the session survives |

## 🤖 Copy this to your AI agent (recommended)

Paste the whole block below into Claude Code / Codex / Cursor / any agent that
can run commands. It reads the docs, probes your models, and installs
everything — **you only restart Paseo at the end**.

> It needs read/write access to `~/.dsh/` and `~/.paseo/` and permission to run
> shell commands. Grant that, but **read the block yourself first** — what it
> does should match what you want it to do.

````text
You are a deployment assistant. Connect Paseo on this machine to DeepSeek
Harness (DSH).

Repository: https://github.com/liuxing7954/paseo-dsh
Read docs/ADOPTION.md completely before changing anything. Do not edit files by
guesswork.

■ Step 1: check prerequisites
Confirm that dsh, paseo and node are on PATH, that paseo is >= 0.9.2 and that
dsh is >= 0.2.1. If anything is missing, stop and tell me; do not install it for
me.

■ Step 2: pick the model route
First check whether I already have a DSH profile: ls ~/.dsh/profiles/
If one exists, read its cordis.patch.yml and 【reuse the provider I already
configured】 (baseURL, apiKeyEnv, model ids). Do not make me type it again.
Only if nothing exists, ask me these three things:
  1. the LLM endpoint baseURL
  2. which environment variable holds the API key (or let me give you the key)
  3. which model ids to use
Store the key under `refs` in ~/.dsh/.credentials.yaml.
Never put the key in a file that could be committed, and never echo it in the
terminal.

■ Step 3: probe model capabilities (critical, do not skip)
  npx paseo-dsh probe --base-url <endpoint> --api-key-env <VAR> --model <model-id>
Take its YAML output 【verbatim】. It also tells you about two traps:
  - if the developer role is rejected -> set compat.supportsDeveloperRole: false
  - the `off` reasoning level must stay empty (no value)
  - if it reports `max`, list it explicitly in the config
If the probe fails, paste the full error to me; do not invent a config.

■ Step 4: install
Translate Paseo's "Plugins are trusted, unsandboxed code..." security notice
【verbatim】and ask me whether to continue. Install only after I agree:
  paseo plugin add npm:paseo-dsh
If the daemon is Paseo 0.12: the latest npm release (0.2.9) does not carry the
0.12 adaptation yet, so install from source instead:
  paseo plugin add github:liuxing7954/paseo-dsh:paseo-plugin
(The plugin provisions the DSH profile on first load; no script is needed.)
Restart the Paseo daemon afterwards.

■ Step 5: write the config
Put the fragment from step 3 into ~/.dsh/profiles/paseo/cordis.patch.yml and add
an agent-default-model entry pointing at my main model.
If that file already has content, only append; never overwrite.

■ Step 6: verify (do not skip)
  npx paseo-dsh doctor
(For a source/github install use the repository's own CLI instead of letting npx
download the published package:
  node <repo>/paseo-plugin/bin/paseo-dsh.mjs doctor)
Require it to be green (dsh/paseo versions, profile, bridge, route, key). Fix
any problem and run it again.
Then restart the Paseo daemon.

■ Step 7: report
Tell me:
  - what must be restarted (the Paseo daemon)
  - which provider to pick in Paseo afterwards
  - anything you could not do or are unsure about

If you get stuck, stop and ask. Do not guess, do not skip verification, and do
not fake success to finish the flow.
````

## Install (one line)

Use Paseo's own plugin installer:

```bash
paseo plugin add npm:paseo-dsh
paseo plugin ls          # confirm dsh-paseo is installed
```

> **npm version warning (2026-10-20)**: the latest published version on npm is
> `0.2.9` (2026-10-17), which does **not** carry the Paseo 0.12 adaptation
> (versioned `paseo-system` envelope, `agent_message` row semantics, official
> label icons, attachment content blocks). On Paseo 0.12 install from source, or
> wait for `0.2.10`:
>
> ```bash
> paseo plugin add github:liuxing7954/paseo-dsh:paseo-plugin
> ```
>
> Note that `liuxing7954/paseo-dsh` (without a prefix) is treated by Paseo as a
> **registry** source; `--path` is the old spelling of the `:plugin/path` suffix
> and fails outright on a registry source.

The plugin **provisions the DSH profile on first load** (default
`~/.dsh/profiles/paseo`; `DSH_PASEO_PROFILE` renames it — and the daemon must
then use the same value) together with the embedded stdio bridge — no clone, no
script. Updates use the same single path: `paseo plugin update` (works for both
npm and Git-hosted sources), then restart the daemon and the profile moves with
the plugin. A local `directory` source (`install.sh`) instead takes `git pull` +
a restart, see the next section.

After that, **one step remains: the model route** (it differs per setup and
cannot be automated). Two small steps:

### a) Tell DSH which endpoint and models to use

Edit `~/.dsh/profiles/paseo/cordis.patch.yml`. The plugin writes a commented
template and **never overwrites an existing file**. A complete example (replace
`my-gateway`, the endpoint and the model id with yours):

```yaml
- id: llm-pi-ai
  name: "@deepseek-ai/dsh-llm-pi-ai"
  config:
    providers:
      my-gateway:                       # route name, any value, keep it consistent below
        displayName: My Gateway
        apiKeyEnv: MY_GATEWAY_API_KEY   # key name in .credentials.yaml (see b)
        api: openai-completions
        baseURL: https://your-gateway/v1
        # Required when the gateway only accepts the system role and rejects
        # developer, otherwise every turn fails with 422.
        compat:
          supportsDeveloperRole: false
        # Only when the gateway supports vision; otherwise defaults to [text]
        # and images become placeholder text.
        defaultInput: [text, image]
        models:
          - id: your-model-id           # model id on the endpoint
            name: your-model-id
            reasoningEfforts:           # only with reasoning; otherwise false
              off:                      # empty = send nothing (most gateways reject the literal "off")
              low: low
              medium: medium
              high: high
              max: max                  # max/xhigh must be explicit; a missing key means unsupported
- id: agent-default-model
  name: "@deepseek-ai/dsh-agent-default-model"
  config:
    provider: my-gateway
    model: your-model-id
```

### b) Store the API key

Write it to `~/.dsh/.credentials.yaml` (**never** into a file that could be
committed):

```yaml
version: 1
refs:
  MY_GATEWAY_API_KEY: sk-xxxxxxxx
```

### c) Self-check and restart

```bash
npx paseo-dsh doctor
```

It checks the `dsh`/`paseo` versions, that the profile is ready, that the bridge
landed, that the route is filled in and that the key for `apiKeyEnv` exists — and
names whatever is missing (read-only, changes nothing). When it is green,
**restart the Paseo daemon** (`paseo daemon restart`) and pick the
**DeepSeek Harness** provider when you create a session.

> **Unsure whether the endpoint supports reasoning / thinking levels / vision?**
> Probe it with the same CLI; it calls the endpoint and prints the fragment for
> step a) (no clone needed either):
>
> ```bash
> npx paseo-dsh probe \
>   --base-url https://your-gateway/v1 \
>   --api-key-env MY_GATEWAY_API_KEY \
>   --model your-model-id
> ```
>
> It confirms the two most common traps: a gateway that rejects the `developer`
> role (add `compat.supportsDeveloperRole: false`) and the `off` level that must
> stay empty.

**The full walkthrough and pitfall list are in
[docs/ADOPTION.md](docs/ADOPTION.md).**

Links: npm package <https://www.npmjs.com/package/paseo-dsh> · Paseo community
directory <https://paseo.cafe/plugins/dsh-paseo> · discussion
<https://github.com/getpaseo/paseo/discussions/6375>

## Local development / offline install

When changing this repository, use `install.sh` to attach the checkout as a
**directory source**: it creates (or reuses) the DSH profile and registers the
plugin. The `dsh-bridge` symlink only covers the window before the plugin has
loaded: every load **deletes and rewrites the whole bridge** in the profile from
the embedded copy in `paseo-plugin/server/bridge-assets.ts`, so what actually runs
is always the embedded asset, never this checkout directory.

```bash
git clone https://github.com/liuxing7954/paseo-dsh && cd paseo-dsh
./install.sh --check     # show the prerequisites and which profile would be used, change nothing
./install.sh             # create/initialise the profile and register the plugin
```

> **After editing `dsh-bridge/` you must regenerate the embedded bridge**:
> `node paseo-plugin/scripts/generate-bridge-assets.mjs` (`npm publish`'s
> `prepack` runs it too), then reload the plugin / restart the daemon, or the
> plugin keeps bootstrapping from the old one. **`git pull` + a restart alone
> does not update the bridge.**

`--profile NAME` must match the daemon's `DSH_PASEO_PROFILE` — the plugin picks
which profile to start from that variable, and `install.sh` refuses a mismatch.
Run a custom profile like this, and persist the variable into `paseo.service`:

```bash
DSH_PASEO_PROFILE=dev ./install.sh --profile dev
# paseo.service: Environment=DSH_PASEO_PROFILE=dev
```

The install script never overwrites an existing model configuration, and backs
up every file it touches.

## Layout

```
paseo-dsh/
├── dsh-bridge/          # DSH side: stdio bridge bundle
│   ├── lib/index.js     #   entry: command line, stdin lifecycle, question bridging
│   ├── lib/transport.js #   built-in JSON-RPC line transport (server→client requests)
│   ├── lib/server.js    #   sessions / plan / thinking levels / catalog
│   └── cordis.patch.yml #   bundle patch: mounts the bridge and question tool on dsh-base
├── paseo-plugin/        # Paseo side: provider plugin (direct provider; npm package paseo-dsh)
│   ├── index.server.ts  #   registerProvider() + profile bootstrap on first load
│   ├── server/
│   │   ├── provider.ts  #   connection, catalog, session lifecycle, permission cards
│   │   ├── session.ts   #   one session: prompts → cards, plan, thinking, usage
│   │   ├── dsh-process.ts # the dsh child process one connection shares (cwd/route/MCP per session)
│   │   ├── timeline.ts  #   DSH session events → Paseo timeline
│   │   ├── bootstrap.ts #   bootstrap: profile files + embedded bridge on disk
│   │   └── bridge-assets.ts # generated: base64 copy of the bridge
│   ├── lib/             #   doctor (self-check) / probe (capability discovery)
│   └── bin/paseo-dsh.mjs#   npx paseo-dsh {doctor|probe}
├── tools/               # thin launchers for the probe tools (implemented in paseo-plugin/lib)
├── templates/           # profile config template (with the traps commented)
├── harness/             # standalone probes; verify the bridge and plugin without Paseo
└── docs/                # adoption guide + real-world defect notes
```

## How it works

```
the model calls ask_user_question
   └─ dsh-tool-ask-user → ctx.userQuestions.ask()
        └─ dsh-bridge: ctx.on('user-questions/request')
             └─ transport.request('paseo/question')   ← server→client request
                  └─ paseo-plugin: session.permission (kind: 'question', input.questions[])
                       └─ Paseo renders one card, steps through every question, submits once
                  ← returns { behavior:'allow', updatedInput:{ answers: { <header>: "B" } } }
             ← returns { answers:[{id, selected:['canary']}] }
        ← the tool returns, the model continues
```

The key point: **neither of DSH's official automation protocols has a
"server asks the client" channel** — ACP explicitly does not carry elicitation,
and the SDK protocol supports it in transport but the server never sends it. So
the bridge ships its own transport and fills that gap.

All Paseo sessions of **one** provider connection share **one**
`dsh --profile <name>` child process, talking newline-delimited JSON-RPC over
stdio. The working directory, the model route and the MCP servers are handed to
that process **per session** (DSH keeps them per session and needs no `chdir` at
runtime), so several sessions can be open in different workspaces at once; what
that saves is the 1.5–2.7 s CLI cold start on every new session. **Environment
variables are the exception** — they are process-wide, so only the environment at
the time the first session opened applies; when a later session asks for a
different value, the difference shows up as a warning on the timeline (key names
only, never values) instead of being silently ignored.

## Behaviour without local-patches

The host patches in `local-patches/` are **not a release artifact**: they rewrite
the `dist` of the installed `@getpaseo/server` (upstream has no extension point
for this), and the package published by `npm publish` does not contain them.
Installing them or not does not affect the plugin itself, but three things
degrade:

| Capability | With the patch | Without the patch |
|---|---|---|
| **Rewind** (conversation + files) | the UI refreshes immediately and the "rewind applied" notice at the bottom flashes past | the rewind **has already taken effect**: the conversation, the files the agent changed and the model's memory of them in context are all rolled back (the next request cannot see the rewound content, see the note about memory plugins below); the UI just does not refresh itself — the "rewind applied" notice appears at the bottom, and **Reload agent** or reopening the session shows the result |
| **"Running" on a second subagent dispatch** | same as the right column (that patch is retired; no patch covers this now) | the card stays on the previous turn's terminal state. Paseo upstream [#8080](https://github.com/getpaseo/paseo/pull/8080) has fixed it and merged to main; **wait for a Paseo release** |
| **Turn folding after reopening a session** | folding is correct | partly broken: system-triggered turns merge into the previous turn, and steered turns get split apart. Waiting on upstream [#8053](https://github.com/getpaseo/paseo/issues/8053) / PR [#8054](https://github.com/getpaseo/paseo/pull/8054) |

> Two things are unrelated to the patches: content a memory plugin has already
> collected may still be recalled (the model "remembers"); and a rewind itself
> cannot be undone.

Why the patches are not installed by default: they modify **Paseo's own dist**,
and the macOS desktop app ships a signed CLI that cannot be patched; a global CLI
install is also overwritten wholesale by every `npm i -g @getpaseo/cli`, so it
takes an `ExecStartPre` to reapply them on each start. They exist only as an
**optional accelerator** for maintainers; how to install them and how to handle
upgrades is in [local-patches/README.md](local-patches/README.md).

## Self-test / local verification (no Paseo needed)

**Run the bundled CLI self-check first** (read-only, changes nothing):

```bash
npx paseo-dsh doctor          # install integrity: CLIs/versions/profile/bridge/route/key
npx paseo-dsh probe --base-url <endpoint> --api-key-env <VAR> --model <model-id>   # endpoint capabilities
```

**Then assert on the protocol layer** (the UI is not trustworthy; the event
stream is):

```bash
node harness/catalog.mjs      # providers / models / each model's real thinking levels
node harness/probe.mjs        # one end-to-end question round trip
node harness/route-test.mjs   # test every route

# plugin-layer check (asserts event shapes, ignores the UI)
cd paseo-plugin
npx tsc --noEmit false --outDir .dbg --declaration false \
  --module commonjs --moduleResolution node
# ↑ under --moduleResolution node this prints TS2307 for @getpaseo/plugin/client,
#   which is expected: only the emitted JS is needed here; for type checking use
#   `npx tsc --noEmit`
echo '{"type":"commonjs"}' > .dbg/package.json
cp ../harness/plugin-check.cjs .dbg/ && cd .dbg && node plugin-check.cjs
rm -rf ../.dbg
```

`plugin-check.cjs` covers three things that **once failed silently**: whether
usage events carry real numbers, whether non-text content blocks were quietly
dropped, and whether an unknown input reports failure or lies about success.
None of those bugs are visible in the UI — nothing errors, it is just wrong.

The verification approach itself is worth reading: the UI is optimistic, cached
and can lie, so assertions belong on the protocol layer.
[ADOPTION.md section 5](docs/ADOPTION.md) explains how, including
counter-intuitive traps (such as `waitFor` matching a stale event and producing
a false diagnosis).

## Requirements

- Paseo ≥ 0.9.2 (needs the direct-provider plugin API)
- **DSH ≥ 0.2.1** (on the 0.2.x line): the bridge imports five DSH internal
  packages directly (`@deepseek-ai/dsh-cmdline` / `dsh-brand` / `dsh-llm` /
  `dsh-attachment` / `dsh-agent`), and 0.2.1 changed both prompt-variable
  registration and catalog materialisation timing. What has actually been tested
  is `0.2.1-rc.2` (2026-10-20); **0.2.0 and earlier are unverified**, and
  `doctor` reports anything below 0.2.1 as blocking.
- Node ≥ 18 (`paseo-dsh probe/doctor` use the built-in `fetch`; tested here on
  Node 22.23.1). The plugin itself runs on the Paseo daemon's Node, so the package
  does **not** declare `engines` — a minimum that was never tested does not go
  into a declaration.

## Interface language (Chinese / English)

The mode, thinking levels and permission/preset dropdowns in the composer, plus
the `/` slash menu, plan cards and tool cards, all follow the interface language.
**Display only — the values that get sent never change**: switching language
changes no id sent to DSH.

- The modes `build` / `plan`, the permission preset keys (`read-only` /
  `workspace-write` / `danger-full-access`), model and thinking-level ids and
  command names all travel through untouched.
- Slash commands **translate only the description and the argument hint; the
  command name stays English**, and the menu looks like this:

  ```text
  /goal       设置或查看长任务的目标
  /compact    压缩较早的对话历史
  /permission 切换权限预设（沙箱模式 + 审批策略）
  ```

  The control words inside an argument hint (`clear` / `pause` / `resume` /
  `edit` / `off`) also stay English — they are the syntax the command actually
  accepts, not copy. **No Chinese ever goes on the wire**: what DSH receives and
  what the session echoes back is always `/goal`.

  Why not translate the command name too? Paseo's command protocol
  (`AgentSlashCommand`) only carries `name` / `description` / `argumentHint` /
  `kind` — there is **no separate display-name field**, so whatever the menu shows
  is what goes back to the plugin. Translating `name` would put a Chinese name on
  the wire, and DSH's own slash parser only accepts `[a-z][a-z0-9_-]*`, so it
  would have to be mapped back; better to keep the name as the real one.

- Skills (`/paseo`, `/paseo-help`, `/paseo-plugin` and friends) **translate only
  the description in the menu**; the name stays, and so does the description the
  model reads (that text is what the model judges "should I use this skill" on).
  Why go through this indirection instead of editing the skill files: those skills
  are managed by Paseo — each skill directory carries a `.paseo-managed-files.json`
  with the hash of `SKILL.md`, and Paseo's sync rewrites the file whenever the
  content differs, so a manual edit is reverted. The Chinese descriptions
  therefore live in the plugin's `SKILL_COPY` table (`server/locale.ts`); a skill
  with no entry keeps its own text.

The language is decided in this order:

1. the `DSH_PASEO_LANG` environment variable — starts with `zh` → Chinese,
   anything else → English, overriding everything explicitly;
2. the daemon's own `LC_ALL` / `LC_MESSAGES` / `LANG` — starts with `zh` → Chinese;
3. neither → English.

So a Chinese system defaults to Chinese and an English system to English. To
force the other language, set it in **the environment that starts the daemon**
(restart the daemon afterwards; environment variables do not change inside a
running process):

```bash
DSH_PASEO_LANG=en paseo ...
```

When a command the dictionary does not cover shows up in the menu (the profile
mounts one more command plugin, or a DSH upgrade adds a command), that entry is
shown unchanged rather than disappearing — adding Chinese is one more entry in
`COMMAND_COPY` in `paseo-plugin/server/locale.ts`.

## Permission modes (opening the sandbox)

DSH defaults to **`workspace-write`**: it can only modify files inside the
session working directory, and anything else needs approval. Once a session
exists, the **Permissions** dropdown in the composer switches presets at any
time (equivalent to `/permission <preset>`):

- `read-only` — read only; ask for every change
- `workspace-write` — may modify the workspace (default)
- `danger-full-access` — no directory limit, no approval (**full trust**, use
  carefully)

To make **every new session start with full access**, add these two entries to
your profile `~/.dsh/profiles/paseo/cordis.patch.yml` (alongside the model
route):

```yaml
- id: sandbox-policy
  config:
    mode: danger-full-access
    workspaceRoot: !!js process.cwd()
- id: approval
  config:
    policy: never
```

Set `mode` back to `workspace-write` and `policy` back to `ask` to restore the
defaults, then restart the daemon.

## Agent presets (optional)

A DSH agent preset packages a persona and a set of capabilities as one choice.
The plugin does **not** require it — the **Preset** dropdown appears only when
your profile mounts `@deepseek-ai/dsh-agent-preset-registry` and declares
presets.

Semantics match DSH: **choose at session creation, locked after the first turn**
(a later change is rejected and snaps back).

Example (in the profile's `cordis.patch.yml`):

```yaml
- insert:
    - id: agent-preset-registry
      name: '@deepseek-ai/dsh-agent-preset-registry'
      config:
        default: standard
        selectedDefault: standard
    - id: preset-standard
      name: '@deepseek-ai/dsh-agent-preset'
      config:
        id: standard
        order: 1
        plugins:
          - id: persona
            name: '@deepseek-ai/dsh-persona'
            config:
              prefix: You are a helpful assistant.
              # Note: since DSH 0.2.1 only provider/model are registered
              # variables; {{cwd}} makes every turn fail.
```

> To give a preset extra tools (for example a domain plugin), add it to that
> preset's `plugins:`. Presets are additive: host tools stay available and a
> preset only owns the persona and incremental capabilities. Prefer clearing the
> host `system-prompt` persona (`personaPrefix: ''`) and letting each preset own
> its own, to avoid duplication.

## Version policy

The plugin's `major.minor` **follows the DSH line it targets**: a `0.2.x`
plugin targets DSH `0.2.x`, and the patch number is the plugin's own release
counter. Pick the version on the same line as `dsh` on your daemon.

The repository currently tracks `0.2.11`: the published `0.2.11` plus this
fork's multi-session rework (one `dsh` process serving several Paseo sessions)
and the rewind capability, **not yet published**. Publishing waits for local
verification.

## Changelog

User-visible changes per patch, in npm release order. For `0.2.x` the minor
follows the DSH line and the patch is this plugin's own counter; the full commit
history is on
[commits](https://github.com/liuxing7954/paseo-dsh/commits/main).

| Version | Date | Changes |
| --- | --- | --- |
| [0.2.16](https://www.npmjs.com/package/paseo-dsh/v/0.2.16) | 2026-10-28 | **The stats row returns to its default position**: the automatic tucking, DOM measurement and settings page from 0.2.15 are gone. The row only carries content (turns/steps, first token, tok/s, context, cache hit; tap to expand details) and leaves placement to Paseo and the theme, so it no longer moves when expanded, collapsed or under a theme. `0.2.15` is deprecated. |
| [0.2.15](https://www.npmjs.com/package/paseo-dsh/v/0.2.15) | 2026-10-28 | **The stats row sits with the turn footer**: the gap to the copy / model / time footer stays the same under the default theme and theme plugins. A completed turn flags its last row `final`; on web the row measures where the footer actually painted and tucks under it, native keeps a constant fallback.<br>**Configurable**: Settings → Plugins → "回答统计行" adjusts the gap (0–24px, default 6) and font size (10–16px, default 13); with no saved settings nothing changes.<br>**Type**: defaults to the footer's 13px with tabular numbers. |
| [0.2.14](https://www.npmjs.com/package/paseo-dsh/v/0.2.14) | 2026-10-28 | **Clearer stats line**: the session token total in the collapsed line became a context percentage (for example `上下文 77%`); the exact `used / limit` stays in the expanded details. Counts and cache-hit semantics are unchanged. |
| [0.2.13](https://www.npmjs.com/package/paseo-dsh/v/0.2.13) | 2026-10-28 | **Richer stats line**: the collapsed line always shows `N turns N steps · first token · tok/s · total tokens · cache hit`, matching DSH Web's accounting (total = uncached input + cache read + cache write + output; hit = cache read ÷ prompt-side total). Turns, steps and tokens are rebuilt from the session log on resume. Expanding still shows context, token buckets, route and tool details. |
| [0.2.12](https://www.npmjs.com/package/paseo-dsh/v/0.2.12) | 2026-10-28 | **Real streaming**: subscribes to DSH's live `agent/assistant-stream` frames (text and reasoning) and renders while the model writes instead of replaying after the step; the first character appears when the model emits it.<br>**Answer stats row**: `first token · tok/s` under each answer, expandable to context, input/cache/output tokens, route and thinking level, tool count and time; speed uses DSH's own chunk timestamps and drops burst artifacts. |
| [0.2.11](https://www.npmjs.com/package/paseo-dsh/v/0.2.11) | 2026-10-28 | **Context usage**: shows `used / limit` next to the composer. The bridge gained `paseo/usage`, reading occupancy from DSH's `contextPressure` (falling back to `tokenMeter.measure()`) and capacity from `resolveModelInfo()` for the current route; refreshes on open/resume, turn end, model switch and compaction, so a resumed session has numbers without a new turn. This fork reports per session (`usage(sessionId)`), so each session keeps its own numbers while one `dsh` process serves several Paseo sessions.<br>**Install compatibility with Paseo 0.9–0.11**: dropped the `@getpaseo/protocol` type-only import (a local `json-value.ts` instead), so older installers stop failing to resolve it.<br>**Character-by-character answers**: upstream replays text with a `data.stream` timer in `server/stream-replay.ts` once `assistant/message` arrives; **this fork does not adopt it** — the bridge subscribes to DSH's live frames and emits `paseo/assistant-delta`, which is already real streaming, and stacking both would stream twice, so that file has been deleted. |
| [0.2.10](https://www.npmjs.com/package/paseo-dsh/v/0.2.10) | 2026-10-27 | **Attachments no longer kill the session**: `uploaded_file`, review and GitHub/forge attachments become text references (name, type, size, path, or title/url/body) the model can still read; content conversion moved inside `try`, so one bad message no longer escalates to `session.runtime_failed`.<br>**Registry overview**: added `OVERVIEW.md` and a package description for the paseo.sh listing. |
| [0.2.9](https://www.npmjs.com/package/paseo-dsh/v/0.2.9) | 2026-10-17 | **Model picker no longer empty**: DSH 0.2.1 materializes its catalog asynchronously while Paseo's probe skips `initialize`; the catalog now warms the default route and polls briefly (about 3s) until models register. |
| [0.2.8](https://www.npmjs.com/package/paseo-dsh/v/0.2.8) | 2026-10-17 | **Fix every turn failing on DSH 0.2.1**: 0.2.1-rc registers only `provider` and `model` prompt variables, so `{{cwd}}` in the persona failed each turn with `unknown prompt variable`; removed it and left cwd to the runtime context. |
| [0.2.7](https://www.npmjs.com/package/paseo-dsh/v/0.2.7) | 2026-10-14 | **Distinguishable import list**: each row shows the session title and the first real user message; log prefixes are read concurrently so 40 sessions list in under a second. |
| [0.2.6](https://www.npmjs.com/package/paseo-dsh/v/0.2.6) | 2026-10-14 | **Chinese text**: the npm page and the paseo.cafe listing show Chinese and English descriptions together. |
| [0.2.5](https://www.npmjs.com/package/paseo-dsh/v/0.2.5) | 2026-10-14 | **Reopen replays history**: the bridge gained `paseo/sessions` and `paseo/history`, reading the log by DSH session id and replaying real user turns and tool items.<br>**Import native DSH sessions**: declares `session.list` and lists sessions from `~/.dsh/sessions`. |
| [0.2.4](https://www.npmjs.com/package/paseo-dsh/v/0.2.4) | 2026-10-09 | **Sessions survive a plugin reload or daemon restart**: added a `session.persistence` handle (`plugin:` prefix) and reached the uninjected `sessions` service through `ctx.get()`, fixing two consecutive errors on reopen. |
| [0.2.3](https://www.npmjs.com/package/paseo-dsh/v/0.2.3) | 2026-10-09 | **Preset dropdown**: when the profile mounts `agent-preset-registry`, the composer offers persona plus capability bundles; chosen at creation, locked after the first turn.<br>**More upgrade-tolerant profile**: existing `package.json`, `cordis.yml` and `pnpm-workspace.yaml` are no longer overwritten. |
| [0.2.2](https://www.npmjs.com/package/paseo-dsh/v/0.2.2) | 2026-10-09 | **Permissions dropdown**: switch DSH sandbox presets (`read-only`, `workspace-write`, `danger-full-access`) from the composer, equivalent to `/permission <preset>`; the bridge gained `paseo/permission`. |
| [0.2.1](https://www.npmjs.com/package/paseo-dsh/v/0.2.1) | 2026-10-09 | **Bundled CLI**: `npx paseo-dsh doctor` read-only checks the CLIs, profile, bridge, route and key; `npx paseo-dsh probe` discovers real endpoint capabilities. No clone needed to self-check and probe models after install.<br>The walkthrough gained a complete model-route example. |
| [0.2.0](https://www.npmjs.com/package/paseo-dsh/v/0.2.0) | 2026-10-09 | **First public release**: DSH as a native Paseo provider (not ACP); native `ask_user_question` cards, Build / Plan modes, thinking levels from each model's real declaration, steering, end-to-end images, `/` command and skill menu; the plugin bootstraps the DSH profile on first load, so `paseo plugin add npm:paseo-dsh` is the whole install. |

> `0.1.x` was local-only and never published to npm; `0.0.0-stage` was a placeholder before the first release.

## Documentation

- [docs/ADOPTION.md](docs/ADOPTION.md) — adoption guide: what changes, how to configure it, the pitfall list
- [docs/FIELD-NOTES.md](docs/FIELD-NOTES.md) — sixty-odd real defects: symptom → root cause → fix
- [AGENTS.md](AGENTS.md) — notes for AI agents (Codex and others read it automatically). Read it first whether you were asked to install or to change this repository (written in Chinese)

## Contact

Stuck while using it, found a doc error, or connected it to another runtime? Email
me:

**jixy · [467677527@qq.com](mailto:467677527@qq.com)**

Issues work too, but email is faster.

## License

MIT, see [LICENSE](LICENSE).
