# what_my_agent_doing

Trying to debug and understand Claude/Codex efficiency.

## Capture Claude Code Anthropic traffic

Claude Code respects the `ANTHROPIC_BASE_URL` environment variable, so you can point
it at a local HTTP proxy and capture requests and responses without installing local
TLS certificates.

This repo includes a dependency-free Node.js proxy that listens locally, forwards to
`https://api.anthropic.com`, streams responses back to Claude Code, and writes one
capture file per request under `logs/anthropic-proxy/`.

### Run the proxy

Requirements:

- Node.js 18 or newer
- Claude Code configured with your normal Anthropic credentials

Start the proxy:

```bash
node scripts/anthropic-proxy.js
```

In another shell, point Claude Code to the proxy:

```bash
export ANTHROPIC_BASE_URL="http://127.0.0.1:8080/v1"
claude
```

PowerShell equivalent:

```powershell
$env:ANTHROPIC_BASE_URL = "http://127.0.0.1:8080/v1"
claude
```

### Configuration

The proxy can be configured with environment variables:

| Variable | Default | Description |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | Local interface to bind. |
| `PORT` | `8080` | Local port to listen on. |
| `LOG_DIR` | `logs/anthropic-proxy` | Directory for request/response captures. |
| `ANTHROPIC_PROXY_TARGET` | `https://api.anthropic.com` | Upstream Anthropic API origin. |
| `PRESERVE_ACCEPT_ENCODING` | unset | Set to `1` to keep the client's original `Accept-Encoding`; by default the proxy asks for identity encoding so response logs are readable. |

Example with a custom port:

```bash
PORT=9090 node scripts/anthropic-proxy.js
export ANTHROPIC_BASE_URL="http://127.0.0.1:9090/v1"
claude
```

### Security note

Capture files can contain prompts, completions, tool payloads, account metadata, and
API credentials. The `logs/` directory is ignored by git, but treat the files as
sensitive and delete them when you no longer need them.
