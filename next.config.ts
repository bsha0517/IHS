import path from "node:path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Pins the workspace root explicitly — without this, Turbopack's lockfile
  // auto-detection walks up to a lockfile in the user's home directory and
  // warns/misbehaves about it.
  turbopack: {
    root: path.join(__dirname),
  },
};

export default nextConfig;
