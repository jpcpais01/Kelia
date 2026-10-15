// All server configuration comes from environment variables (set them in
// the Render dashboard; see README "Deploying").
const env = process.env;

function parseServiceAccount(raw: string | undefined): Record<string, string> | null {
  if (!raw) return null;
  const text = raw.trim().startsWith('{') ? raw : Buffer.from(raw, 'base64').toString('utf8');
  try {
    return JSON.parse(text);
  } catch {
    console.error('[config] FIREBASE_SERVICE_ACCOUNT is not valid JSON (or base64 JSON); Firebase disabled.');
    return null;
  }
}

export const config = {
  port: Number(env.PORT ?? 8787),
  /** Firebase service account JSON (raw or base64). Enables real auth + Firestore saves. */
  serviceAccount: parseServiceAccount(env.FIREBASE_SERVICE_ACCOUNT),
  /** Allow "Play as guest" logins (no account). */
  allowGuests: env.ALLOW_GUESTS !== 'false',
  /** Comma-separated list of allowed browser origins; empty = allow all. */
  allowedOrigins: (env.ALLOWED_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean),
  /** Where the file store keeps saves when Firebase isn't configured. */
  dataDir: env.DATA_DIR ?? new URL('../data/', import.meta.url).pathname,
  version: env.RENDER_GIT_COMMIT?.slice(0, 7) ?? 'dev',
};
