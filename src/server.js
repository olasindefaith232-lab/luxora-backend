import "dotenv/config";
import { app } from "./app.js";
import { initializeDatabase, pool } from "./db.js";

const required = ["DATABASE_URL", "JWT_SECRET", "ADMIN_EMAIL", "ADMIN_PASSWORD"];
const missing = required.filter((name) => !process.env[name]);
if (missing.length) {
  console.error(`Missing required environment variables: ${missing.join(", ")}. Copy .env.example to .env and fill it in.`);
  process.exitCode = 1;
} else {
  try {
    await initializeDatabase();
    const port = Number(process.env.PORT || 4000);
    app.listen(port, () => console.log(`Luxora API listening on http://localhost:${port}`));
  } catch (error) {
    console.error("Could not start the Luxora API:", error);
    process.exitCode = 1;
  }
}

process.on("SIGTERM", async () => {
  await pool.end();
  process.exit(0);
});
