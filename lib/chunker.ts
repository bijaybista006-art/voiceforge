/**
 * Script → chunks. The most important file in the app. Change carefully.
 *
 * Rules (see spec §5):
 * - `---` on its own line forces a chunk break.
 * - Paragraph breaks (blank lines) are hard boundaries — never merged across.
 * - Sentences pack greedily into chunks up to MAX_CHARS (240).
 * - A single over-long sentence splits at a comma / semicolon / conjunction —
 *   never mid-word.
 * - No chunk under MIN_CHARS (20) — merged into a neighbour when possible.
 * - Every chunk ends in terminal punctuation.
 */

import { MAX_CHARS, MIN_CHARS } from "./config";
import { normalizeText, type NormalizeOptions } from "./normalize";
import type { ChunkDraft } from "./types";

// ---------------------------------------------------------------------------
// sentence splitting
// ---------------------------------------------------------------------------

/**
 * Titles that survive normalization when not followed by a capitalized name
 * (normalize only expands "Dr." before "Dr. Smith"-style usage), plus
 * initials like "J. K." — none of these end a sentence.
 */
const NON_TERMINAL = /(?:\b(?:Dr|Mr|Mrs|Ms|Prof|St|Mt|Ft|Rd|Ave|Inc|Ltd|Co|Capt|Sgt|Gen|Rev|Hon)|\b[A-Z])\.$/;

export function splitSentences(text: string): string[] {
  // । and ॥ are Devanagari sentence terminators (Hindi, Nepali, …)
  const parts = text.split(/(?<=[.!?।॥])\s+/);
  const sentences: string[] = [];
  for (const part of parts) {
    const prev = sentences[sentences.length - 1];
    if (prev && (NON_TERMINAL.test(prev) || /\.{3}$/.test(prev))) {
      sentences[sentences.length - 1] = `${prev} ${part}`;
    } else {
      sentences.push(part);
    }
  }
  return sentences.map((s) => s.trim()).filter(Boolean);
}

// ---------------------------------------------------------------------------
// long-sentence splitting
// ---------------------------------------------------------------------------

const CONJUNCTIONS = [
  " and ", " but ", " or ", " nor ", " so ", " yet ",
  " because ", " although ", " though ", " while ", " whereas ",
  " which ", " where ", " when ", " unless ", " until ", " since ",
];

/** Find the best split index in `s` (end of first part), closest to midpoint. */
function bestSplitIndex(s: string): number {
  const mid = s.length / 2;
  let best = -1;
  let bestDist = Infinity;

  // clause punctuation first — cleanest breaks
  for (const re of [/[;:](?=\s)/g, /,(?=\s)/g]) {
    for (const m of s.matchAll(re)) {
      const idx = m.index! + 1; // split after the punctuation
      const dist = Math.abs(idx - mid);
      if (dist < bestDist) {
        best = idx;
        bestDist = dist;
      }
    }
    if (best !== -1) return best;
  }

  // then conjunctions — split before the word
  for (const conj of CONJUNCTIONS) {
    let from = 0;
    while (true) {
      const idx = s.indexOf(conj, from);
      if (idx === -1) break;
      const dist = Math.abs(idx - mid);
      if (dist < bestDist) {
        best = idx;
        bestDist = dist;
      }
      from = idx + 1;
    }
  }
  if (best !== -1) return best;

  // last resort: nearest space to the midpoint — never mid-word
  const before = s.lastIndexOf(" ", Math.floor(mid));
  const after = s.indexOf(" ", Math.floor(mid));
  if (before === -1 && after === -1) return -1;
  if (before === -1) return after;
  if (after === -1) return before;
  return mid - before <= after - mid ? before : after;
}

/** Recursively split an over-long sentence into pieces ≤ max chars. */
export function splitLongSentence(sentence: string, max = MAX_CHARS): string[] {
  const s = sentence.trim();
  if (s.length <= max) return [s];
  const idx = bestSplitIndex(s);
  if (idx <= 0 || idx >= s.length - 1) return [s]; // unsplittable, accept over-long
  const head = s.slice(0, idx).trim();
  const tail = s.slice(idx).trim();
  if (!head || !tail) return [s];
  return [...splitLongSentence(head, max), ...splitLongSentence(tail, max)];
}

