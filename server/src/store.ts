// Character persistence. Firestore when Firebase is configured, otherwise a
// JSON file on disk (fine for local dev; on Render's free tier the disk is
// wiped on redeploy, so configure Firebase for real saves).
import fs from 'node:fs';
import path from 'node:path';
import type { App } from 'firebase-admin/app';
import { nameKey, type CharacterData } from '@kelia/shared';

export interface CharacterStore {
  readonly kind: string;
  load(uid: string): Promise<CharacterData | null>;
  /** Atomically reserves the name and saves the character. False if the name is taken. */
  create(character: CharacterData): Promise<boolean>;
  save(character: CharacterData): Promise<void>;
}

export class FileStore implements CharacterStore {
  readonly kind = 'file';
  private chars = new Map<string, CharacterData>();
  private names = new Map<string, string>();
  private file: string;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(dir: string) {
    fs.mkdirSync(dir, { recursive: true });
    this.file = path.join(dir, 'characters.json');
    try {
      const data = JSON.parse(fs.readFileSync(this.file, 'utf8')) as CharacterData[];
      for (const c of data) {
        this.chars.set(c.uid, c);
        this.names.set(nameKey(c.name), c.uid);
      }
      console.log(`[store] loaded ${data.length} characters from ${this.file}`);
    } catch {
      console.log('[store] starting a fresh file store at', this.file);
    }
  }

  async load(uid: string) {
    const c = this.chars.get(uid);
    return c ? structuredClone(c) : null;
  }

  async create(character: CharacterData) {
    const key = nameKey(character.name);
    const owner = this.names.get(key);
    if (owner && owner !== character.uid) return false;
    const prev = this.chars.get(character.uid);
    if (prev) this.names.delete(nameKey(prev.name));
    this.names.set(key, character.uid);
    this.chars.set(character.uid, structuredClone(character));
    this.flush();
    return true;
  }

  async save(character: CharacterData) {
    this.chars.set(character.uid, structuredClone(character));
    this.flush();
  }

  private flush() {
    if (this.timer) return;
    this.timer = setTimeout(() => this.flushNow(), 500);
  }

  flushNow() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const tmp = this.file + '.tmp';
    try {
      fs.writeFileSync(tmp, JSON.stringify([...this.chars.values()]));
      fs.renameSync(tmp, this.file);
    } catch (err) {
      console.error('[store] write failed', err);
    }
  }
}

export class FirestoreStore implements CharacterStore {
  readonly kind = 'firestore';
  private db!: import('firebase-admin/firestore').Firestore;

  static async create(app: App) {
    const s = new FirestoreStore();
    const { getFirestore } = await import('firebase-admin/firestore');
    s.db = getFirestore(app);
    s.db.settings({ ignoreUndefinedProperties: true });
    return s;
  }

  async load(uid: string) {
    const snap = await this.db.collection('characters').doc(uid).get();
    return snap.exists ? (snap.data() as CharacterData) : null;
  }

  async create(character: CharacterData) {
    const key = nameKey(character.name);
    const nameRef = this.db.collection('names').doc(key);
    const charRef = this.db.collection('characters').doc(character.uid);
    return this.db.runTransaction(async (tx) => {
      const nameSnap = await tx.get(nameRef);
      if (nameSnap.exists && nameSnap.data()?.uid !== character.uid) return false;
      const prev = await tx.get(charRef);
      if (prev.exists) {
        const oldKey = nameKey((prev.data() as CharacterData).name);
        if (oldKey !== key) tx.delete(this.db.collection('names').doc(oldKey));
      }
      tx.set(nameRef, { uid: character.uid, name: character.name, createdAt: Date.now() });
      tx.set(charRef, character);
      return true;
    });
  }

  async save(character: CharacterData) {
    await this.db.collection('characters').doc(character.uid).set(character);
  }
}
