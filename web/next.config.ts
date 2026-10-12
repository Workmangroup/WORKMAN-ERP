import path from 'node:path'
import type { NextConfig } from 'next'

const securityHeaders = [
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
  { key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains; preload' },
]

const nextConfig: NextConfig = {
  poweredByHeader: false,
  // GED : envoi direct vers Storage (URL signée). Documents fournisseurs : 10 Mo via action serveur.
  experimental: { serverActions: { bodySizeLimit: '12mb' } },
  outputFileTracingRoot: path.join(__dirname),
  async headers() {
    return [
      // Les fichiers de la GED peuvent être affichés dans une iframe de la même origine (aperçu)
      { source: '/ged/files/:path*', headers: securityHeaders.map((h) => (h.key === 'X-Frame-Options' ? { ...h, value: 'SAMEORIGIN' } : h)) },
      { source: '/((?!ged/files).*)', headers: securityHeaders },
    ]
  },
}

export default nextConfig
