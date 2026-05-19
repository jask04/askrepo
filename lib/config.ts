import { z } from "zod";

const schema = z.object({
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  DIRECT_DATABASE_URL: z
    .string()
    .min(1, "DIRECT_DATABASE_URL is required"),
  GOOGLE_API_KEY: z.string().min(1, "GOOGLE_API_KEY is required"),
  SESSION_SECRET: z
    .string()
    .min(32, "SESSION_SECRET must be at least 32 characters"),
  // Repo id used for the one-click tour. Optional — set once a demo
  // repo has been pre-indexed.
  TOUR_REPO_ID: z.string().min(1).optional(),
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  const issues = parsed.error.issues
    .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
    .join("\n");
  throw new Error(`Invalid environment configuration:\n${issues}`);
}

export const config = parsed.data;
export type Config = typeof config;
