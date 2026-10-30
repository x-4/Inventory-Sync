// ====================================================================
// Portal Gateway
// Manages self-hosted routing and optional external portal proxying
// Features: credential stripping, redirect rewriting, and graceful fallback
// ====================================================================

const https = require('https');
const http = require('http');
const logger = require('../utils/logger');
const metrics = require('../utils/metrics');
const { renderDashboard } = require('../views/dashboard');

/**
 * Dispatches an HTTP request to optional external portal or self-hosted dashboard
 * @param {http.IncomingMessage} req
 * @param {http.ServerResponse}  res
 * @param {string}               portalOrigin - Target origin URL (optional)
 */
function proxyRequest(req, res, portalOrigin) {
    metrics.incrementRequests();

    // Self-Hosted Mode: render dashboard directly if no external origin configured
    if (!portalOrigin) {
        return renderDashboard(res);
    }

    let targetUrl;
    try {
        targetUrl = new URL(portalOrigin);
    } catch (_) {
        logger.warn('Portal', `Invalid PORTAL_ORIGIN: "${portalOrigin}". Falling back to self-hosted dashboard.`);
        return renderDashboard(res);
    }

    // Build upstream headers — strip hop-by-hop & sensitive credentials
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
        const responseHeaders = { ...proxyRes.headers };
        delete responseHeaders['transfer-encoding'];
        delete responseHeaders['connection'];
        delete responseHeaders['keep-alive'];

        // Prevent external CSP from breaking the portal
        delete responseHeaders['content-security-policy'];
        delete responseHeaders['x-frame-options'];

        // Rewrite redirect Location header
        if (responseHeaders['location'] && responseHeaders['location'].startsWith(targetUrl.origin)) {
            responseHeaders['location'] = responseHeaders['location'].replace(targetUrl.origin, '');
        }

        // Standard gateway headers
        responseHeaders['Server'] = 'Sync-Gateway/2.5';
        responseHeaders['X-Gateway-Route'] = 'portal-mesh';
        responseHeaders['X-Content-Type-Options'] = 'nosniff';
        responseHeaders['X-Frame-Options'] = 'SAMEORIGIN';

        res.writeHead(proxyRes.statusCode, responseHeaders);
        proxyRes.pipe(res, { end: true });
    });

    proxyReq.on('error', (err) => {
        logger.warn('Portal', `External portal dispatch failed (${err.message}). Falling back to dashboard.`);
        fallbackToDashboard();
    });

    proxyReq.on('timeout', () => {
        logger.warn('Portal', 'External portal request timed out. Falling back to dashboard.');
        proxyReq.destroy();
        fallbackToDashboard();
    });

    req.on('error', () => { if (!proxyReq.destroyed) proxyReq.destroy(); });
    req.on('close', () => { if (!proxyReq.destroyed) proxyReq.destroy(); });

    req.pipe(proxyReq, { end: true });
}

module.exports = { proxyRequest };
