// Dev-only static preview of public/ (no database needed). Not used in production.
const http = require("http");
const fs = require("fs");
const path = require("path");

const PUB = path.join(__dirname, "public");
const PORT = process.env.PORT || 5173;
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".svg": "image/svg+xml", ".json": "application/json" };

http
  .createServer((req, res) => {
    // Mock AI endpoint so the chat widget is testable without the full server
    if (req.method === "POST" && req.url === "/api/agent/chat") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, agent: "Teles Agent", reply: "**Preview mode** — this is a mock reply from Teles Agent. Deploy with OPENROUTER_API_KEY for real AI answers! 🚀" }));
      });
      return;
    }
    let p = decodeURIComponent(req.url.split("?")[0]);
    let file = path.join(PUB, p);
    if (!file.startsWith(PUB)) { res.writeHead(403); res.end(); return; }
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(PUB, "index.html");
    res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream" });
    fs.createReadStream(file).pipe(res);
  })
  .listen(PORT, () => console.log("preview on http://localhost:" + PORT));
