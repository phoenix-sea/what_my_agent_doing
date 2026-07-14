#!/usr/bin/env node

const fs = require("node:fs");
const http = require("node:http");
const https = require("node:https");
const path = require("node:path");
const { URL } = require("node:url");

const host = process.env.HOST || "127.0.0.1";
const port = Number(process.env.PORT || 8080);
const targetOrigin = new URL(process.env.ANTHROPIC_PROXY_TARGET || "https://api.anthropic.com");
const logDir = path.resolve(process.env.LOG_DIR || "logs/anthropic-proxy");
const preserveAcceptEncoding = process.env.PRESERVE_ACCEPT_ENCODING === "1";

fs.mkdirSync(logDir, { recursive: true });

let nextRequestId = 1;

function timestamp() {
  return new Date().toISOString();
}

function filenameTimestamp() {
  return timestamp().replace(/[:.]/g, "-");
}

function toRawHeaders(headers) {
  return Object.entries(headers)
    .flatMap(([name, value]) => {
      if (Array.isArray(value)) {
        return value.map((item) => `${name}: ${item}`);
      }
      if (value === undefined) {
        return [];
      }
      return [`${name}: ${value}`];
    })
    .join("\n");
}

function bodyForLog(headers, body) {
  if (body.length === 0) {
    return "";
  }

  const contentType = String(headers["content-type"] || "");
  const looksText =
    contentType.startsWith("text/") ||
    contentType.includes("json") ||
    contentType.includes("xml") ||
    contentType.includes("x-ndjson") ||
    contentType.includes("event-stream");

  if (looksText || contentType === "") {
    return body.toString("utf8");
  }

  return `[base64:${body.toString("base64")}]`;
}

function writeLogFile(requestId, startedAt, sections) {
  const logPath = path.join(logDir, `${startedAt}-${String(requestId).padStart(4, "0")}.log`);
  fs.writeFileSync(logPath, sections.join("\n\n"), "utf8");
  return logPath;
}

function buildUpstreamOptions(req, body) {
  const upstreamHeaders = { ...req.headers };
  upstreamHeaders.host = targetOrigin.host;
  upstreamHeaders["content-length"] = Buffer.byteLength(body);

  if (!preserveAcceptEncoding) {
    upstreamHeaders["accept-encoding"] = "identity";
  }

  const upstreamUrl = new URL(req.url, targetOrigin);

  return {
    protocol: targetOrigin.protocol,
    hostname: targetOrigin.hostname,
    port: targetOrigin.port || undefined,
    method: req.method,
    path: `${upstreamUrl.pathname}${upstreamUrl.search}`,
    headers: upstreamHeaders,
  };
}

function requestBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];

    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

const server = http.createServer(async (req, res) => {
  const requestId = nextRequestId++;
  const startedAt = filenameTimestamp();
  const requestStarted = timestamp();

  let body;
  try {
    body = await requestBody(req);
  } catch (error) {
    res.writeHead(400, { "content-type": "text/plain" });
    res.end(`Could not read request body: ${error.message}\n`);
    return;
  }

  const upstreamOptions = buildUpstreamOptions(req, body);
  const upstreamStarted = timestamp();

  const sections = [
    `# Anthropic proxy capture ${requestId}`,
    `## Client request\n${req.method} ${req.url} HTTP/${req.httpVersion}\n${toRawHeaders(req.headers)}\n\n${bodyForLog(req.headers, body)}`,
    `## Upstream request\n${req.method} ${upstreamOptions.protocol}//${upstreamOptions.hostname}${upstreamOptions.path}\n${toRawHeaders(upstreamOptions.headers)}\n\n${bodyForLog(upstreamOptions.headers, body)}`,
  ];

  const transport = targetOrigin.protocol === "http:" ? http : https;
  const upstreamReq = transport.request(upstreamOptions, (upstreamRes) => {
    const responseChunks = [];

    res.writeHead(upstreamRes.statusCode || 502, upstreamRes.headers);

    upstreamRes.on("data", (chunk) => {
      responseChunks.push(chunk);
      res.write(chunk);
    });

    upstreamRes.on("end", () => {
      res.end();

      const responseBody = Buffer.concat(responseChunks);
      sections.push(
        `## Upstream response\nHTTP/${upstreamRes.httpVersion} ${upstreamRes.statusCode} ${upstreamRes.statusMessage}\n${toRawHeaders(upstreamRes.headers)}\n\n${bodyForLog(upstreamRes.headers, responseBody)}`,
        `## Timing\nclient_request_started: ${requestStarted}\nupstream_request_started: ${upstreamStarted}\nresponse_finished: ${timestamp()}`,
      );

      const logPath = writeLogFile(requestId, startedAt, sections);
      console.log(`[${requestId}] ${req.method} ${req.url} -> ${upstreamRes.statusCode} ${logPath}`);
    });
  });

  upstreamReq.on("error", (error) => {
    sections.push(`## Proxy error\n${error.stack || error.message}`);
    const logPath = writeLogFile(requestId, startedAt, sections);
    console.error(`[${requestId}] upstream error: ${error.message} ${logPath}`);

    if (!res.headersSent) {
      res.writeHead(502, { "content-type": "text/plain" });
    }
    res.end(`Anthropic proxy upstream error: ${error.message}\n`);
  });

  upstreamReq.end(body);
});

server.listen(port, host, () => {
  console.log(`Anthropic proxy listening at http://${host}:${port}`);
  console.log(`Forwarding to ${targetOrigin.origin}`);
  console.log(`Writing captures to ${logDir}`);
  console.log(`Use: ANTHROPIC_BASE_URL=http://${host}:${port}/v1 claude`);
});
