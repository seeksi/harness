/** @type {import('next').NextConfig} */
const nextConfig = {
  // better-sqlite3 is a native Node-only addon used inside `runtime = "nodejs"`
  // API routes (persistence + discovery). Keep it external so Next never bundles it.
  serverExternalPackages: ["better-sqlite3"],
};

export default nextConfig;
