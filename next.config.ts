import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // node-postgres must stay a runtime dependency (it optionally requires pg-native).
  serverExternalPackages: ["pg"],
  poweredByHeader: false,
};

export default nextConfig;
