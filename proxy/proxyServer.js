const express = require('express');
const { createProxyMiddleware } = require('http-proxy-middleware');
const cors = require('cors');
const morgan = require('morgan');

// Custom logging function
function logRequest(message) {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] [Git Proxy] ${message}`);
}

const app = express();
const PORT = 3001;

// Setup request logging
app.use(morgan(':method :url :status :res[content-length] - :response-time ms', {
  stream: {
    write: (message) => {
      console.log(`[Git Proxy] ${message.trim()}`);
    }
  }
}));

// Log all errors
app.use((err, req, res, next) => {
  logRequest(`Error: ${err.message}`);
  next(err);
});

// Enable CORS for all routes
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['X-Git-Username', 'X-Git-Password', 'X-Requested-With', 'Content-Type', 'Authorization'],
  exposedHeaders: ['Access-Control-Allow-Origin', 'Access-Control-Allow-Methods', 'Access-Control-Allow-Headers']
}));

// Proxy configuration
const gitProxy = createProxyMiddleware({
  target: '', // Dynamic target will be set in router
  changeOrigin: true,
  logLevel: 'debug',
  logProvider: () => ({
    log: logRequest,
    debug: (msg) => logRequest(`DEBUG: ${msg}`),
    info: (msg) => logRequest(`INFO: ${msg}`),
    warn: (msg) => logRequest(`WARN: ${msg}`),
    error: (msg) => logRequest(`ERROR: ${msg}`)
  }),
  pathRewrite: (path, req) => {
    const targetUrl = new URL(req.query.url);
    const newPath = targetUrl.pathname + targetUrl.search;
    logRequest(`Rewriting path: ${path} -> ${newPath}`);
    return newPath;
  },
  router: (req) => {
    // Extract target URL from query parameter
    const targetUrl = new URL(req.query.url);
    const target = `${targetUrl.protocol}//${targetUrl.host}`;
    logRequest(`Routing to target: ${target}`);
    return target;
  },
  onProxyReq: (proxyReq, req, res) => {
    logRequest(`Proxying ${req.method} request to: ${req.query.url}`);
    
    // Add Basic Auth header if credentials are provided
    if (req.headers['x-git-username'] && req.headers['x-git-password']) {
      const auth = Buffer.from(
        `${req.headers['x-git-username']}:${req.headers['x-git-password']}`
      ).toString('base64');
      proxyReq.setHeader('Authorization', `Basic ${auth}`);
      logRequest('Added Basic Auth header');
    } else {
      logRequest('No authentication credentials provided');
    }
    
    // Log headers being sent (excluding sensitive data)
    const headers = { ...proxyReq.getHeaders() };
    if (headers.authorization) headers.authorization = '[REDACTED]';
    logRequest(`Request headers: ${JSON.stringify(headers)}`);
  },
  onProxyRes: (proxyRes, req, res) => {
    logRequest(`Received response: ${proxyRes.statusCode} ${proxyRes.statusMessage}`);
    // Log response headers
    logRequest(`Response headers: ${JSON.stringify(proxyRes.headers)}`);
  },
  onError: (err, req, res) => {
    logRequest(`Proxy error: ${err.message}`);
    res.writeHead(500, {
      'Content-Type': 'text/plain'
    });
    res.end(`Proxy error: ${err.message}`);
  }
});

// Proxy endpoint
app.use('/proxy', gitProxy);

// Start the server
app.listen(PORT, () => {
  logRequest(`Git proxy server running on port ${PORT}`);
  logRequest(`CORS enabled with origin: *`);
  logRequest(`Server ready to handle Git requests`);
});