# Web index — pages + browser-side lib (app/**, lib/*.ts)

updated: 2026-11-02 | commit: 12be38a

Next.js pages/layouts under `app/**` (thin — they call `lib/server/*` on the
server or render a `components/views/*`/`components/admin/*` component) and
browser-safe helpers in `lib/*.ts` (never import `lib/server/*` from here —
that boundary is enforced by what each module is allowed to import, not by a
lint rule, so don't cross it).

## Index

app.admin.api.page.tsx (1-27)
  .appUrl (8-16) :: Snippets are only copy-ready if they carry this deployment's real host
  .ApiPage (18-27)

app.admin.backends.page.tsx (1-33)
  .appUrl (12-21) :: The connect snippet needs this deployment's own public URL to paste i…
  .BackendsPage (23-33)

app.admin.jobs.page.tsx (1-15)
  .JobsPage (6-15)

app.admin.keys.page.tsx (1-15)
  .KeysPage (6-15)

app.admin.layout.tsx (1-11)
  .AdminLayout (8-11)

app.admin.page.tsx (1-262)
  .SetupRow (35-57) :: Admin dashboard:
  .QUICK_LINKS (59-68)
  .AdminDashboard (70-262)

app.admin.presenters.page.tsx (1-15)
  .PresentersPage (6-15)

app.admin.settings.page.tsx (1-30)
  .SettingsPage (8-30)

app.admin.training.page.tsx (1-15)
  .TrainingPage (6-15)

app.admin.voices.page.tsx (1-15)
  .VoicesPage (6-15)

app.layout.tsx (1-55)
  .metadata (24-29)
  .viewport (31-36)
  .RootLayout (38-55)

app.login.page.tsx (1-153)
  .LoginForm (7-89)
  .LoginPage (91-153)

app.page.tsx (1-10)
  .Root (8-10) :: The studio used to live here as one page that swapped views in memory

app.studio.ai-video.page.tsx (1-8)
  .Page (6-8)

app.studio.layout.tsx (1-24)
  .StudioLayout (22-24)

app.studio.library.page.tsx (1-8)
  .Page (6-8)

app.studio.page.tsx (1-8)
  .StudioHome (6-8)

app.studio.presenter.page.tsx (1-8)
  .Page (6-8)

app.studio.speech.page.tsx (1-8)
  .Page (6-8)

lib.audio.ts (1-312)
  .decodeWav (20-83) :: Parse a RIFF/WAVE buffer to mono float32
  .encodeWavPcm16 (86-114) :: Encode mono float32 → 16-bit PCM WAV blob
  .resampleLinear (116-129) :: ---------------------------------------------------------------------…
  .trimAudio (131-135)
  .peakNormalize (138-150) :: Scale so the loudest sample sits at dbfs (default −1 dBFS)
  .DEFAULT_GAPS (162-165)
  .stitchChunks (168-201) :: Concatenate chunks in order with silence gaps between them
  .encodeMp3 (203-223) :: ---------------------------------------------------------------------…
  .computeSrtEntries (232-246) :: Derive caption timings from actual chunk durations + the stitch gaps
  .srtTime (248-256)
  .buildSrt (258-266)
  .base64ToBlob (268-273) :: ---------------------------------------------------------------------…
  .blobToBase64 (275-284)
  .wavBlobToPcm (286-288)
  .decodeAudioBlob (291-304) :: Decode any browser-supported audio blob (mp3/m4a/webm/wav) to mono PCM
  .formatDuration (306-312)

lib.backend.ts (1-20)
  .BackendError (10-20) :: The one error type the browser's generation queue depends on

lib.chunker.ts (1-220)
  .splitSentences (29-46)
  .bestSplitIndex (55-96) :: Find the best split index in s (end of first part), closest to midpoi…
  .splitLongSentence (99-112) :: Recursively split an over-long sentence into pieces ≤ max chars
  .packParagraph (122-140)
  .mergeTiny (143-168) :: Merge chunks under MIN_CHARS into a neighbour within the same paragra…
  .chunkScript (175-215) :: Split a raw script into chunk drafts:
  .estimateChunkSeconds (218-220) :: Rough spoken-duration estimate for a chunk that hasn't been generated…

lib.clipClient.ts (1-157)
  .useClipStatus (69-89) :: Readiness, loaded once and on demand
  .startClip (92-112) :: Start a clip
  .fetchClip (115-120) :: One poll
  .EXAMPLE_PROMPTS (123-150) :: Ready-made prompts that suit YouTube b-roll, intros and Shorts
  .CLIP_LENGTHS (153-157) :: The lengths the model can make (4k+1 frames at 24 fps)

lib.config.ts (1-93)
  .LANGUAGES (7-35) :: Languages supported by Chatterbox Multilingual (the backend model)
  .DEFAULT_PARAMS (73-82)
  .MODEL_INFO (84-93)

lib.confirm.ts (1-42)
  .useConfirmStore (26-38)
  .confirmAction (40-42)

lib.db.ts (1-174)
  .getDb (55-114)
  .putProject (117-124) :: Persist the project
  .getFirstProject (126-134)
  .saveChunkAudio (136-152) :: ---------------------------------------------------------------------…
  .loadAllChunkAudio (155-161) :: All stored audio for a project, keyed by chunkId
  .deleteChunkAudio (163-166)
  .clearProjectAudio (168-174)

lib.directUpload.ts (1-39)
  .uploadDirect (8-39) :: Browser side of a direct upload:

lib.gateway.ts (1-220)
  .fetchGatewayStatus (45-49)
  .gatewayGenerate (75-119)
  .waitForStudioJob (138-186) :: Follow a background job to its audio
  .uploadLibraryVoice (188-215)
  .deleteLibraryVoice (217-220)

lib.jobView.ts (1-38)
  .JOB_KIND_LABEL (8-13)
  .jobKind (15-17)
  .timeAgo (20-27) :: "3 min ago", "2 h ago", "4 d ago", or a date for anything older than …
  .formatSeconds (30-38) :: "5.0 s", "2:12", "1:02:03"

lib.languageProfiles.ts (1-152)
  .LANGUAGE_PROFILES (54-69)
  .profileFor (71-74)
  .needsOwnEngine (77-80) :: Languages that need a model the stock multilingual checkpoint doesn't…
  .languageForText (99-117) :: The language a piece of text should really be spoken in
  .resolveSynthesis (126-152) :: Work out what to ask the model for

lib.nepaliLoanwords.ts (1-368)
  .NEPALI_LOANWORDS (28-82) :: Trailing halant on purpose:
  .VOWELS (111-121)
  .toUnits (136-226)
  .render (228-241)
  .approximateInDevanagari (244-246) :: A rough Devanagari spelling of an English word nothing else knew
  .respell (250-285)
  .NEPALI_RESPELLINGS (304-312) :: Spellings chosen by ear, from clips of each word written four ways
  .applyNepaliPronunciations (314-333)
  .prepareNepali (340-350) :: Everything done to Nepali text before it reaches the model:
  .transliterateForNepali (358-368) :: Respell every Latin word in text in Devanagari

lib.normalize.ts (1-473)
  .numberToWords (45-59) :: Integer → English words
  .yearToWords (62-71) :: 4-digit year → spoken form
  .ordinalToWords (79-91) :: Integer → ordinal words
  .decimalToWords (93-101)
  .stripMarkdown (103-136) :: ---------------------------------------------------------------------…
  .asciiPunctuation (138-150) :: ---------------------------------------------------------------------…
  .UNIT_NAMES (152-173) :: ---------------------------------------------------------------------…
  .expandNumbers (186-256)
  .ABBREVIATIONS (258-273) :: ---------------------------------------------------------------------…
  .expandAbbreviations (275-285)
  .BUILT_IN_PRONUNCIATIONS (321-329) :: Words the model reads wrongly as written, respelled as ordinary Engli…
  .parsePronunciations (339-351) :: Read the "word = spoken form" list from Admin → Settings
  .formatPronunciations (353-357)
  .expandSpokenForms (375-427)
  .normalizeText (450-473)

lib.notebookLinks.ts (1-90)
  .isEmail (35-37)
  .isColabNotebookUrl (40-43) :: A saved Colab notebook:
  .isKaggleNotebookUrl (46-54) :: A saved Kaggle notebook:
  .withGoogleAccount (57-62) :: The Colab link opened in a specific Google account (authuser), when o…
  .notebookLinks (71-90) :: Every button's link, from the saved settings

lib.presenterClient.ts (1-57)
  .usePresenterStatus (28-52)
  .anyPresenterReady (55-57) :: True when at least one kind of presenter could be rendered right now

lib.presenterProgress.ts (1-40)
  .lipSyncStep (14-21) :: What the engine is doing at this progress, in plain words
  .lipSyncMinutesLeft (33-40) :: Minutes left, from how fast progress has moved since first was seen

lib.routingView.ts (1-77)
  .PROVIDER_LABEL (19-24)
  .usableHealth (27-29) :: Same predicate as isUsableHealth() in lib/server/backends.ts
  .servingVoice (49-51) :: The backend voice requests go to now, or null
  .servingPresenter (54-64) :: Where a recording-presenter clip would go now
  .servingClips (67-77) :: Where an AI video clip would go now

lib.storage.ts (1-457)
  .isStorageConfigured (31-35)
  .getSupabase (37-46)
  .StorageNotConfiguredError (48-55)
  .kindOfPath (69-79) :: What a file is, from where it sits
  .publicBaseUrl (82-85) :: Where the bucket's files are served from
  .getAudioUrl (87-89)
  .pathFromUrl (94-101) :: The bucket path a stored URL points at, or null when it is not ours
  .isOurFileUrl (104-107) :: Is this an https link into our own bucket?
  .recordFile (138-161) :: Note a file in the ledger
  .uploadAudio (171-188) :: Store a file at a fixed path and return its public URL
  .listAudio (191-210) :: A page of the ledger, newest first
  .deleteAudio (213-225) :: Remove a file and its ledger row
  .createSignedUpload (236-249) :: A URL a client can PUT one file to, at exactly this path, with no oth…
  .fileInfo (252-275) :: Size and type of a stored file, or null when there is no such file
  .noteFailure (277-285)
  .storageFailure (288-291) :: Did a storage call fail recently?
  .kvMGet (302-314) :: Read many keys in ONE round trip, in the order asked
  .kvGet (316-318)
  .kvSet (320-330)
  .kvDel (332-340)
  .kvScan (350-375) :: Every live value whose key starts with prefix
  .atomic (391-413)
  .getAtomicStore (416-418) :: Null when storage is not connected;
  .rateLimit (426-447) :: Count one request against a sliding window
  .purgeExpiredKeys (450-457) :: Drop expired keys

lib.store.ts (1-576)
  .createDefaultProject (81-92)
  .newChunk (94-105)
  .reconcileChunks (111-125) :: Rebuild the chunk list from fresh drafts, keeping status + audio for …
  .useApp (137-576)

lib.theme.ts (1-51)
  .isThemePref (15-17)
  .resolveTheme (22-24)
  .readThemePref (26-33)
  .setThemePref (36-43) :: Save a choice and apply it now
  .applyTheme (45-51)

lib.toast.ts (1-27)
  .useToasts (15-21)
  .toast (23-27)

lib.trainingChecks.ts (1-185)
  .isTrainingLanguage (15-17)
  .frameLevels (54-64)
  .analyzeClip (78-117)
  .trimToSpeech (123-132) :: Cut the silence before the first word and after the last, keeping a s…
  .checkClip (134-160)
  .checkTranscript (167-181) :: Does the transcript plausibly match the audio's length?
  .blocks (183-185)

lib.trainingPrompts.ts (1-998)
  .NE (28-870) :: Nepali prompts; ne-592..729 names/English words first
  .EN (872-932)
  .numbered (939-950) :: Number the sentences
  .TRAINING_PROMPTS (952-955)
  .PRIORITY (962-975) :: Recorded first:
  .recordingOrder (978-983) :: The sentences in recording order:
  .nextPrompt (986-998) :: The first prompt not yet recorded, in recording order, starting after…

lib.types.ts (1-370)
  .Voice (3-17)
  .Chunk (21-35)
  .ChunkDraft (38-42) :: What the chunker emits before chunks are materialized for generation
  .Project (44-53)
  .GenParams (55-67)
  .BackendStatus (71-82)
  .GenerateResult (84-93)
  .BackendHealthKind (102-112)
  .BackendRegistration (115-159) :: What a backend sends when it registers itself / heartbeats
  .RegisteredBackend (162-207) :: A row in the registry, as stored
  .BackendSystem (209-216)
  .BackendView (219-228) :: Registry row plus the status computed at read time
  .LibraryVoice (238-269) :: A voice that lives on the server, not in one browser
  .LibraryVoiceView (276-282) :: Library row plus whether it's the default pick
  .VideoChapterSpan (285-299) :: Where each scene lands in the finished MP4 — YouTube chapters, mostly
  .TrainingSample (301-325) :: ---------------------------------------------------------------------…
  .TrainingSummary (327-335)
  .Presenter (353-366)

lib.voiceReference.ts (1-265)
  .frameDb (33-42)
  .speechBounds (54-60) :: First and last moment of sound, in seconds;
  .trimToSpeech (63-69) :: The clip from just before its first sound to just after its last
  .checkReference (83-112) :: Is this clip a good reference?
  .arrangeRecording (130-170) :: Lay one continuous recording out the way the model needs it:
  .buildReference (188-265) :: Join clean clips into a reference:

lib.voiceScripts.ts (1-103)
  .ENGLISH (32-53)
  .NEPALI (55-76)
  .scriptGuide (79-83) :: The guide for a language
  .scriptText (86-88) :: The transcript for a script, as it is read
  .looksNepali (99-103) :: Nepali when a transcript is mostly Devanagari

scripts.check-supabase.ts (1-240)
  .check (25-33)
  .canonical (36-46) :: Postgres stores an object's fields in its own order;
  .get (61-143)
  .bytes (147-181)
  .signedPath (183-240)
