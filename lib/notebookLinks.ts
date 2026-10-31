/**
 * Where the Colab / Kaggle buttons on Admin → Backends go.
 *
 * Two kinds of link per platform:
 *   mine   your own saved copy (Settings → Notebooks). Secret access is already
 *          granted there, so opening it asks nothing. The everyday button.
 *   fresh  the latest notebook straight from GitHub. Only needed when the
 *          notebook prints "A NEWER NOTEBOOK IS AVAILABLE".
 *
 * Colab links also carry the dedicated Google account (Settings → Notebooks),
 * as Google's `authuser` parameter, so they open in that account when several
 * are signed in. Kaggle has no such parameter: it always uses whoever is signed
 * in on kaggle.com.
 *
 * Pure and dependency-free: used by the settings API, the backends API and
 * the admin page alike.
 */

const REPO = "bijaybista006-art/voiceforge";
const NOTEBOOK = "colab/voiceforge_server.ipynb";

export const FRESH_COLAB_URL = `https://colab.research.google.com/github/${REPO}/blob/main/${NOTEBOOK}`;
export const FRESH_KAGGLE_URL = `https://www.kaggle.com/kernels/welcome?src=https://github.com/${REPO}/blob/main/${NOTEBOOK}`;

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function parse(url: string): URL | null {
  try {
    return new URL(url.trim());
  } catch {
    return null;
  }
}

export function isEmail(value: string): boolean {
  return EMAIL.test(value.trim());
}

/** A saved Colab notebook: https://colab.research.google.com/… (usually /drive/<id>). */
export function isColabNotebookUrl(url: string): boolean {
  const u = parse(url);
  return !!u && u.protocol === "https:" && u.hostname === "colab.research.google.com" && u.pathname.length > 1;
}

/** A saved Kaggle notebook: https://www.kaggle.com/code/<user>/<name>[/edit]. */
export function isKaggleNotebookUrl(url: string): boolean {
  const u = parse(url);
  return (
    !!u &&
    u.protocol === "https:" &&
    (u.hostname === "www.kaggle.com" || u.hostname === "kaggle.com") &&
    u.pathname.startsWith("/code/")
  );
}

/** The Colab link opened in a specific Google account (`authuser`), when one is set. */
export function withGoogleAccount(url: string, account: string): string {
  const u = parse(url);
  if (!u || !isEmail(account)) return url;
  u.searchParams.set("authuser", account.trim());
  return u.toString();
}

export interface NotebookLinks {
  colab: { mine: string | null; fresh: string };
  kaggle: { mine: string | null; fresh: string };
  googleAccount: string | null;
}

/** Every button's link, from the saved settings. Invalid or empty values become null. */
export function notebookLinks(settings: {
  colabNotebookUrl?: string;
  kaggleNotebookUrl?: string;
  googleAccount?: string;
}): NotebookLinks {
  const account = settings.googleAccount && isEmail(settings.googleAccount) ? settings.googleAccount.trim() : "";
  const colab = settings.colabNotebookUrl?.trim() ?? "";
  const kaggle = settings.kaggleNotebookUrl?.trim() ?? "";
  return {
    colab: {
      mine: isColabNotebookUrl(colab) ? withGoogleAccount(colab, account) : null,
      fresh: withGoogleAccount(FRESH_COLAB_URL, account),
    },
    kaggle: {
      mine: isKaggleNotebookUrl(kaggle) ? kaggle : null,
      fresh: FRESH_KAGGLE_URL,
    },
    googleAccount: account || null,
  };
}
