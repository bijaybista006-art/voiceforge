# VoiceForge

Clone your voice, generate hours of narration, pay nothing.

The web app runs on Vercel. The AI models run on a free GPU you control — Google Colab, Kaggle, or Modal. The notebook registers itself, so there's no URL to copy. There's also a **REST API with keys**, so n8n and other automations can generate speech in your cloned voice.

**📘 [Full step-by-step guide with screenshots-style instructions →](docs/setup-guide.html)** (open it in a browser)

### Finding your way around

The app has two sections, each with its own sidebar. One button in the header (**Go to Admin** / **Go to Studio**) moves between them, and the Light / Dark / System switch next to it is remembered on each device.

| Studio — making things | Admin — running the platform |
|---|---|
| `/studio` Home · `/studio/speech` Text to Speech · `/studio/presenter` Presenter Video · `/studio/ai-video` AI Video · `/studio/library` My Library | `/admin` Dashboard · Backends · Voices · Presenters · Training data · API Keys · Jobs · API & n8n · Settings |

The studio shows the GPU as just **Ready**, **Busy** or **Offline**; GPU names, addresses and routing live in Admin. Old links (`/`, `/speech`, `/library`, …) redirect to the new pages. Screenshots of every page: [docs/redesign-screenshots](docs/redesign-screenshots).

---

## One-time setup (≈15 minutes)

### Step 1 — Deploy the web app