// ---------------------------------------------------------------------------
// chunk assembly
// ---------------------------------------------------------------------------

/** Replace a dangling clause break with a full stop so the chunk reads cleanly. */
function ensureTerminal(text: string, language = "en"): string {
  const t = text.trim().replace(/[,;:\-]+$/, "");
  if (/[.!?।॥]$/.test(t)) return t;
  // Devanagari-script languages end sentences with the danda
  return language === "hi" || language === "ne" ? `${t}।` : `${t}.`;
}

function packParagraph(paragraph: string, max: number): string[] {
  const pieces = splitSentences(paragraph).flatMap((s) =>
    splitLongSentence(s, max)
  );
  const chunks: string[] = [];
  let current = "";
  for (const piece of pieces) {
    if (!current) {
      current = piece;
    } else if (current.length + 1 + piece.length <= max) {
      current = `${current} ${piece}`;
    } else {
      chunks.push(current);
      current = piece;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

/** Merge chunks under MIN_CHARS into a neighbour within the same paragraph. */
function mergeTiny(drafts: ChunkDraft[], max: number): ChunkDraft[] {
  const out = [...drafts];
  for (let i = 0; i < out.length; i++) {
    if (out[i].charCount >= MIN_CHARS) continue;
    const prev = out[i - 1];
    const next = out[i + 1];
    // previous neighbour, unless a paragraph boundary sits between them
    if (prev && !prev.isParagraphEnd && prev.charCount + 1 + out[i].charCount <= max) {
      prev.text = `${prev.text} ${out[i].text}`;
      prev.charCount = prev.text.length;
      prev.isParagraphEnd = out[i].isParagraphEnd;
      out.splice(i, 1);
      i -= 2; // re-examine the merged neighbour in case it is still tiny
      continue;
    }
    // next neighbour within the same paragraph
    if (next && !out[i].isParagraphEnd && out[i].charCount + 1 + next.charCount <= max) {
      next.text = `${out[i].text} ${next.text}`;
      next.charCount = next.text.length;
      out.splice(i, 1);
      i--;
    }
    // no fit either side: keep the tiny chunk rather than break a hard boundary
  }
  return out;
}

/**
 * Split a raw script into chunk drafts: normalize → paragraphs → sentences →
 * greedy pack. `---` on its own line forces a chunk break (sentence-length
 * gap); a blank line is a paragraph break (longer gap).
 */
export function chunkScript(
  raw: string,
  max = MAX_CHARS,
  language = "en",
  opts: NormalizeOptions = {}
): ChunkDraft[] {
  const drafts: ChunkDraft[] = [];
  // The Nepali checkpoint's authors put its limit at 200 characters; past
  // that it loses its place in the text. Every other language is unchanged.
  if (language === "ne") max = Math.min(max, 200);
  const text = raw.replace(/\r\n?/g, "\n");

  // forced chunk breaks
  const segments = text.split(/^[ \t]*---[ \t]*$/m);

  for (const segment of segments) {
    const paragraphs = segment
      .split(/\n[ \t]*\n+/)
      .map((p) => normalizeText(p, language, opts))
      .filter((p) => p.length > 0);

    for (const paragraph of paragraphs) {
      // inside a paragraph, single newlines are just wrapping
      const flat = paragraph.replace(/\n+/g, " ").trim();
      if (!flat) continue;
      const packed = packParagraph(flat, max);
      packed.forEach((chunkText, i) => {
        drafts.push({
          text: ensureTerminal(chunkText, language),
          charCount: 0, // set below, after ensureTerminal
          isParagraphEnd: i === packed.length - 1,
        });
      });
    }
    // a `---` between paragraphs adds nothing extra — the paragraph break
    // already closed the chunk. Between non-blank lines it forces the break.
  }

  for (const d of drafts) d.charCount = d.text.length;
  return mergeTiny(drafts, max);
}

/** Rough spoken-duration estimate for a chunk that hasn't been generated yet. */
export function estimateChunkSeconds(charCount: number, charsPerSec: number): number {
  return charCount / charsPerSec;
}
