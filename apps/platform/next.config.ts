import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: ["@seam/protocol"],
  serverExternalPackages: ["mysql2", "@a2a-js/sdk"],
};

export default nextConfig;
