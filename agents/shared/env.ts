import dotenv from "dotenv";
import { existsSync, readFileSync } from "node:fs";

// Preserve legacy secrets in .env while allowing non-empty .env.local values
// to override it. Empty local placeholders must not erase working credentials.
dotenv.config();

if (existsSync(".env.local")) {
  const local = dotenv.parse(readFileSync(".env.local"));
  for (const [name, value] of Object.entries(local)) {
    if (value.trim()) process.env[name] = value;
  }
}
