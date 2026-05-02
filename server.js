import path from "path";
import { fileURLToPath } from "url";
import express from "express";
import app from "./app.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Serve the TBot UI (HTML, CSS, JS) from the project root so /api/chat stays same-origin
app.use(express.static(__dirname));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`TBot server running at http://localhost:${PORT}`);
});
