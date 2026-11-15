import { config } from "dotenv";

/** Loads .env.local then .env (existing process env always wins). */
export function loadEnv(): void {
  config({ path: ".env.local", quiet: true });
  config({ path: ".env", quiet: true });
}
