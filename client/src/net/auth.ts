// Sign-in: Firebase (email/password or Google) when configured, plus guest
// play. Firebase is loaded lazily so guests never download it.
import type { Auth, User } from 'firebase/auth';
import { FIREBASE_CONFIG, FIREBASE_PROBLEM, maskKey } from '../config';

const GUEST_KEY = 'kelia.guest.v1';

export const firebaseEnabled = !!FIREBASE_CONFIG && !FIREBASE_PROBLEM;
/** Shown on the title screen when the build's Firebase settings can't work. */
export const firebaseProblem = FIREBASE_PROBLEM;

let authPromise: Promise<{ auth: Auth; mod: typeof import('firebase/auth') }> | null = null;

function getAuthMod() {
  if (!FIREBASE_CONFIG) throw new Error('Account login is not set up yet. Play as a guest for now.');
  if (FIREBASE_PROBLEM) throw new Error(FIREBASE_PROBLEM);
  authPromise ??= (async () => {
    const [{ initializeApp }, mod] = await Promise.all([import('firebase/app'), import('firebase/auth')]);
    const app = initializeApp(FIREBASE_CONFIG!);
    const auth = mod.getAuth(app);
    await mod.setPersistence(auth, mod.browserLocalPersistence);
    return { auth, mod };
  })();
  return authPromise;
}

/** Returns the signed-in Firebase user from a previous visit, if any. */
export async function restoreUser(): Promise<User | null> {
  if (!firebaseEnabled) return null;
  const { auth } = await getAuthMod();
  await auth.authStateReady();
  return auth.currentUser;
}

export async function signInEmail(email: string, password: string, create: boolean): Promise<User> {
  const { auth, mod } = await getAuthMod();
  try {
    const cred = create
      ? await mod.createUserWithEmailAndPassword(auth, email, password)
      : await mod.signInWithEmailAndPassword(auth, email, password);
    return cred.user;
  } catch (err) {
    throw new Error(friendly(err));
  }
}

export async function signInGoogle(): Promise<User> {
  const { auth, mod } = await getAuthMod();
  try {
    const cred = await mod.signInWithPopup(auth, new mod.GoogleAuthProvider());
    return cred.user;
  } catch (err) {
    throw new Error(friendly(err));
  }
}

export async function resetPassword(email: string) {
  const { auth, mod } = await getAuthMod();
  await mod.sendPasswordResetEmail(auth, email);
}

export async function signOut() {
  if (!firebaseEnabled) return;
  const { auth, mod } = await getAuthMod();
  await mod.signOut(auth);
}

export async function idToken(user: User) {
  return user.getIdToken();
}

/** A persistent guest identity for this browser. */
export function guestToken(): string {
  let tok: string | null = null;
  try {
    tok = localStorage.getItem(GUEST_KEY);
  } catch {
    /* storage unavailable: a fresh guest each visit */
  }
  if (!tok) {
    const rnd = (n: number) => Array.from(crypto.getRandomValues(new Uint8Array(n)), (b) => b.toString(16).padStart(2, '0')).join('');
    tok = `guest:${rnd(8)}:${rnd(18)}`;
    try {
      localStorage.setItem(GUEST_KEY, tok);
    } catch {
      /* ignore */
    }
  }
  return tok;
}

function friendly(err: unknown): string {
  const code = (err as { code?: string }).code ?? '';
  const map: Record<string, string> = {
    'auth/invalid-email': 'That email address looks wrong.',
    'auth/missing-password': 'Enter your password.',
    'auth/weak-password': 'Use at least 6 characters for your password.',
    'auth/email-already-in-use': 'That email already has an account. Sign in instead.',
    'auth/invalid-credential': 'Wrong email or password.',
    'auth/wrong-password': 'Wrong email or password.',
    'auth/user-not-found': 'No account with that email. Create one?',
    'auth/too-many-requests': 'Too many attempts. Wait a moment and try again.',
    'auth/popup-closed-by-user': 'Google sign-in was closed.',
    'auth/popup-blocked': 'Your browser blocked the Google popup. Allow popups for this site.',
    'auth/network-request-failed': 'Network error. Check your connection.',
    'auth/unauthorized-domain': 'This site is not yet authorised for Google sign-in (add it in Firebase → Authentication → Settings).',
  };
  if (code.startsWith('auth/api-key-not-valid') || code === 'auth/invalid-api-key') {
    return `Firebase rejected this build's API key (${maskKey(FIREBASE_CONFIG?.apiKey ?? '')}). Copy the Web API key from Firebase → Project settings → General into FIREBASE_API_KEY on Vercel, then redeploy. Guest play still works.`;
  }
  if (code === 'auth/requests-from-referer-blocked') {
    return 'This API key is restricted to other websites. Add this site to the key in Google Cloud → Credentials.';
  }
  if (code === 'auth/operation-not-allowed') return 'That sign-in method is turned off in Firebase → Authentication → Sign-in method.';
  return map[code] ?? (err as Error).message ?? 'Sign-in failed.';
}
