import path from 'node:path';

function env(name: string, fallback = ''): string {
  const v = process.env[name];
  return v === undefined || v === '' ? fallback : v;
}

/** Everything the app reads from the environment, in one place. */
export const config = {
  /** Absolute base URL; QR codes and emailed links are built from it. */
  appUrl: env('APP_URL', 'http://localhost:3000').replace(/\/+$/, ''),
  /** Writable directory holding the SQLite file and every upload. */
  dataDir: path.resolve(env('DATA_DIR', path.join(process.cwd(), 'data'))),
  /** Service-writer password for the admin portal. */
  adminPassword: env('ADMIN_PASSWORD'),
  /** HMAC key for session cookies. Changing it logs everyone out. */
  sessionSecret: env('SESSION_SECRET'),
  /** Hours a mechanic's PIN unlock stays valid on their phone. */
  mechanicSessionHours: Number(env('MECHANIC_SESSION_HOURS', '10')) || 10,

  assemblyAiKey: env('ASSEMBLYAI_API_KEY'),

  smtp: {
    host: env('SMTP_HOST', 'smtp.gmail.com'),
    port: Number(env('SMTP_PORT', '465')) || 465,
    secure: env('SMTP_SECURE', 'true') !== 'false',
    user: env('SMTP_USER'),
    pass: env('SMTP_PASS'),
    from: env('MAIL_FROM', env('SMTP_USER')),
  },
  /** Where the per-entry "new log entry" notifications go. */
  serviceWriterEmail: env('SERVICE_WRITER_EMAIL'),
  shopName: env('SHOP_NAME', 'Quest Watersports'),
  shopPhone: env('SHOP_PHONE', ''),
};

export const uploadsDir = path.join(config.dataDir, 'uploads');
export const dbPath = path.join(config.dataDir, 'servicetracker.db');

/**
 * Fails loudly at boot rather than silently issuing forgeable cookies.
 * In development a missing secret falls back to a fixed dev string.
 */
export function requireSessionSecret(): string {
  if (config.sessionSecret) return config.sessionSecret;
  if (process.env.NODE_ENV === 'production') {
    throw new Error('SESSION_SECRET must be set in production');
  }
  return 'dev-only-insecure-session-secret';
}
