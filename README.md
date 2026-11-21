# codex-p-proxy

> **For personal use.** Built for using my own ChatGPT subscription, on my own machine, by myself.

A local server that wraps `codex exec` (Codex CLI) in an OpenAI-compatible API. It's the Codex version of [claude-p-proxy](https://github.com/hunkim/claude-p-proxy).
Point any SDK's `base_url` at it and it just works. Supports text, streaming, image input, and function calling.

## Install & run

```bash
git clone https://github.com/hunkim/codex-p-proxy && cd codex-p-proxy
npm install          # also installs the Codex CLI
npx codex login      # first time only: sign in with your ChatGPT account
npm start            # http://127.0.0.1:8790
```

If you already have `codex` installed globally, `node server.mjs` works without `npm install`.

Change the port with `npm start -- --port 9000`. If you don't set one and 8790 is busy, it moves on to 8791, 8792, … automatically. The startup screen prints the actual `base_url` to use.

## Usage

```python
from openai import OpenAI
c = OpenAI(base_url="http://127.0.0.1:8790/v1", api_key="local")
print(c.chat.completions.create(model="gpt-6.2-sol",
      messages=[{"role": "user", "content": "Hello"}]).choices[0].message.content)
```

For chat UIs like Open WebUI or LibreChat, use `http://127.0.0.1:8790/v1` as the OpenAI-compatible URL.

## Endpoints

- `POST /v1/chat/completions` — OpenAI-compatible
- `GET /v1/models` (the `codex debug models` list), `GET /health`

Model names in the list are used as is; anything else (like `gpt-4o`) goes to `DEFAULT_MODEL` (or the Codex default model).
`reasoning_effort` (low to ultra) is passed on as `model_reasoning_effort`.

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `HOST` / `PORT` | `127.0.0.1` / `8790` | `--port` takes precedence over `PORT` |
| `DEFAULT_MODEL` | (Codex default) | |
| `DEFAULT_EFFORT` | `low` | When the request has no `reasoning_effort` |
| `MAX_CONCURRENT` | `2` | Number of `codex` processes run at once |
| `LOCAL_API_KEY` | (none) | If set, checks `Authorization: Bearer` |
| `TIMEOUT_MS` | `300000` | Time limit per request |
| `DEFAULT_SYSTEM` | A short instruction | Used when there's no system message |
| `MAX_IMAGE_BYTES` | 10MB | Max size for URL images |
| `CODEX_BIN` | auto | CLI path (default: the CLI in `node_modules` → `codex` on PATH) |

## How it works

- Each request runs `codex exec --json --ephemeral -s read-only` in an empty temp folder. It doesn't read `~/.codex/config.toml` (MCP servers, hooks, default model); it only uses your login.
- Codex is a coding agent, so by default it adds lots of skill, plugin, and sandbox instructions plus tools. These are turned off and the system prompt is replaced, cutting input tokens per request from about 17k to 4.5k.
- The conversation history is merged into one text prompt. Images are saved as temp files and passed with `--image`; the server downloads URL images itself.
- Function calling: tool definitions go into the system prompt, the model is asked to answer with a `<tool_calls>[...]</tool_calls>` JSON block, and the server extracts it and returns it as `tool_calls`. Arguments aren't guaranteed to match the schema, so validate them where it matters.
- `OPENAI_API_KEY` and `CODEX_API_KEY` are removed from the child process so only your subscription is used.

## Limitations

- **Streaming isn't real.** `codex exec` doesn't output tokens as they're generated, so the answer is sent in one piece once it's finished.
- A few seconds until the first response (process startup), and a fixed cost of about 4.5k input tokens per request
- temperature, max_tokens, stop, etc. are ignored; PDF and audio input aren't supported
- Usage counts against the same subscription limits as the ChatGPT app and Codex
