import path from "path";
import { fileURLToPath } from "url";
import express from "express";
import dotenv from "dotenv";
import chatRoutes from "./routes/chatRoutes.js";
import googleAuthRoutes from "./routes/googleAuthRoutes.js";
import calendarRoutes from "./routes/calendarRoutes.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config();

const app = express();
app.use(express.json());

// Serve the TBot UI (HTML, CSS, JS) from the project root so /api/chat stays same-origin
app.use(express.static(__dirname));

app.use(googleAuthRoutes);
app.use(chatRoutes);
app.use(calendarRoutes);

const DEFAULT_PORT = Number(process.env.PORT) || 3000;

/**
 * Start the HTTP server. Used by `node server.js` and by the Electron shell.
 * @param {number} [port=DEFAULT_PORT]
 * @returns {Promise<import("http").Server>}
 */
export function startServer(port = DEFAULT_PORT) {
  return new Promise((resolve, reject) => {
    const httpServer = app.listen(port, () => {
      console.log(`TBot server running at http://localhost:${port}`);
      console.log("[memory] short-term conversation memory initialized");
      resolve(httpServer);
    });
    httpServer.on("error", reject);
  });
}

function isDirectNodeRun() {
  const entry = process.argv[1];
  if (!entry) return false;
  return path.resolve(entry) === path.resolve(fileURLToPath(import.meta.url));
}

if (isDirectNodeRun()) {
  startServer().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
