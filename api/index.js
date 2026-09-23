/**
 * Vercel serverless entry point.
 * Re-exports the Express app from server.cjs (no listen() on Vercel —
 * the platform invokes the handler directly).
 *
 * vercel.json rewrites all non-static routes here, so Express sees the
 * original request path (/, /api/*, SPA fallback) and handles everything.
 */
"use strict";

const app = require("../server.cjs");

module.exports = app;