1. Fork this repo on GitHub.
2. Go to [vercel.com](https://vercel.com) → **Add New → Project** → import your fork.
3. Framework preset: **Next.js**. Leave everything else default.
4. Click **Deploy**.
5. You get a URL like `voiceforge-yourname.vercel.app`. Bookmark it.

### Step 1b — Add storage and secrets

In Vercel → your project:

| Where | What |
|---|---|
| **Settings → Environment Variables** | `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` — from a free Supabase project set up as in [docs/supabase-setup.md](docs/supabase-setup.md). It holds settings, keys, jobs, voice clips and generated audio |
| same place | `REGISTRATION_TOKEN` and `BACKEND_SECRET` — two long random strings |
| (optional) same place | `ADMIN_PASSWORD` + `SESSION_SECRET` — turns on the login gate |

Generate the random values with:

```bash
node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"
```

Then **redeploy** — environment variables only reach the app on a fresh build.

The login gate only switches on when **both** `ADMIN_PASSWORD` and `SESSION_SECRET` exist. That's deliberate: deploying can never lock you out of your own site before you're ready.

Vercel hosts the app and nothing else: there is no Vercel storage product to add.

---

## Every session (≈4 minutes)

### Step 2 — Start the GPU backend

1. Open [colab.research.google.com](https://colab.research.google.com).
2. **File → Upload notebook** → choose `colab/voiceforge_server.ipynb` from this repo.
3. **Runtime → Change runtime type → T4 GPU** → Save. *(This is free. If you skip it, nothing works.)*
4. **Runtime → Run all.** That is the only click — no "Restart session".
5. Wait. Cell 1 installs (~2 min). Cell 2 starts everything in a fresh Python process: it loads the models (~2–4 min), opens a tunnel and **registers itself with your app**. It prints:

```
==============================================================
  REGISTERED — nothing to copy. Check Admin -> Backends.
==============================================================
```

Before the first run, paste your app URL and `REGISTRATION_TOKEN` into **Cell 0** — Admin → Backends shows a copy-ready snippet with both.

**Open it from VoiceForge every time.** Save the notebook once (Colab: *File → Save a copy in Drive*; Kaggle: *Save Version → Quick Save*), then paste its address into **Admin → Settings → My Colab notebook / My Kaggle notebook**, and your dedicated Gmail into **Google account for Colab**. Admin → Backends then shows **Open my Colab notebook** and **Open my Kaggle notebook**: your saved copies, so the platform remembers its access to your secrets and stops asking, and Colab opens in that Gmail (Google's `authuser`, which works when that account is signed in in the same browser). Kaggle has no account switch in links; it uses whoever is signed in on kaggle.com. Cell 1 prints a notice when a newer notebook is available; only then use the fresh-copy links and save the new copy's address in Settings. If the one-click start ever misbehaves, set `ONE_CLICK_START = False` in Cell 0 to use the classic cells (those need *Runtime → Restart session* after Cell 1).

**Leave the Colab tab open.** Close it and your backend dies. The tunnel URL is new every session, but you never see it: the notebook re-registers and heartbeats every 60 seconds.

### Step 3 — Check it's live

1. Open your app → **Admin → Backends**.
2. Within about a minute the Colab card turns **Online**, showing the GPU.
3. Press **Test connection** if you want proof it answers.

That's it — no URL to paste anywhere. The studio asks the server which backend to use on every request: the first healthy one in the fixed order Colab → Kaggle → Custom → Modal. The **Serving now** panel at the top of Backends shows which one that is.

---

## Making narration

### Step 4 — Add your voice (once, ever)

Either in the **Voice** panel on **Text to Speech**, or under **Admin → Voices**:

1. **Record** — 15–20 seconds. Quiet room, phone or laptop mic is fine, no music, natural pace. Read a paragraph from any article.
2. **Type the transcript** — exactly what you said, word for word. This matters more than you'd think; the clone gets noticeably worse without it.
3. **Trim** the silence off the front and back with the waveform handles.
4. **Save.** The clip goes into your voice library on the server.

The library is the point: the clip is stored once and cached onto whichever GPU is running the first time it's used. A Colab restart, a switch to Modal, a different browser — none of them need a re-clone.

**What makes a good sample:** consistent volume, no background hum, no room echo, and you speaking the way you want the narration to sound. If you read your sample flat, the narration will be flat.

### Step 5 — Add your script

Paste it, or drop a `.txt` file.

The panel immediately shows how it'll be split. Check it. Look for:
- Numbers and abbreviations — turn on **Show normalized** to see how they'll be pronounced. `15GB` should read as "fifteen gigabytes." Fix anything that looks wrong by spelling it out in your script.
- Chunk breaks landing mid-thought — put `---` on its own line to force a break where you want one.
- Blank lines between paragraphs → longer pauses. Use them for pacing.

A 20-minute video is roughly 2,800–3,000 words, which becomes 45–55 chunks.

### Step 6 — Test before you commit

Generate a single chunk first and listen before committing to a full run. (The default backend runs Chatterbox only — Qwen3-TTS's dependencies conflict with Chatterbox's and the two can't share one Colab environment. The **A/B compare** button enables itself automatically if a backend ever reports both models.)

Then open **Advanced settings** and nudge **Expressiveness**: 0.4 is right for factual narration. Push it to 0.7+ only if you want drama.

Twenty seconds of testing here saves you regenerating twenty minutes of audio.

### Step 7 — Generate

Hit **Generate all**. Then leave it alone.

The queue runs one chunk at a time. Each bar fills green as it lands. A 20-minute script takes roughly 8–15 minutes on a T4.

Every finished chunk is saved to your browser immediately. If Colab disconnects, if your laptop sleeps, if you close the tab — **nothing is lost**. Restart the Colab cell, reconnect, hit **Generate remaining**, and it picks up exactly where it stopped.

### Step 8 — Fix and export

Scan the queue. Play anything that looks suspicious.

Bad chunk? Two options:
- **↻ Regenerate** — same text, new seed. Usually fixes it.
- **✎ Edit** — reword the awkward sentence, then regenerate. This fixes it properly.

When you're happy: **Export WAV** (best quality, drop into your video editor) or **MP3** (smaller). You also get:
- `chunks.zip` — every chunk as its own file, if you want to edit around them
- `transcript.srt` — captions with real timings, free

---

## The API (n8n and other automations)

Admin → **API Keys** → create one. It's shown once; only a SHA-256 hash is stored.

Admin → **API & n8n** has every snippet with your own URL already filled in. The short version:

```bash
# 1. start a job
curl -X POST https://your-app.vercel.app/api/v1/tts \
  -H "Authorization: Bearer $VOICEFORGE_KEY" \
  -H "Content-Type: application/json" \
  -d '{"text":"Hello from VoiceForge.","format":"mp3"}'
# -> 202 {"job_id":"…","status_url":"…"}

# 2. poll until done
curl "$STATUS_URL" -H "Authorization: Bearer $VOICEFORGE_KEY"
# -> {"status":"done","audio_url":"https://…mp3","duration":2.4}
```

| Endpoint | Does |
|---|---|
| `GET /api/v1/voices` | list your voices |
| `POST /api/v1/tts` | text → one stitched narration (async) |
| `POST /api/v1/tts/batch` | many lines → one clip each, not stitched |
| `GET /api/v1/jobs/{id}` | poll a job |
| `POST /api/v1/audio/speech` | OpenAI-compatible, synchronous, ≤600 chars |

**Why asynchronous:** a Vercel function is capped at 60 seconds and a cold GPU can use most of that before it speaks a word. So `/tts` hands back a job id immediately. Pass `callback_url` (n8n's `{{ $execution.resumeUrl }}`) and VoiceForge POSTs the finished job to you instead of you polling.

### Expressive Nepali narration (opt-in)

For Nepali scripts that mix in English tech words, `POST /api/v1/tts` takes a few extra fields (top level or inside `params`). Send none of them and nothing changes.

| Field | Does |
|---|---|
| `code_switch: true` | Nepali words are voiced by the Nepali engine, English words (kept in **English letters**) by the English model, in the same voice, then spliced. A single postposition after an English word rides along (`laptop को` → "laptop ko"), and acronyms are spelled (`IP` → "I P"). |
| `prosody_tags: true` | Honours `[excited]`, `[serious]`, `[calm]` (apply until the next tag) and `[pause]` (≈350 ms). Tags are never spoken. |
| `speed` | 0.8–1.4, pitch preserved (ffmpeg `atempo`). |
| `lexicon` | Extra English → Devanagari spellings for when `code_switch` is off, e.g. `{"router":"राउटर्"}`. |

```json
{
  "voice_id": "bijay-nepali-522a299a",
  "text": "[excited] तपाईंको laptop को IP कसैले देख्न सक्छ? [calm] Settings मा गएर Account option खोल्नुहोस्, [pause] Two-step verification On गर्नुहोस्।",
  "code_switch": true,
  "prosody_tags": true,
  "speed": 1.1
}
```

Every sentence is checked for the model talking past the end of the text (the "saya"/"ha" tail): over-long takes are re-rolled, and a short trailing burst after a breath is trimmed. The finished job reports `params_used` and per-sentence `segments` (tone, runs, engine, takes, start/end).

**Linked voices.** In Admin → Voices, open *Linked voices* on your Nepali voice and link other clips of yourself: one speaking **English** (used for the English words), and optionally one each speaking **excited**, **serious** and **calm** (used for sentences with that tag). Chatterbox copies the delivery of its reference clip, so a clip in the right mood does more for tone than any setting. Each linked clip is just another voice upload, 10–20 s.

Per-key **rate limits** and **monthly character quotas** are set when you create the key. Generated audio is deleted after the retention window in Settings (7 days by default).

---

## Training data (collecting recordings for fine-tuning)

**Admin → Model training → Training data** collects clips to fine-tune a voice on later — Nepali and English for now. It is separate from **Voices**: nothing here appears in the voice library or is used for TTS.

- Every clip belongs to a **speaker** (picked at the top of the page). A training run learns one person, so each speaker is a separate set with its own progress and downloads.
- A clip is three parts: the **audio**, the **transcript** (exact words — what the model learns from) and an optional **description** (tone, room, mic — notes for people, never part of the transcript).

- **Read a sentence** shows built-in sentences (about 80 Nepali, 60 English) weighted toward the words the model gets wrong; you record each one and the transcript is exact automatically. **Free recording** takes any clip, recorded or uploaded, with the exact words typed in.
- Every clip is trimmed to the speech, converted to 24 kHz mono WAV and checked before it can be saved: 3–20 seconds, not distorted, not too quiet, no long pauses, and a transcript that plausibly fits the length.
- Each language shows its progress toward 30 minutes, about enough for a first training run. **Dataset (.txt)** downloads `audio_url|transcript`, one clip per line; **JSON** downloads the full records with speaker and description. Both cover the selected speaker only.

Recording changes nothing by itself — today's voices keep working exactly as before. Clips are stored in the bucket under `training/<language>/` and are never swept.

## Presenter video (lip-synced intro and outro clips)

A presenter is the face that speaks your intro and outro. Everything else in a video is rendered by your own n8n workflows, not by VoiceForge.

**Add one** in **Admin → Presenters**, the same way you add a voice:

- **A recording** — about 15 seconds of the presenter facing the camera and talking, in good light. Only the mouth is redrawn to match each new line; everything else stays real footage, so this looks the most natural.
- **A still image** — one clear, front-facing picture, animated from nothing. Use it for an illustrated or AI-generated presenter. It needs a much larger GPU than a recording does.

The first presenter becomes the default. `GET /api/v1/presenters` lists them, so a workflow can name a different one for a single video.

**Where it renders.** Presenter video uses the same registered backends as voice, in the same order, among the ones that report the engine. Each backend card in **Admin → Backends** has three **Use for** switches — **Voice**, **Presenter** and **AI video** — separate from Enable, so for example Modal (paid) can be kept out of video while the free notebooks still do everything. Every feature keeps the Colab → Kaggle → Modal order among the backends whose switch is on. The Presenters page says, per kind, whether anything connected can render it right now and why not.

**Make a clip in the studio.** Open **Presenter Video**, type the line, choose a voice and a presenter, and press Generate. The page shows which step is running, then the finished MP4 with a download button, a link, and its measured lip-sync score.

**Make a clip from a workflow.** One call does the narration and the lip-sync:

```json
POST /api/v1/presenter
{
  "text": "Hello everyone, welcome back to the channel.",
  "voice_id": "bijay-english-faafab11",
  "presenter_id": "avatar-1-42f29930"
}
```

Both ids are optional and fall back to the defaults; each presenter and voice card has a copy button for its id. Instead of `text` you can send `audio_job_id` (a finished TTS job) or `audio_url`. The call returns a job: poll `/api/v1/jobs/{id}` until it is done, then pass its `video_url` to `POST /api/v1/video` as the intro or outro clip. Text is limited to 900 characters, since a presenter clip is an intro or an outro and the engine stops at 90 seconds of audio.

**Status.** Recordings work on Modal, using LatentSync 1.6 on an L4 GPU. It runs 20 steps, guidance 1.5, DeepCache off (Nov 2026; the Oct 2026 trial of 40 steps and guidance 2.0 doubled the time and made the mouth jittery, without making it sharper). A 7.7-second line took about 4.5 minutes and about six cents on Modal. Colab and Kaggle run the lower-resolution LatentSync 1.5 on a T4: often 10–30 minutes for a short line, with a softer mouth. The studio shows real progress and the time left while the engine runs. A workflow can ask for `"steps"` (20–50) and `"guidance"` (1.0–3.0). Still images are not available yet — no engine is installed for them.

**Better lip sync comes from the recording too:** face the camera, keep the face large and well lit, never cover the mouth, keep head turns small, and actually talk in the original footage. Lip sync is likely weaker for Nepali than for English, since the engine was trained mostly on English speech. The lip-sync score under each clip (above 6 is good) tells you whether a change helped.

Use your own face, a generated or fictional one, or a real person who has given you explicit permission. Every upload asks which, and needs a confirmation.

## AI video (clips from a text prompt)

Describe a scene and get a short 24 fps clip for b-roll, intros or YouTube Shorts. It uses **Wan 2.2 TI2V-5B** (Alibaba, Apache 2.0, fine for commercial YouTube use). Clips are 2, 3.4 or 5 seconds, 16:9 or 9:16, at 720p or 480p.

**Turn it on (Modal, recommended).** The **Deploy Modal backend** workflow deploys the video app (`modal/voiceforge_wan.py`) after voice, and downloads the weights (~25 GB) into a Modal Volume the first time. Then press **Test connection** on the Modal card in **Admin → Backends**. The AI Video page says **Ready · modal** once it works. By hand:

```bash
modal deploy modal/voiceforge_wan.py
modal run modal/voiceforge_wan.py::download
```

It runs on an L40S and shuts down after 2 minutes idle. Expect roughly 5–10 minutes per 5-second 720p clip — around $0.20–0.35 if the L40S is still about $2/hour (check modal.com/pricing). These are estimates until the first real runs. Status checks use a CPU-only address, so they never wake the GPU.

**Or on Colab / Kaggle.** On by default (`ENABLE_AI_VIDEO = True` in Cell 0) and controlled from the backend's **AI video** switch in Admin → Backends: when it is on, the session installs a second environment and downloads ~25 GB in the background (15–20 minutes; voice works meanwhile); when it is off, nothing is downloaded. Turning it on while a notebook runs starts the install at its next heartbeat (within ~2.5 minutes). It uses a 4-bit version of the model to fit a T4 and defaults to 480p, roughly 10–20 minutes per clip. On a single GPU, narration waits while a clip renders. **Kaggle "GPU T4 x2"** puts clips on the second GPU, so narration never waits. If a notebook runs out of memory, the clip moves to the next backend (Modal) automatically.

**Make a clip in the studio.** Open **AI Video**, describe the scene (or pick an example), choose 16:9 or 9:16 and the length, and press Generate. When it is done you get the MP4, a download button, and the settings used. **Reuse settings** loads them back, so the same seed gives the same clip and you can vary only the prompt.

**Make a clip from a workflow.**

```json
POST /api/v1/clips
{ "prompt": "Aerial drone shot over misty mountains at sunrise, cinematic", "aspect": "landscape", "seed": 42 }
```

It returns a job. Poll `/api/v1/jobs/{id}` (every ~60 s is plenty) until it is done; it carries `video_url` and `settings`. Optional: `quality` (`720p`/`480p`), `num_frames` (49, 81 or 121), `steps`, `guidance`, `negative_prompt`, `callback_url`. `GET /api/v1/clips` says whether a clip can be made right now. Clips are stored under `clips/` and removed by the same retention sweep as audio.

**Prompt tips.** Say what is in the scene, what moves, how the camera moves, the light and the style, e.g. *"Slow motion shot of coffee being poured into a white cup, steam rising, warm morning light, cozy cafe"*.

---

## Troubleshooting

| What you see | What's wrong | Fix |
|---|---|---|
| `ValueError`/`ModuleNotFoundError` in Cell 2 importing `chatterbox`, or dozens of red `pip` "X requires Y" lines in Cell 1 | Colab/Kaggle's huge preinstalled package set drags numpy/transformers/safetensors to newer versions than chatterbox-tts declares ([known chatterbox issue](https://huggingface.co/ResembleAI/chatterbox/discussions/19)); a copy of numpy can also already be loaded in memory before Cell 1 ever runs, which a plain reinstall can't fix | Cell 1 force-pins the exact versions chatterbox-tts needs (`numpy==1.26.4`, `transformers==5.2.0`, `safetensors==0.5.3`). Always **Run All → restart when Cell 1 tells you to → Run All again from the top.** Never run cells individually or skip Cell 1 — that sequence is always correct on both platforms. The other red "requires numpy>=2" lines (jax, opencv, rasterio, etc.) are unrelated packages the backend never imports — ignore them. |
| Studio says **GPU Offline** | Colab/Kaggle tab closed, or the session ended | Start the notebook again (**Admin → Backends → Open notebook**). The studio re-checks every 30 s, or press **Check again** |
| Colab: **Disk is almost full**, or Backends says AI video was skipped for disk space | Voice, presenter and AI video together nearly fill a free Colab disk (~112 GB). The installs keep no caches and check for room first, so voice keeps working | **Runtime → Disconnect and delete runtime**, then **Run all** on a fresh machine. The notebook log shows `disk: … GB used` after each install |
| `No GPU` error in Cell 2 | Runtime is on CPU — on Kaggle this often happens right *after* the restart the numpy fix requires, since Kaggle can silently detach the accelerator on restart | Colab: Runtime → Change runtime type → T4 GPU → **Run all again**. Kaggle: re-check the **Accelerator** setting in the session sidebar (it may have reset to **None**), set it back to GPU T4 x2/P100, confirm **Internet** is still On, then **Run all again**. |
| Voice doesn't sound like you | Sample too short, noisy, or transcript missing/wrong | Re-record 20 clean seconds. Type the transcript exactly. |
| Words are slurred or rushed | Chunk too long, or unusual words | Break the sentence up. Spell tricky words phonetically in the script. |
| Random pause or wrong pronunciation | Model drift on that chunk | ↻ Regenerate. If it recurs, ✎ edit the wording. |
| Generation stops partway | Colab hit its session limit | Re-run Cell 3, reconnect, **Generate remaining**. Your finished chunks are safe. |
| Chunks are getting slower | Colab throttling a long free session | Fine. Let it finish, or restart the runtime and resume. |
| Video tab: "not loaded" on an engine | That engine's checkpoints didn't download in the video notebook's Cell 1 | Re-run Cell 1 and watch for download errors; Cell 2 prints which engines are ready. The other engine still works. |

---

## The honest limits

- **Colab free tier gives you a few hours per session**, and there's a rough daily cap. More than enough for a video or two a day. Not enough to run a service on.
- **The backend URL changes every session.** By design — it's a fresh tunnel each time. You don't see it: the notebook registers it for you.
- **The Colab tab must stay open** while you generate.
- **Your voice sample never leaves your control.** It goes from your browser to *your* Supabase bucket, and from there to *your* GPU session. Not to Anthropic, not to any TTS company.
- **Languages:** the backend runs Chatterbox Multilingual — 23 languages including English and Hindi (pick one in Model controls). Number expansion ("15GB" → "fifteen gigabytes") only applies to English scripts; other languages keep digits for the model to read in-language.
- **Nepali** is *not* one of those 23. It runs on a separate fine-tuned checkpoint (`chatterbox-ne`, the Nepali T3 from `Firoj112/chatterbox-nepali-runs`), which every backend loads the first time a Nepali request arrives. English words inside Nepali text are respelled in Devanagari before they reach the model, so each sentence is read whole by one model; add your own spellings with `lexicon`. If the checkpoint cannot be loaded the job fails and its error says why; Nepali is never read by another language's model. A finished job reports `engine_used: "chatterbox-ne"` and a `diagnostics` block saying what each chunk did. Two things the checkpoint needs, both handled for you and both easy to break: it must be called with its own `[ne]` language tag, and chunks should stay under 200 characters. `VOICEFORGE_NE_MODEL` / `VOICEFORGE_NE_FILE` point the backend at a different checkpoint.

---

## Local development

```bash
npm install
npm run dev    # http://localhost:3000
npm test       # chunker + normalization unit tests
```

The app is a thin client — no model ever runs in a Next.js route. Scripts and generated audio stay in your browser's IndexedDB; voices live in the server-side library (Supabase) so every backend can reach them. Speech requests go through `/api/gateway/*`, which is the only place that knows a backend URL or the backend secret. See `.claude_context.md` for architecture constraints.

---

## Ethics

Clone your own voice. Or clone a voice you have explicit permission to clone. That's the whole rule, and it isn't a formality — in most jurisdictions, synthesizing someone's voice without consent is now illegal, and it's a genuinely harmful thing to do regardless.
