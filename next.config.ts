import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Mail's socket and parsing libraries load their own files at run time: bundling breaks them.
  serverExternalPackages: ["imapflow", "nodemailer", "mailparser"],
  cacheComponents: true,
  partialPrefetching: true,
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
