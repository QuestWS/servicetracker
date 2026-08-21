/** @type {import('next').NextConfig} */
const nextConfig = {
  // better-sqlite3 is a native module and pdfjs ships its own worker plumbing;
  // neither survives being bundled into the server build.
  serverExternalPackages: ['better-sqlite3', 'pdfjs-dist', 'nodemailer'],
  outputFileTracingIncludes: {
    '/api/**': ['./node_modules/pdfjs-dist/standard_fonts/**'],
  },
  async headers() {
    return [
      {
        source: '/sw.js',
        headers: [
          { key: 'Cache-Control', value: 'no-cache, no-store, must-revalidate' },
          { key: 'Service-Worker-Allowed', value: '/' },
        ],
      },
    ];
  },
};

export default nextConfig;
