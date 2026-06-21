import express from "express";
import http from "http";

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

const server = http.createServer(app);
const PORT = parseInt(process.env.PORT ?? "8080", 10);

server.listen(PORT, () => {
  console.log(`[engine] listening on port ${PORT}`);
});

export { app, server };
