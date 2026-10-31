import { describe, expect, it } from "vitest";
import {
  FRESH_COLAB_URL,
  FRESH_KAGGLE_URL,
  isColabNotebookUrl,
  isEmail,
  isKaggleNotebookUrl,
  notebookLinks,
  withGoogleAccount,
} from "../notebookLinks";

/**
 * The Colab / Kaggle buttons on Admin → Backends. The everyday button opens
 * the owner's saved copy in their dedicated Google account; a fresh copy from
 * GitHub is only for setup and updates.
 */

const COLAB_COPY = "https://colab.research.google.com/drive/1AbCdEfGh";
const KAGGLE_COPY = "https://www.kaggle.com/code/bijay/voiceforge-server";

describe("recognising saved notebooks", () => {
  it("accepts a saved Colab copy and refuses anything else", () => {
    expect(isColabNotebookUrl(COLAB_COPY)).toBe(true);
    expect(isColabNotebookUrl("http://colab.research.google.com/drive/1")).toBe(false);
    expect(isColabNotebookUrl("https://drive.google.com/file/d/1")).toBe(false);
    expect(isColabNotebookUrl("not a url")).toBe(false);
  });

  it("accepts a saved Kaggle notebook, with or without /edit", () => {
    expect(isKaggleNotebookUrl(KAGGLE_COPY)).toBe(true);
    expect(isKaggleNotebookUrl(KAGGLE_COPY + "/edit")).toBe(true);
    expect(isKaggleNotebookUrl("https://www.kaggle.com/datasets/x/y")).toBe(false);
    expect(isKaggleNotebookUrl("https://kaggle.evil.com/code/x")).toBe(false);
  });

  it("checks the Google account looks like an email", () => {
    expect(isEmail("voiceforge.gpu@gmail.com")).toBe(true);
    expect(isEmail("voiceforge.gpu")).toBe(false);
  });
});

describe("opening Colab in the dedicated account", () => {
  it("adds Google's authuser parameter", () => {
    const url = new URL(withGoogleAccount(COLAB_COPY, "voiceforge.gpu@gmail.com"));
    expect(url.searchParams.get("authuser")).toBe("voiceforge.gpu@gmail.com");
    expect(url.pathname).toBe("/drive/1AbCdEfGh");
  });

  it("replaces an authuser already in a pasted link", () => {
    const url = new URL(withGoogleAccount(`${COLAB_COPY}?authuser=0`, "voiceforge.gpu@gmail.com"));
    expect(url.searchParams.getAll("authuser")).toEqual(["voiceforge.gpu@gmail.com"]);
  });

  it("leaves the link alone without a valid account", () => {
    expect(withGoogleAccount(COLAB_COPY, "")).toBe(COLAB_COPY);
    expect(withGoogleAccount(COLAB_COPY, "nope")).toBe(COLAB_COPY);
  });
});

describe("notebookLinks", () => {
  it("gives the saved copies, Colab in the dedicated account, and fresh copies as the fallback", () => {
    const links = notebookLinks({
      colabNotebookUrl: COLAB_COPY,
      kaggleNotebookUrl: KAGGLE_COPY,
      googleAccount: "voiceforge.gpu@gmail.com",
    });
    expect(links.colab.mine).toBe(`${COLAB_COPY}?authuser=voiceforge.gpu%40gmail.com`);
    expect(new URL(links.colab.fresh).searchParams.get("authuser")).toBe("voiceforge.gpu@gmail.com");
    // Kaggle has no account parameter; its link is used as saved.
    expect(links.kaggle).toEqual({ mine: KAGGLE_COPY, fresh: FRESH_KAGGLE_URL });
    expect(links.googleAccount).toBe("voiceforge.gpu@gmail.com");
  });

  it("has no saved copy until one is set, but always a fresh one", () => {
    const links = notebookLinks({});
    expect(links.colab).toEqual({ mine: null, fresh: FRESH_COLAB_URL });
    expect(links.kaggle).toEqual({ mine: null, fresh: FRESH_KAGGLE_URL });
    expect(links.googleAccount).toBeNull();
  });

  it("ignores a stored value that is not a notebook link", () => {
    expect(notebookLinks({ colabNotebookUrl: "https://example.com/x" }).colab.mine).toBeNull();
    expect(notebookLinks({ kaggleNotebookUrl: "https://example.com/x" }).kaggle.mine).toBeNull();
  });
});
