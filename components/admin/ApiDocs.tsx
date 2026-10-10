"use client";

import { useState } from "react";
import { Button } from "@/components/ui/Button";
import { IconCheck, IconLink } from "@/components/ui/Icons";

/**
 * Copy-ready API documentation, rendered with the reader's own app URL baked
 * in — the point is that every snippet can be pasted somewhere and just work,
 * rather than having a placeholder host to remember to replace.
 */

function Snippet({ code, label }: { code: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="mt-2">
      {label ? <p className="mb-1.5 text-[12px] font-medium text-muted">{label}</p> : null}
      <div className="flex items-start gap-2">
        <pre className="min-w-0 flex-1 overflow-x-auto rounded-xl border border-line bg-surface2 px-3.5 py-2.5 font-mono text-[11.5px] leading-relaxed text-ink">
          {code}
        </pre>
        <Button
          size="sm"
          onClick={() => {
            void navigator.clipboard.writeText(code);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          }}
        >
          {copied ? <IconCheck className="h-3.5 w-3.5" /> : <IconLink className="h-3.5 w-3.5" />}
        </Button>
      </div>
    </div>
  );
}

function Section({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="glass-card overflow-hidden">
      <div className="border-b border-line bg-surface2 px-5 py-3.5">
        <h2 className="text-[13px] font-semibold text-ink">{title}</h2>
        {description ? <p className="mt-0.5 text-[12.5px] text-muted">{description}</p> : null}
      </div>
      <div className="px-5 py-4 text-[13px] leading-relaxed text-muted">{children}</div>
    </div>
  );
}

function Endpoint({ method, path, blurb }: { method: string; path: string; blurb: string }) {
  const tone = method === "GET" ? "bg-brand-50 text-brand-700" : "bg-videoSoft text-video";
  return (
    <div className="flex flex-wrap items-baseline gap-2 border-b border-line py-2.5 last:border-0">
      <span className={`rounded px-1.5 py-0.5 font-mono text-[10.5px] font-bold ${tone}`}>
        {method}
      </span>
      <code className="font-mono text-[12px] text-ink">{path}</code>
      <span className="w-full text-[12.5px] text-muted sm:w-auto sm:flex-1">{blurb}</span>
    </div>
  );
}

