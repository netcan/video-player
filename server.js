const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");

const PORT = Number(process.env.PORT || 3000);
const PUBLIC_DIR = process.cwd();
const PROXY_PREFIX = "/proxy/";

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
};

const server = http.createServer(async (req, res) => {
  const requestUrl = new URL(req.url, `http://${req.headers.host}`);
  const { pathname } = requestUrl;

  if (pathname.startsWith(PROXY_PREFIX)) {
    await handleProxy(requestUrl, req, res);
    return;
  }

  if (req.method === "OPTIONS") {
    res.writeHead(204, corsHeaders());
    res.end();
    return;
  }

  await serveStatic(requestUrl, res);
});

server.listen(PORT, () => {
  console.log(`Dev server running at http://localhost:${PORT}`);
  console.log(`Proxy any URL via ${PROXY_PREFIX}<https://domain/path.m3u8>`);
});

async function handleProxy(requestUrl, clientReq, clientRes) {
  if (clientReq.method === "OPTIONS") {
    clientRes.writeHead(204, corsHeaders());
    clientRes.end();
    return;
  }

  const targetSpec = `${requestUrl.pathname.slice(PROXY_PREFIX.length)}${requestUrl.search}`;

  let targetUrl;
  try {
    targetUrl = new URL(targetSpec);
  } catch (error) {
    clientRes.writeHead(400, corsHeaders({ "content-type": "text/plain; charset=utf-8" }));
    clientRes.end(`Invalid proxy target: ${targetSpec}`);
    return;
  }

  const protocolClient = targetUrl.protocol === "http:" ? http : https;
  const requestHeaders = {
    ...clientReq.headers,
    host: targetUrl.host,
  };
  delete requestHeaders.origin;
  delete requestHeaders.referer;

  const proxyReq = protocolClient.request(
    {
      protocol: targetUrl.protocol,
      hostname: targetUrl.hostname,
      port: targetUrl.port || (targetUrl.protocol === "https:" ? 443 : 80),
      method: clientReq.method,
      path: `${targetUrl.pathname}${targetUrl.search}`,
      headers: requestHeaders,
    },
    (proxyRes) => {
      const headers = corsHeaders(proxyRes.headers);
      clientRes.writeHead(proxyRes.statusCode || 500, headers);
      proxyRes.pipe(clientRes);
    },
  );

  proxyReq.on("error", (error) => {
    console.error("Proxy error:", error);
    if (!clientRes.headersSent) {
      clientRes.writeHead(502, corsHeaders({ "content-type": "text/plain; charset=utf-8" }));
    }
    clientRes.end("Proxy request failed.");
  });

  clientReq.pipe(proxyReq);
}

async function serveStatic(requestUrl, res) {
  try {
    let pathname = decodeURI(requestUrl.pathname);
    if (pathname.endsWith("/")) {
      pathname = `${pathname}index.html`;
    }

    const filePath = path.join(PUBLIC_DIR, pathname);

    if (!filePath.startsWith(PUBLIC_DIR)) {
      res.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
      res.end("Forbidden");
      return;
    }

    const stat = await fs.promises.stat(filePath).catch(() => null);
    if (!stat || !stat.isFile()) {
      if (pathname !== "/index.html") {
        await serveIndexFallback(res);
        return;
      }
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end("Not found");
      return;
    }

    const mimeType = MIME_TYPES[path.extname(filePath).toLowerCase()] || "application/octet-stream";
    res.writeHead(200, { "content-type": mimeType });
    fs.createReadStream(filePath).pipe(res);
  } catch (error) {
    console.error("Static file error:", error);
    res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
    res.end("Internal server error");
  }
}

async function serveIndexFallback(res) {
  const indexPath = path.join(PUBLIC_DIR, "index.html");
  try {
    await fs.promises.access(indexPath, fs.constants.R_OK);
    res.writeHead(200, { "content-type": MIME_TYPES[".html"] });
    fs.createReadStream(indexPath).pipe(res);
  } catch {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("Not found");
  }
}

function corsHeaders(extra = {}) {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-credentials": "true",
    "access-control-allow-headers": "*",
    "access-control-allow-methods": "GET,HEAD,POST,OPTIONS",
    ...extra,
  };
}
