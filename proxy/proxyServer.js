const express = require('express');
const { createProxyMiddleware } = require('http-proxy-middleware');
const cors = require('cors');

const app = express();
const PORT = 3001;

// Enable CORS for all routes
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['X-Git-Username', 'X-Git-Password', 'X-Requested-With']
}));

// Proxy configuration
const gitProxy = createProxyMiddleware({
  target: '', // Dynamic target will be set in router
  changeOrigin: true,
  pathRewrite: (path, req) => {
    const targetUrl = new URL(req.query.url);
    return targetUrl.pathname + targetUrl.search;
  },
  router: (req) => {
    // Extract target URL from query parameter
    const targetUrl = new URL(req.query.url);
    return `${targetUrl.protocol}//${targetUrl.host}`;
  },
  onProxyReq: (proxyReq, req, res) => {
    // Add Basic Auth header if credentials are provided
    if (req.headers['x-git-username'] && req.headers['x-git-password']) {
      const auth = Buffer.from(
        `${req.headers['x-git-username']}:${req.headers['x-git-password']}`
      ).toString('base64');
      proxyReq.setHeader('Authorization', `Basic ${auth}`);
    }
  }
});

// Proxy endpoint
app.use('/proxy', gitProxy);

// Start the server
app.listen(PORT, () => {
  console.log(`Git proxy server running on port ${PORT}`);
});