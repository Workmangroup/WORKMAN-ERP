import type { NextConfig } from "next";

const isDev = process.env.NODE_ENV !== "production";
const API_URL = process.env.API_URL ?? "http://localhost:4000";

/**
 * Production : export statique (dossier `out/`) servi par Nginx/Apache,
 * qui redirige /api vers l'API Node — une seule origine, cookies first-party.
 * Développement : Next redirige /api vers l'API locale.
 */
const nextConfig: NextConfig = {
  ...(isDev
    ? { rewrites: async () => [{ source: "/api/:path*", destination: `${API_URL}/api/:path*` }] }
    : { output: "export" }),
  turbopack: { root: process.cwd() },
  trailingSlash: true,
  images: { unoptimized: true },
  poweredByHeader: false,
};

export default nextConfig;
