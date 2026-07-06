/** @type {import('next').NextConfig} */
const nextConfig = {
  // better-sqlite3 is a native Node-only addon used inside `runtime = "nodejs"`
  // API routes (persistence + discovery). Keep it external so Next never bundles it.
  serverExternalPackages: ["better-sqlite3"],
  async redirects() {
    return [
      // The run-focus route is /run/[id] (lib/routes.ts's runRoute), but an
      // already-sent ntfy deep-link (or any old bookmark) may still carry the
      // earlier /runs/[id] plural shape — permanent redirect so it keeps working.
      {
        source: "/runs/:id",
        destination: "/run/:id",
        permanent: true,
      },
    ];
  },
};

export default nextConfig;
