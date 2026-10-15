// Title screen: sign in with Google or a username, or play as a guest, while the
// realm (the Render server) wakes up in the background.
import { firebaseEnabled, firebaseProblem, guestToken, idToken, restoreUser, signInGoogle, signInUsername, signOut, userLabel } from '../net/auth';
import { h, icon, mount, unmount } from './dom';

export interface LoginResult {
  token: string;
  label: string;
}

export class LoginScreen {
  readonly el: HTMLElement;
  private card: HTMLElement;
  private status: HTMLElement;
  private dot: HTMLElement;
  private resolve!: (r: LoginResult) => void;
  result: Promise<LoginResult>;
  private busy = false;

  constructor() {
    this.result = new Promise((r) => (this.resolve = r));
    this.dot = h('span', { class: 'server-dot' });
    this.status = h('span', null, 'Reaching the realm…');
    this.card = h('div', { class: 'login-card panel interactive' });
    this.el = h(
      'div',
      { class: 'login' },
      h(
        'div',
        { class: 'login-hero' },
        h('h1', { class: 'title' }, 'KELIA'),
        h('p', null, 'A small valley at the edge of the old kingdom. Meadows, deep woods, a waterfall and the ruins of what came before. Come and see.'),
      ),
      this.card,
    );
    mount(this.el);
    this.renderMain();
    void this.tryRestore();
  }

  setServer(state: 'waking' | 'on' | 'off', text: string) {
    this.dot.className = 'server-dot' + (state === 'on' ? ' on' : state === 'off' ? ' off' : '');
    this.status.textContent = text;
  }

  private serverLine() {
    return h('div', { class: 'server-line' }, this.dot, this.status);
  }

  private async tryRestore() {
    if (!firebaseEnabled) return;
    try {
      const user = await restoreUser();
      if (user) this.renderSignedIn(userLabel(user), async () => idToken(user));
    } catch {
      /* not signed in */
    }
  }

  private renderMain(error = '') {
    const err = h('div', { class: 'err' }, error);
    const guest = h('button', { class: 'btn primary wide', onclick: () => this.finish({ token: guestToken(), label: 'Guest' }) }, icon('door', 18), 'Play as guest');
    const children: (HTMLElement | null)[] = [h('h2', null, 'Enter the realm')];
    if (firebaseEnabled) {
      children.push(
        h('button', { class: 'btn wide', onclick: () => this.google(err) }, icon('google', 18), 'Continue with Google'),
        h('button', { class: 'btn wide', onclick: () => this.renderAccount(false) }, icon('user', 18), 'Sign in with username'),
        h('div', { class: 'divider' }, 'or'),
        guest,
        h('div', { class: 'muted', style: 'font-size:12px;line-height:1.5' }, 'Guests keep their hero on this browser. Sign in to play anywhere.'),
      );
    } else {
      children.push(guest, h('div', { class: 'muted', style: 'font-size:12px;line-height:1.5' }, 'Your hero is saved to this browser.'));
      if (firebaseProblem) {
        children.push(h('div', { class: 'err' }, `Account sign-in is unavailable: ${firebaseProblem} Fix it in Vercel's environment variables and redeploy.`));
      }
    }
    children.push(err, this.serverLine());
    this.card.replaceChildren(...children.filter(Boolean) as HTMLElement[]);
  }

  private renderSignedIn(name: string, getToken: () => Promise<string>) {
    const err = h('div', { class: 'err' });
    this.card.replaceChildren(
      h('h2', null, 'Welcome back'),
      h('div', { class: 'muted' }, 'Signed in as ', h('b', { style: 'color:var(--ink)' }, name)),
      h('button', {
        class: 'btn primary wide',
        onclick: async () => {
          try {
            this.finish({ token: await getToken(), label: name });
          } catch (e) {
            err.textContent = (e as Error).message;
          }
        },
      }, icon('door', 18), 'Enter Kelia'),
      h('button', { class: 'btn ghost wide', onclick: async () => { await signOut(); this.renderMain(); } }, 'Use a different account'),
      err,
      this.serverLine(),
    );
  }

  private async google(err: HTMLElement) {
    if (this.busy) return;
    this.busy = true;
    try {
      const user = await signInGoogle();
      this.finish({ token: await idToken(user), label: userLabel(user) });
    } catch (e) {
      err.textContent = (e as Error).message;
    } finally {
      this.busy = false;
    }
  }

  private renderAccount(create: boolean) {
    const name = h('input', { class: 'input', type: 'text', placeholder: create ? '3–16 letters, numbers or _' : 'Username', autocomplete: 'username', maxlength: '16', spellcheck: 'false', autocapitalize: 'off' });
    const pass = h('input', { class: 'input', type: 'password', placeholder: create ? 'At least 6 characters' : 'Password', autocomplete: create ? 'new-password' : 'current-password' });
    const err = h('div', { class: 'err' });
    const submit = h('button', { class: 'btn primary wide', type: 'submit' }, create ? 'Create account' : 'Sign in');
    const form = h(
      'form',
      {
        style: 'display:flex;flex-direction:column;gap:12px',
        onsubmit: async (e: Event) => {
          e.preventDefault();
          if (this.busy) return;
          this.busy = true;
          submit.disabled = true;
          err.textContent = '';
          try {
            const user = await signInUsername(name.value.trim(), pass.value, create);
            this.finish({ token: await idToken(user), label: userLabel(user) });
          } catch (ex) {
            err.textContent = (ex as Error).message;
          } finally {
            this.busy = false;
            submit.disabled = false;
          }
        },
      },
      h('div', { class: 'field' }, h('label', null, 'Username'), name),
      h('div', { class: 'field' }, h('label', null, 'Password'), pass),
      submit,
    );
    this.card.replaceChildren(
      h('h2', null, create ? 'Create an account' : 'Sign in'),
      form,
      err,
      h(
        'div',
        { class: 'login-foot' },
        h('button', { class: 'linklike', onclick: () => this.renderMain() }, '← Back'),
        create
          ? h('button', { class: 'linklike', onclick: () => this.renderAccount(false) }, 'I have an account')
          : h('button', { class: 'linklike', onclick: () => this.renderAccount(true) }, 'Create account'),
      ),
      this.serverLine(),
    );
    setTimeout(() => name.focus(), 50);
  }

  showError(msg: string) {
    this.renderMain(msg);
  }

  private finish(r: LoginResult) {
    this.resolve(r);
  }

  /** Let the user retry after a failed connection. */
  reset(): Promise<LoginResult> {
    const p = new Promise<LoginResult>((r) => (this.resolve = r));
    this.result = p;
    return p;
  }

  close() {
    unmount(this.el);
  }
}
