import { createHash } from 'node:crypto';
import type { App } from 'firebase-admin/app';
import { config } from './config';

export interface AuthResult {
  uid: string;
  guest: boolean;
  displayName?: string;
}

let firebaseApp: App | null = null;

export async function initFirebase(): Promise<App | null> {
  if (!config.serviceAccount) return null;
  const { initializeApp, cert } = await import('firebase-admin/app');
  firebaseApp = initializeApp({ credential: cert(config.serviceAccount as never) });
  console.log('[auth] Firebase Admin ready for project', config.serviceAccount.project_id);
  return firebaseApp;
}

/**
 * Tokens are either a Firebase ID token, or `guest:<id>:<secret>` for guest
 * play. A guest uid is a hash of id+secret, so knowing someone's guest id
 * alone doesn't let you take over their character.
 */
export async function verifyToken(token: string): Promise<AuthResult> {
  if (token.startsWith('guest:')) {
    if (!config.allowGuests) throw new Error('Guest play is disabled on this server.');
    const [, id, secret] = token.split(':');
    if (!id || !secret || id.length > 64 || secret.length < 16 || secret.length > 128) throw new Error('Malformed guest token.');
    const uid = 'guest_' + createHash('sha256').update(id + ':' + secret).digest('hex').slice(0, 24);
    return { uid, guest: true };
  }
  if (!firebaseApp) throw new Error('Account login is not configured on this server yet. Use "Play as guest".');
  const { getAuth } = await import('firebase-admin/auth');
  const decoded = await getAuth(firebaseApp).verifyIdToken(token, true);
  return { uid: decoded.uid, guest: !!decoded.firebase?.sign_in_provider && decoded.firebase.sign_in_provider === 'anonymous', displayName: decoded.name };
}

export function getFirebaseApp() {
  return firebaseApp;
}
