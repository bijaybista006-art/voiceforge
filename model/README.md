# The VoiceForge Nepali model

The owner's own Nepali text-to-speech model. Its versions live in the private
Hugging Face repo `waytobijay/voiceforge-nepali`; everything that produces
them lives here, in Git.

## How it is built

Chatterbox Multilingual (Resemble AI, MIT) has three parts. Only one is ours
to train:

| Part | What it does | Here |
|---|---|---|
| Voice encoder + S3Gen | the sound of the voice, from a reference clip | unchanged (official) |
| **T3** | text → speech: words, pronunciation, rhythm, pauses, endings | **trained** |

- **Start:** `t3_mtl_nepali_merged.safetensors` — the community Nepali T3
  (Firoj112, MIT: 70% fine-tune on IndicVoices-R Nepali, 30% base), measured
  best of the available files on the owner's sentences (Oct 2026).
- **Train:** `modal/train_nepali.py`, started from GitHub → Actions →
  *Train Nepali model*. It reads the owner's recordings from the Training data
  page, trains T3 on an A10G, keeps the best epoch by held-out loss, and pushes
  `<version>.safetensors` plus `<version>.json` (its training record).
- **Data:** the owner's recordings — clean, read-aloud, punctuated Nepali in
  their own voice. The base checkpoint learned from casual, unpunctuated speech
  by many speakers; these recordings are what teach it clean endings, the
  pause after "।", and the owner's pronunciation. A real run needs at least
  10 minutes; about 30 (the Training data page's ~500 sentences) is the target.

## Rules

1. **Nothing goes live from training.** A new version is only a new file in
   the repo. It is compared with the current one on the evaluation sentences
   (the owner's recorded sentences, scored against their own recordings) and
   switched only if it is better: `VOICEFORGE_NE_FILE=<version>.safetensors`.
   Per request, `params.ne_source: "<version>.safetensors"` tries it without
   switching anything.
2. **Training text = live text.** The same preparation runs in both
   (`ne_expand_digits`, `ne_model_ending`, `punc_norm`, the `ne` tag). If live
   text handling changes, the next training run must use it too.
3. **Rolling back** is setting `VOICEFORGE_NE_FILE` to the previous file.
4. **Server patches** (stop rules, re-takes, trims) stay until a version that
   no longer needs them has been measured without them — then removed one at
   a time.

## Versions

| Version | File | From | Data | Result | Live |
|---|---|---|---|---|---|
| v1 | `t3_mtl_nepali_final.safetensors` | Firoj112 epoch 50 | IndicVoices-R Nepali, 11.7 h | "नमस्ते" often wrong; 7% slower than the owner | until 2026-10-22 |
| v2 | `t3_mtl_nepali_merged.safetensors` | Firoj112 merged (0.7/0.3) | same | words and pace closest to the owner; fewest stray starts | since 2026-10-22 |
| v3 | — | v2 | owner's recordings | to train once ≥ 10 min are recorded | — |
