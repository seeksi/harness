/** @type {import('next').NextConfig} */
const nextConfig = {
  // Lane A imports better-sqlite3 (native, Node-only) inside `runtime = "nodejs"`
  // API routes. Keep it external so Next does not try to bundle the native addon.
  serverExternalPackages: ["better-sqlite3"],
};

export default nextConfig;