export function ApiDocs({ appUrl }: { appUrl: string }) {
  const base = appUrl.replace(/\/+$/, "");

  return (
    <div className="flex flex-col gap-5">
      <Section
        title="Base URL and auth"
        description="Every /api/v1 call needs a key from the API Keys page."
      >
        <Snippet code={`${base}/api/v1`} label="Base URL" />
        <Snippet code={`Authorization: Bearer vf_live_…`} label="Header on every request" />
        <p className="mt-3">
          Keys are shown once and stored only as a SHA-256 hash. Revoking takes effect on the very
          next request.
        </p>
      </Section>

      <Section title="Endpoints">
        <Endpoint method="GET" path="/api/v1/voices" blurb="List your voices and which is default." />
        <Endpoint
          method="POST"
          path="/api/v1/tts"
          blurb="Text → one stitched narration. Returns a job id."
        />
        <Endpoint
          method="POST"
          path="/api/v1/tts/batch"
          blurb="Many lines → one clip each, not stitched."
        />
        <Endpoint method="GET" path="/api/v1/jobs/{id}" blurb="Poll a job; returns audio_url when done." />
        <Endpoint
          method="POST"
          path="/api/v1/audio/speech"
          blurb="OpenAI-compatible, synchronous, 600 characters max."
        />
        <Endpoint method="POST" path="/api/v1/video" blurb="Scenes → a rendered MP4. Returns a job id." />
        <Endpoint method="POST" path="/api/v1/uploads" blurb="Somewhere to PUT an image or clip you host yourself." />
        <p className="mt-3">
          Everything except <code className="font-mono text-[12px]">/audio/speech</code> is
          asynchronous. That isn&apos;t a style choice: a Vercel function is capped at 60 seconds,
          and a cold GPU can take most of that before it speaks a word.
        </p>
      </Section>

      <Section title="Generate narration" description="The normal path: start a job, then poll it.">
        <Snippet
          label="1. Start the job"
          code={`curl -X POST ${base}/api/v1/tts \\
  -H "Authorization: Bearer $VOICEFORGE_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"text":"Hello from VoiceForge.","format":"mp3"}'`}
        />
        <Snippet
          label="Response (202)"
          code={`{
  "job_id": "8f1c…",
  "status": "running",
  "status_url": "${base}/api/v1/jobs/8f1c…",
  "chars": 24,
  "chunks": 1,
  "backend": "colab"
}`}
        />
        <Snippet
          label="2. Poll until status is done"
          code={`curl ${base}/api/v1/jobs/8f1c… \\
  -H "Authorization: Bearer $VOICEFORGE_KEY"`}
        />
        <Snippet
          label="Response when finished"
          code={`{
  "job_id": "8f1c…",
  "status": "done",
  "duration": 2.4,
  "audio_url": "https://…blob.vercel-storage.com/jobs/8f1c….mp3"
}`}
        />
        <p className="mt-3">
          <code className="font-mono text-[12px]">audio_url</code> is a plain HTTPS file — download
          it with any HTTP node. It is deleted after the retention window set in Settings.
        </p>
      </Section>

      <Section
        title="n8n — poll loop"
        description="The version that works everywhere, including n8n Cloud."
      >
        <ol className="ml-4 list-decimal space-y-2">
          <li>
            <strong>HTTP Request</strong> → POST{" "}
            <code className="font-mono text-[12px]">{base}/api/v1/tts</code>, Authentication ={" "}
            <em>Generic → Header Auth</em>, Name ={" "}
            <code className="font-mono text-[12px]">Authorization</code>, Value ={" "}
            <code className="font-mono text-[12px]">Bearer vf_live_…</code>. Body (JSON):
            <Snippet code={`{ "text": "{{ $json.script }}", "format": "mp3" }`} />
          </li>
          <li>
            <strong>Wait</strong> → 10 seconds.
          </li>
          <li>
            <strong>HTTP Request</strong> → GET{" "}
            <code className="font-mono text-[12px]">{`{{ $('HTTP Request').item.json.status_url }}`}</code>{" "}
            with the same header auth.
          </li>
          <li>
            <strong>IF</strong> →{" "}
            <code className="font-mono text-[12px]">{`{{ $json.status }}`}</code> equals{" "}
            <code className="font-mono text-[12px]">done</code>. False branch loops back to the Wait
            node.
          </li>
          <li>
            <strong>HTTP Request</strong> → GET{" "}
            <code className="font-mono text-[12px]">{`{{ $json.audio_url }}`}</code>, Response
            Format = <em>File</em>. That gives you the MP3 as binary data.
          </li>
        </ol>
      </Section>

      <Section
        title="n8n — callback (no polling)"
        description="Fewer nodes, but needs an n8n instance VoiceForge can reach."
      >
        <ol className="ml-4 list-decimal space-y-2">
          <li>
            <strong>Wait</strong> node → Resume = <em>On Webhook Call</em>. Copy its resume URL
            expression.
          </li>
          <li>
            <strong>HTTP Request</strong> before it → POST{" "}
            <code className="font-mono text-[12px]">/api/v1/tts</code> with:
            <Snippet
              code={`{
  "text": "{{ $json.script }}",
  "format": "mp3",
  "callback_url": "{{ $execution.resumeUrl }}"
}`}
            />
          </li>
          <li>
            When the render finishes, VoiceForge POSTs the finished job to that URL and n8n resumes
            with <code className="font-mono text-[12px]">audio_url</code> in the body.
          </li>
        </ol>
        <p className="mt-3">
          The callback is best-effort. Polling <code className="font-mono text-[12px]">/jobs/{"{id}"}</code>{" "}
          still works as a fallback — a poll also re-checks the backend, so a lost callback costs a
          delay rather than the render.
        </p>
      </Section>

      <Section
        title="Batch — one clip per line"
        description="For reels and short-form, where every scene needs its own file."
      >
        <Snippet
          code={`curl -X POST ${base}/api/v1/tts/batch \\
  -H "Authorization: Bearer $VOICEFORGE_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"items":[{"text":"Scene one."},{"text":"Scene two."}]}'`}
        />
        <Snippet
          label="Finished job"
          code={`{
  "status": "done",
  "items": [
    { "index": 0, "duration": 1.4, "audio_url": "https://…-0.mp3" },
    { "index": 1, "duration": 1.5, "audio_url": "https://…-1.mp3" }
  ]
}`}
        />
      </Section>

      <Section
        title="OpenAI-compatible endpoint"
        description="Change the base URL in an existing OpenAI client and it works."
      >
        <Snippet
          code={`curl -X POST ${base}/api/v1/audio/speech \\
  -H "Authorization: Bearer $VOICEFORGE_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"model":"tts-1","input":"Short and synchronous.","response_format":"mp3"}' \\
  --output speech.mp3`}
        />
        <p className="mt-3">
          Returns audio bytes directly, not JSON. Capped at 600 characters because it has to finish
          inside one request. <code className="font-mono text-[12px]">voice</code> takes a
          VoiceForge voice id; an unknown name falls back to your default voice, so clients sending{" "}
          <code className="font-mono text-[12px]">alloy</code> still work.
        </p>
      </Section>

      <Section
        title="Uploading your own images and clips"
        description="For anything not already on a public URL — generated images, branded cards."
      >
        <p>
          The file never passes through this API. You ask for a target, PUT the bytes straight to
          storage, then use the returned <code className="font-mono text-[12px]">public_url</code>{" "}
          as a scene. That is not a style choice: a request body over 4.5 MB is rejected by the
          platform before any of our code runs.
        </p>
        <Snippet
          label="1. Ask for somewhere to put it"
          code={`curl -X POST ${base}/api/v1/uploads \
  -H "Authorization: Bearer $VOICEFORGE_KEY" \
  -H "Content-Type: application/json" \
  -d '{"filename":"scene-01.png","content_type":"image/png","bytes":612345}'`}
        />
        <Snippet
          label="Response (201)"
          code={`{
  "upload_id": "8f1c…",
  "upload_url": "https://blob.vercel-storage.com/uploads/…/8f1c-scene-01.png",
  "method": "PUT",
  "headers": { "authorization": "Bearer vercel_blob_client_…", "content-type": "image/png" },
  "public_url": "https://….public.blob.vercel-storage.com/uploads/…/8f1c-scene-01.png",
  "expires_at": "2026-10-12T11:00:00.000Z"
}`}
        />
        <Snippet
          label="2. PUT the file, sending exactly those headers"
          code={`curl -X PUT "$UPLOAD_URL" \
  -H "authorization: $AUTH" -H "content-type: image/png" \
  --data-binary @scene-01.png`}
        />
        <p className="mt-3">
          The target is locked to that one path, that content type, that size and 15 minutes. Send
          a different type, a bigger file, or arrive late and storage refuses it.
        </p>
        <p className="mt-3">
          <code className="font-mono text-[12px]">purpose</code> decides how long it lives:{" "}
          <code className="font-mono text-[12px]">scene</code> (the default) is deleted after 7
          days, <code className="font-mono text-[12px]">brand</code> is kept and reports{" "}
          <code className="font-mono text-[12px]">expires_at: null</code>.
        </p>
        <Snippet
          label="Optional — confirm it landed before rendering"
          code={`curl -X POST ${base}/api/v1/uploads/8f1c…/complete \
  -H "Authorization: Bearer $VOICEFORGE_KEY"
# -> { "public_url": "https://…", "bytes": 612345 }`}
        />
      </Section>

      <Section
        title="Intro and outro"
        description="Bookends on a video render. On by default, taken from your asset library."
      >
        <Snippet
          code={`// Default — a random intro/outro from the library, if you have any:
{ "scenes": [ … ] }

// Suppress one or both:
{ "scenes": [ … ], "intro": true, "outro": false }

// Or pin a specific file:
{
  "intro": { "type": "clip", "url": "https://…/intro.mp4" },
  "scenes": [ … ],
  "outro": { "type": "image", "url": "https://…/endcard.png", "seconds": 6 }
}`}
        />
        <p className="mt-3">
          <code className="font-mono text-[12px]">intro</code> and{" "}
          <code className="font-mono text-[12px]">outro</code> behave like{" "}
          <code className="font-mono text-[12px]">music</code> and{" "}
          <code className="font-mono text-[12px]">banner</code>: they default to{" "}
          <code className="font-mono text-[12px]">true</code>, which picks one from the{" "}
          <strong>intro</strong> / <strong>outro</strong> kinds in your asset library. An empty
          library is not an error — you simply get no bookend.
        </p>
        <p className="mt-3">
          Rendered in order: intro, every scene, then outro, with the same transition. Length
          comes from <code className="font-mono text-[12px]">audio_url</code> if given, else{" "}
          <code className="font-mono text-[12px]">seconds</code>, else the clip&apos;s own length,
          else 4 seconds. Captions are never drawn on them — a bookend carries its own title.
        </p>
      </Section>

      <Section
        title="Languages and engines"
        description="Nepali, per-request overrides, and knowing which model actually ran."
      >
        <p className="mb-3">
          Most languages run on the multilingual Chatterbox checkpoint and are unaffected by any
          of this. A language with a <em>profile</em> can ask for a different engine and different
          pacing. Today only <code className="font-mono text-[12px]">ne</code> (Nepali) has one,
          because Nepali is not among Chatterbox&apos;s 23 languages.
        </p>
        <p className="mb-3">
          Settings resolve strongest-first:{" "}
          <strong>request params → the voice&apos;s own overrides → the language profile → the
          tuned defaults</strong>. A language with no profile therefore behaves exactly as it
          always has.
        </p>
        <Snippet
          code={`POST /api/v1/tts
{
  "text": "आजको समयमा प्रविधि हाम्रो जीवनको महत्वपूर्ण हिस्सा बनिसकेको छ।",
  "voice_id": "bijay-nepali-522a299a",
  "language": "ne",
  "params": { "engine": "chatterbox-ne", "cfg": 0.3 }   // all optional
}`}
        />
        <p className="mt-3">
          Accepted in <code className="font-mono text-[12px]">params</code> on{" "}
          <code className="font-mono text-[12px]">/api/v1/tts</code> and{" "}
          <code className="font-mono text-[12px]">/api/v1/tts/batch</code>:{" "}
          <code className="font-mono text-[12px]">engine</code>,{" "}
          <code className="font-mono text-[12px]">exaggeration</code>,{" "}
          <code className="font-mono text-[12px]">cfg</code>,{" "}
          <code className="font-mono text-[12px]">temperature</code>,{" "}
          <code className="font-mono text-[12px]">seed</code>,{" "}
          <code className="font-mono text-[12px]">model</code>. Plus{" "}
          <code className="font-mono text-[12px]">language</code> at the top level.
        </p>

        <p className="mt-4 mb-2 font-medium text-ink">Nepali, honestly</p>
        <p className="mb-3">
          Nepali runs on its own fine-tuned checkpoint, the{" "}
          <code className="font-mono text-[12px]">chatterbox-ne</code> engine, which each backend
          loads the first time a Nepali request arrives. English words inside Nepali text are
          respelled in Devanagari first, so one model reads each sentence whole; send{" "}
          <code className="font-mono text-[12px]">lexicon</code> to supply your own spellings. If
          the checkpoint cannot be loaded the job falls back to Hindi, which shares the script,
          and says so in <code className="font-mono text-[12px]">engine_used</code> rather than
          failing.
        </p>

        <p className="mt-4 mb-2 font-medium text-ink">Which engine ran</p>
        <p className="mb-3">
          A finished job reports <code className="font-mono text-[12px]">engine_used</code> —{" "}
          <code className="font-mono text-[12px]">chatterbox-ne</code> when the Nepali model ran,{" "}
          <code className="font-mono text-[12px]">fallback-hi</code> when it did not. A silent
          substitution is otherwise only detectable by ear, in a language you may not speak.
        </p>
        <Snippet
          code={`GET /api/v1/jobs/{job_id}
{ "status": "done", "audio_url": "https://…", "engine_used": "fallback-hi" }`}
        />

        <p className="mt-4 mb-2 font-medium text-ink">Comparing by ear</p>
        <Snippet
          code={`POST /api/v1/tts/compare
{ "text": "आजको समयमा प्रविधि…", "voice_id": "bijay-nepali-522a299a" }

// -> two jobs to poll, one per engine
{
  "language": "ne",
  "candidates": [
    { "label": "chatterbox-ne", "job_id": "…", "status_url": "/api/v1/jobs/…" },
    { "label": "fallback-hi",   "job_id": "…", "status_url": "/api/v1/jobs/…" }
  ]
}`}
        />
        <p className="mt-3">
          Two jobs rather than two files, because synthesis is asynchronous everywhere else here.
          Both count against your quota. A language with no fallback returns 400 —{" "}
          there is nothing to compare it against.
        </p>
      </Section>

      <Section
        title="Branded frames"
        description="Render the picture inside a window of your own overlay PNG."
      >
        <p className="mb-3">
          Give any scene a <code className="font-mono text-[12px]">frame</code> and the picture
          is scaled to cover <code className="font-mono text-[12px]">rect</code>, centre-cropped
          to it, placed at <code className="font-mono text-[12px]">rect.x, rect.y</code>, and
          your overlay laid over the whole canvas with its alpha respected. The motion runs{" "}
          <strong>inside the window only</strong> — the frame itself never moves. Captions and
          the banner are drawn on top of the frame.
        </p>
        <Snippet
          code={`{
  "width": 1920, "height": 1080,
  "scenes": [
    {
      "type": "image",
      "url": "https://…/photo.jpg",
      "audio_url": "https://…/line1.mp3",
      "motion": "zoom_in",
      "frame": {
        "overlay_url": "https://…/brand-1920x1080.png",
        "rect": { "x": 160, "y": 150, "w": 1600, "h": 760 }
      }
    },
    {
      "type": "clip",
      "url": "https://…/b-roll.mp4",
      "poster_url": "https://…/b-roll-still.jpg",
      "audio_url": "https://…/line2.mp3",
      "frame": {
        "overlay_url": "https://…/brand-1920x1080.png",
        "rect": { "x": 160, "y": 150, "w": 1600, "h": 760 }
      }
    }
  ]
}`}
        />
        <p className="mt-3">
          The overlay should be a PNG the full size of the video with a transparent window
          where <code className="font-mono text-[12px]">rect</code> is. It is fetched once per
          job however many scenes share it. A{" "}
          <code className="font-mono text-[12px]">rect</code> that does not fit inside{" "}
          <code className="font-mono text-[12px]">width</code> ×{" "}
          <code className="font-mono text-[12px]">height</code>, or has a zero or negative
          side, is a 400 naming the scene. Omit{" "}
          <code className="font-mono text-[12px]">frame</code> and the scene renders exactly as
          it did before.
        </p>
      </Section>

      <Section
        title="Clips"
        description="How a video clip is fitted to its narration."
      >
        <ul className="list-disc space-y-1 pl-5">
          <li>The clip&apos;s own audio is always dropped — you hear narration and music only.</li>
          <li>Scaled to cover and centre-cropped, to the frame&apos;s window when there is one.</li>
          <li>Longer than the narration: trimmed.</li>
          <li>
            Slightly shorter: slowed down, never below 0.8× speed, so the scene has no seam at
            all.
          </li>
          <li>
            Much shorter (more than 1.25× the gap): looped. The last frame is never frozen.
          </li>
          <li>
            Fails to download: retried once, then{" "}
            <code className="font-mono text-[12px]">poster_url</code> is used as a still if you
            gave one. Without a poster the job fails rather than silently dropping a scene and
            desyncing every caption after it.
          </li>
        </ul>
      </Section>

      <Section
        title="Captions and banner"
        description="Exactly what each flag draws."
      >
        <ul className="list-disc space-y-1 pl-5">
          <li>
            <code className="font-mono text-[12px]">captions: true</code> burns each scene&apos;s{" "}
            <code className="font-mono text-[12px]">caption</code> in, wrapped to at most two
            lines, white on a 50% black box, centred at 82% of the frame height. A scene with
            no caption gets nothing; intro and outro never get one.
          </li>
          <li>
            <code className="font-mono text-[12px]">captions: false</code> — no burned-in text
            anywhere, whatever the scenes carry.
          </li>
          <li>
            <code className="font-mono text-[12px]">banner: true</code> draws one image from
            your <strong>banner</strong> asset kind in the top-right corner, scaled to 7% of
            the video height, inset 2.5% from the right and 3.5% from the top, on every scene
            including the bookends. An empty banner library draws nothing.
          </li>
          <li>
            <code className="font-mono text-[12px]">banner: false</code> — nothing is drawn and
            no banner is even fetched.
          </li>
        </ul>
      </Section>

      <Section
        title="Timeline (YouTube chapters)"
        description="Where every scene lands in the finished MP4."
      >
        <p className="mb-3">
          A finished video job carries a{" "}
          <code className="font-mono text-[12px]">timeline</code>: real start and end seconds
          for every scene, bookends included, in render order. Crossfades do not shift it —
          each scene is given an extra tail exactly as long as the transition that eats it — so
          the last <code className="font-mono text-[12px]">end</code> matches the reported{" "}
          <code className="font-mono text-[12px]">duration</code>.
        </p>
        <Snippet
          code={`GET /api/v1/jobs/{job_id}
{
  "status": "done",
  "duration": 273.4,
  "video_url": "https://…",
  "timeline": [
    { "index": 0, "start": 0.0,   "end": 7.42 },
    { "index": 1, "start": 7.42,  "end": 15.1 }
  ]
}`}
        />
        <p className="mt-3">
          Index 0 is the intro when one was rendered, so map your chapter titles against the
          same list you sent rather than assuming scene 0 is index 0.
        </p>
      </Section>

      <Section
        title="Per-scene motion"
        description="Override the video-wide pan and zoom on individual scenes."
      >
        <Snippet
          code={`{ "type": "image", "url": "https://…/slide.png", "motion": "none" }`}
        />
        <table className="mt-2 w-full border-collapse text-[13px]">
          <tbody>
            <tr className="border-b border-line">
              <td className="py-2 pr-3 font-mono text-[12px] text-ink">none</td>
              <td className="py-2 text-muted">
                No pan or zoom, and no resampling — consecutive frames are pixel-identical. Use it
                for text slides, where a drifting crop makes the type shimmer.
              </td>
            </tr>
            <tr className="border-b border-line">
              <td className="py-2 pr-3 font-mono text-[12px] text-ink">zoom_in</td>
              <td className="py-2 text-muted">Slow centred push, 1.0 to 1.08 across the scene.</td>
            </tr>
            <tr className="border-b border-line">
              <td className="py-2 pr-3 font-mono text-[12px] text-ink">classic</td>
              <td className="py-2 text-muted">Gentle creeping zoom. The default.</td>
            </tr>
            <tr>
              <td className="py-2 pr-3 font-mono text-[12px] text-ink">dynamic</td>
              <td className="py-2 text-muted">Alternates pushes, pulls and pans across scenes.</td>
            </tr>
          </tbody>
        </table>
        <p className="mt-3">
          Omit it and the scene follows the top-level{" "}
          <code className="font-mono text-[12px]">motion</code>. It has no effect on a{" "}
          <code className="font-mono text-[12px]">clip</code>, which plays as filmed.
        </p>
        <p className="mt-3">
          Clips are scaled to cover and centre-cropped. If the narration outlasts the clip it loops
          seamlessly rather than freezing on its last frame, and is trimmed to the narration length.
        </p>
      </Section>

      <Section title="Errors and limits">
        <Snippet
          code={`{ "error": { "message": "…", "code": "rate_limit_exceeded", "type": "voiceforge_error" } }`}
        />
        <ul className="mt-3 ml-4 list-disc space-y-1">
          <li>
            <code className="font-mono text-[12px]">401 invalid_api_key</code> — missing, wrong or
            revoked key.
          </li>
          <li>
            <code className="font-mono text-[12px]">404 unknown_voice</code> — that voice id
            isn&apos;t in the library.
          </li>
          <li>
            <code className="font-mono text-[12px]">429 rate_limit_exceeded</code> — too many
            requests this minute; honour <code className="font-mono text-[12px]">Retry-After</code>.
          </li>
          <li>
            <code className="font-mono text-[12px]">429 quota_exceeded</code> — the key&apos;s
            monthly character quota is spent.
          </li>
          <li>
            <code className="font-mono text-[12px]">503 no_backend</code> — no GPU is online. Start
            a notebook.
          </li>
        </ul>
      </Section>
    </div>
  );
}
