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
  "audio_url": "https://….supabase.co/storage/v1/object/public/voiceforge-audio/jobs/8f1c….mp3"
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
          the checkpoint cannot be loaded the job <strong>fails</strong> and its{" "}
          <code className="font-mono text-[12px]">error</code> says why. Nepali is never read by
          another language&apos;s model: that produced audio that was neither language and
          looked like a success.
        </p>

        <p className="mt-4 mb-2 font-medium text-ink">Which engine ran</p>
        <p className="mb-3">
          A finished Nepali job reports{" "}
          <code className="font-mono text-[12px]">engine_used: &quot;chatterbox-ne&quot;</code>, and
          a <code className="font-mono text-[12px]">diagnostics</code> block with what each chunk
          did.
        </p>
        <Snippet
          code={`GET /api/v1/jobs/{job_id}
{ "status": "done", "audio_url": "https://…", "engine_used": "chatterbox-ne" }

// when the Nepali model cannot run
{ "status": "error", "error": "The Nepali model could not be used on this backend (…)" }`}
        />
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
