/**
 * Vercel serverless entry point (ESM — package.json has "type": "module").
 * server.cjs is CommonJS; Node interop gives us module.exports as default.
 * The Express app is invoked directly by the platform — no listen() here.
 *
 * vercel.json rewrites all non-static routes to this function (/api),
 * so Express sees the original path (/, /api/*, SPA fallback).
 */
import app from "../server.cjs";

export default app;
