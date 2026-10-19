// npm run harness: serve the harness at http://<host>:5281/harness/ and stay up.
import path from "node:path";
import { serveStatic } from "./lib/static.mjs";

const PORT = Number(process.env.PORT || 5281);
const root = path.resolve(import.meta.dirname, "..");
await serveStatic(root, PORT);
console.log(`loot-crates harness: http://localhost:${PORT}/harness/  (pid ${process.pid})`);
