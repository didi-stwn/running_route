// src/setupProxy.js
const { createProxyMiddleware } = require('http-proxy-middleware');

module.exports = function(app) {
  // Target 1: Open Topo Data
  app.use(
    '/api-topo',
    createProxyMiddleware({
      target: 'https://api.opentopodata.org',
      changeOrigin: true,
      pathRewrite: { '^/api-topo': '' }, // Removes /api-topo before sending to target
    })
  );

  // Target 2: Open-Elevation
  app.use(
    '/api-elevation',
    createProxyMiddleware({
      target: 'https://api.open-elevation.com',
      changeOrigin: true,
      pathRewrite: { '^/api-elevation': '' }, // Removes /api-elevation before sending to target
    })
  );
};