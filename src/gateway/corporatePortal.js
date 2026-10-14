// ====================================================================
// Corporate Portal Gateway
// Manages self-hosted corporate routing and optional external portal proxying
// Features: credential stripping, redirect rewriting, and graceful fallback
// ====================================================================

const https = require('https');
const http = require('http');
const logger = require('../utils/logger');
const metrics = require('../utils/metrics');
const { renderDashboard } = require('../views/dashboard');

/**
 * Dispatches an HTTP request either to the optional external portal or to self-hosted dashboard
 * @param {http.IncomingMessage} req
 * @param {http.ServerResponse}  res
 * @param {string}               portalOrigin - Target origin URL (optional)
 */
function proxyRequest(req, res, portalOrigin) {
    metrics.incrementRequests();

    // 100% Self-Hosted Mode: If no external origin configured, render self-hosted dashboard directly
    if (!portalOrigin) {
        return renderDashboard(res);
    }

    let targetUrl;
    try {
        targetUrl = new URL(portalOrigin);
    } catch (_) {
        logger.warn('Gateway', `Invalid PORTAL_ORIGIN configured: "${portalOrigin}". Falling back to self-hosted dashboard.`);
        return renderDashboard(res);
    }

    // Build upstream headers — strip hop-by-hop & sensitive client credentials
    const upstreamHeaders = { ...req.headers };
    delete upstreamHeaders['connection'];
    delete upstreamHeaders['upgrade'];
    delete upstreamHeaders['keep-alive'];
    delete upstreamHeaders['cookie'];
    delete upstreamHeaders['authorization'];
    delete upstreamHeaders['proxy-authorization'];
    upstreamHeaders.host = targetUrl.hostname;

    const isHttps = targetUrl.protocol === 'https:';
    const client = isHttps ? https : http;
    const defaultPort = isHttps ? 443 : 80;

    const options = {
        hostname: targetUrl.hostname,
        port: targetUrl.port ? parseInt(targetUrl.port, 10) : defaultPort,
        path: req.url,
        method: req.method,
        headers: upstreamHeaders,
        timeout: 8000
    };

    let fallbackTriggered = false;
    const fallbackToDashboard = () => {
        if (fallbackTriggered || res.headersSent) return;
        fallbackTriggered = true;
        renderDashboard(res);
    };

    const proxyReq = client.request(options, (proxyRes) => {
        // If upstream returns 5xx error or redirect that needs sanitization
        const responseHeaders = { ...proxyRes.headers };
        delete responseHeaders['transfer-encoding'];
        delete responseHeaders['connection'];
        delete responseHeaders['keep-alive'];

        // Prevent anti-framing / strict external CSP from breaking the site
        delete responseHeaders['content-security-policy'];
        delete responseHeaders['x-frame-options'];

        // Rewrite redirect Location header to prevent external domain de-cloaking
        if (responseHeaders['location'] && responseHeaders['location'].startsWith(targetUrl.origin)) {
            responseHeaders['location'] = responseHeaders['location'].replace(targetUrl.origin, '');
        }

        // Standard corporate gateway headers
        responseHeaders['Server'] = 'ERP-Gateway/2.4';
        responseHeaders['X-ERP-Gateway-Route'] = 'portal-mesh';

        res.writeHead(proxyRes.statusCode, responseHeaders);
        proxyRes.pipe(res, { end: true });
    });

    proxyReq.on('error', (err) => {
        logger.warn('Gateway', `External portal dispatch failed (${err.message}). Gracefully falling back to self-hosted dashboard.`);
        fallbackToDashboard();
    });

    proxyReq.on('timeout', () => {
        logger.warn('Gateway', 'External portal request timed out. Gracefully falling back to self-hosted dashboard.');
        proxyReq.destroy();
        fallbackToDashboard();
    });

    req.on('error', () => { if (!proxyReq.destroyed) proxyReq.destroy(); });
    req.on('close', () => { if (!proxyReq.destroyed) proxyReq.destroy(); });

    req.pipe(proxyReq, { end: true });
}

module.exports = { proxyRequest };
