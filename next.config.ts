import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Native module: load it from node_modules at runtime instead of bundling it.
  serverExternalPackages: ["better-sqlite3"],
  // Stop `next dev` from writing an AGENTS.md file into the repository.
  agentRules: false,
};

export default nextConfig;
