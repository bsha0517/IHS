import { z } from "zod"

const envSchema = z.object({
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  SESSION_SECRET: z.string().min(16, "SESSION_SECRET must be at least 16 characters"),
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  STORAGE_DRIVER: z.enum(["local", "s3"]).default("local"),
})

function loadEnv() {
  const parsed = envSchema.safeParse(process.env)
  if (!parsed.success) {
    console.error("Invalid environment configuration:", parsed.error.flatten().fieldErrors)
    throw new Error("Invalid environment configuration — see logged field errors above.")
  }
  return parsed.data
}

export const env = loadEnv()
