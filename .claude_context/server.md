# Server index — TypeScript (lib/server, app/api)

updated: 2026-11-02 | commit: 12be38a

Everything that runs ONLY on the server: Next.js route handlers
(`app/api/**/route.ts`) and the modules they call (`lib/server/*.ts`,
`middleware.ts`). This is the only layer allowed to hold a backend URL,
`BACKEND_SECRET`, a Supabase service-role key, or an API-key hash. The
browser never reaches a GPU directly — see notes.md "Rules that CHANGED".

## Index

app.api.admin.backends.route.ts (1-149)
  .GET (24-39)
  .PATCH (42-139)
  .DELETE (141-149)

app.api.admin.backends.test.route.ts (1-124)
  .POST (30-124)

app.api.admin.jobs.route.ts (1-71)
  .GET (18-64)
  .DELETE (66-71)

app.api.admin.keys.route.ts (1-57)
  .GET (19-25)
  .POST (33-47)
  .DELETE (49-57)

app.api.admin.presenter-clips.[id].route.ts (1-49)
  .GET (19-49)

app.api.admin.presenter-clips.route.ts (1-65)
  .POST (24-65)

app.api.admin.presenters.[id].route.ts (1-39)
  .PATCH (15-31)
  .DELETE (33-39)

app.api.admin.presenters.route.ts (1-92)
  .GET (31-53)
  .schema (55-64)
  .POST (66-92)

app.api.admin.presenters.upload.route.ts (1-66)
  .POST (36-66)

app.api.admin.session.route.ts (1-98)
  .tooManyAttempts (37-57)
  .POST (59-92)
  .DELETE (94-98)

app.api.admin.settings.route.ts (1-74)
  .schema (12-49)
  .GET (51-53)
  .PUT (55-74)

app.api.admin.training.[id].route.ts (1-39)
  .PATCH (16-32)
  .DELETE (34-39)

app.api.admin.training.manifest.route.ts (1-68)
  .GET (17-68)

app.api.admin.training.route.ts (1-104)
  .GET (28-40)
  .POST (60-104)

app.api.admin.voices.[id].route.ts (1-76)
  .patchSchema (13-27)
  .PATCH (29-63)
  .DELETE (65-76)

app.api.admin.voices.[id].sync.route.ts (1-43)
  .POST (18-43)

app.api.admin.voices.route.ts (1-76)
  .GET (23-29)
  .POST (37-76)

app.api.backends.register.route.ts (1-116)
  .schema (25-63)
  .POST (72-116)

app.api.gateway.clips.[id].route.ts (1-41)
  .GET (18-41)

app.api.gateway.clips.route.ts (1-63)
  .schema (25-34)
  .GET (36-39)
  .POST (41-63)

app.api.gateway.generate.route.ts (1-100)
  .schema (23-33)
  .POST (35-100)

app.api.gateway.jobs.[id].route.ts (1-40)
  .GET (19-40)

app.api.gateway.status.route.ts (1-48)
  .GET (15-48)

app.api.internal.cleanup.route.ts (1-40)
  .GET (26-40)

app.api.internal.jobs.[id].complete.route.ts (1-132)
  .schema (23-69)
  .POST (71-132)

app.api.internal.training.activate.route.ts (1-44)
  .POST (29-44)

app.api.internal.training.manifest.route.ts (1-59)
  .GET (25-59)

app.api.v1.audio.speech.route.ts (1-128)
  .schema (35-45)
  .POST (47-128)

app.api.v1.clips.route.ts (1-108)
  .schema (28-45)
  .GET (47-52)
  .POST (54-108)

app.api.v1.jobs.[id].route.ts (1-77)
  .GET (23-77)

app.api.v1.presenter.route.ts (1-162)
  .schema (29-58)
  .POST (60-162)

app.api.v1.presenters.route.ts (1-51)
  .GET (16-37)
  .POST (43-51) :: POST /api/v1/presenters { "action":

app.api.v1.tts.batch.route.ts (1-154)
  .paramsSchema (31-61) :: Same overrides the single-shot endpoint accepts, so both behave alike
  .schema (63-73)
  .POST (75-154)

app.api.v1.tts.route.ts (1-176)
  .expressiveFields (35-46) :: Expressive narration (Nepali)
  .paramsSchema (48-79)
  .ttsSchema (81-89)
  .POST (91-176)

app.api.v1.voices.route.ts (1-26)
  .GET (12-26)

lib.server.apiauth.ts (1-137)
  .apiError (31-33)
  .checkUploadLimit (42-53) :: A separate, slower bucket for creating uploads
  .checkQuota (59-66) :: Quota check, split out so endpoints can authenticate BEFORE parsing a…
  .authenticate (72-121) :: @param chars characters this request would generate, for the quota ch…
  .appUrlFrom (128-137) :: This deployment's own public URL, for building callback and status UR…

lib.server.apikeys.ts (1-184)
  .currentMonth (45-47)
  .hashKey (49-55)
  .generateKey (58-65) :: 32 random bytes, base64url — 256 bits, so guessing is not a threat mo…
  .listApiKeys (71-81)
  .createApiKey (95-115) :: Returns the record plus the one and only sight of the full key
  .revokeApiKey (117-125)
  .deleteApiKey (127-134)
  .resolveApiKey (137-148) :: Bearer token -> the key that owns it, or null
  .recordKeyUsage (151-166) :: Fire-and-forget:
  .charsThisMonth (168-170)
  .quotaError (176-184) :: Quota check

lib.server.auth.ts (1-110)
  .isAuthConfigured (15-17) :: Auth only switches on once BOTH vars are set — see isAuthConfigured()
  .hmac (38-48)
  .safeEqual (54-60) :: Compare without leaking length or position through timing
  .sha256 (62-65)
  .verifyPassword (67-71)
  .createSessionToken (74-80) :: <expiresAt>.<signature> — self-contained, no server-side session store
  .verifySessionToken (82-100)
  .sessionCookieOptions (102-110)

lib.server.backendPatch.ts (1-51)
  .backendPatchSchema (26-49) :: ORDER AND .strict() ARE LOad-BEARING

lib.server.backends.ts (1-407)
  .computeHealth (62-88)
  .toView (90-99)
  .getBackend (101-104)
  .listBackends (106-113)
  .registerBackend (120-179) :: Upsert from a registration/heartbeat
  .updateBackend (181-190)
  .forgetBackend (192-196)
  .getActiveSelection (198-200) :: --- active selection ------------------------------------------------…
  .setActiveSelection (202-204)
  .resolveBackend (207-209) :: The backend a request goes to first:
  .isUsableHealth (218-220) :: Whether a backend in this state should be sent work
  .backendFeatures (233-241) :: The per-feature switches as plain booleans (absent = on)
  .usableBackends (244-256) :: Every usable backend in the standard order;
  .constantTimeEquals (258-274) :: --- auth for machine endpoints --------------------------------------…
  .isValidRegistrationToken (276-280)
  .backendSecret (282-284)
  .isValidBackendSecret (287-291) :: A machine caller (a GPU backend or a training job) proving it holds B…
  .backendHeaders (294-300) :: Every gateway -> backend call carries this
  .recordReached (326-338) :: Note that this address answered
  .recordUnreachable (340-350)
  .recordHealthFacts (352-393)
  .recordJobUsage (395-407) :: --- usage counters --------------------------------------------------…

lib.server.blob.ts (1-39)
  .isBlobConfigured (17-21)
  .putBlob (27-35) :: Paths are already namespaced (voices/<id>, jobs/<id>) and the URL for…
  .deleteBlob (37-39)

lib.server.clipjobs.ts (1-698)
  .CLIP_LIMITS (52-58) :: --- limits (mirror backend/wan/settings.py;
  .clipRequestBody (83-120) :: Check a request and turn it into the body the backend expects
  .wanCandidateUrls (138-149) :: Where a backend's Wan service could be, derived from its voice addres…
  .shouldProbeWan (152-161) :: Whether a backend's Wan address should be asked (again) right now
  .wanInstallNote (164-172) :: A Wan install report as one line;
  .discoverWan (178-231) :: Ask a backend's Wan address what it can do, and remember the answer
  .discoverMissingWan (234-241) :: Ask every backend that is due to be asked
  .pickClipBackends (248-256) :: Which backends may make a clip, in the order given (listBackends retu…
  .clipSkipReasons (275-295) :: Why each free GPU cannot take a clip right now
  .describeSkips (298-300) :: "Kaggle:
  .heartbeatFields (325-361)
  .clipReadiness (379-413) :: Can a clip be made right now — and if not, why not?
  .requireTargetsWithAll (419-431)
  .newClipJob (433-458) :: --- jobs ------------------------------------------------------------…
  .dispatchClip (461-526) :: Hand a clip to the first backend that accepts it
  .createAndDispatchClip (529-534) :: Start a clip
  .completeClip (547-570) :: Finish a clip:
  .collectClip (572-606)
  .moveToNextBackend (609-630) :: Offer a failed clip to the next backend that can make it
  .failNote (633-636) :: A backend's failure in a few words:
  .restartLostClip (639-647) :: Send a clip its backend lost (scaled down, redeployed) once more
  .reconcileClip (650-698) :: Ask the backend how a clip is doing — the lost-callback safety net

lib.server.gateway.ts (1-233)
  .GatewayError (25-36)
  .NO_BACKEND (38-42)
  .NO_VOICE (44-48)
  .syncVoiceToBackend (51-78) :: Push a library voice onto a backend so it can be used by id from now …
  .gatewayGenerate (109-233) :: One chunk of speech

lib.server.jobs.ts (1-754)
  .getJob (134-136)
  .saveJob (138-142)
  .listJobs (144-148)
  .deleteJob (155-167)
  .callbackToken (173-180) :: The token a backend presents when calling us back
  .isValidCallbackToken (182-194)
  .JobError (207-215)
  .background (239-248)
  .flushPending (251-253) :: Settle any work scheduled by background
  .ensureVoiceCached (255-298)
  .createAndDispatchJob (307-500) :: Create the job, then hand it to a backend
  .resolveVoiceRefs (510-530) :: Turn a voice's linked ids into what the backend needs to cache them
  .collectJob (559-582) :: Pull every rendered file off the backend and into Blob
  .isBeingCollected (587-595) :: Whether a collector currently holds this job
  .collectLocked (605-662)
  .reconcileJob (678-736)
  .expiredJobs (739-748) :: Jobs older than the retention window, oldest first
  .purgeExpiredJobs (750-754)

lib.server.presenterjobs.ts (1-760)
  .presenterUrlOf (46-48) :: Where a backend takes presenter work — its own address unless it has …
  .presenterCandidateUrl (55-62) :: Modal serves voice and presenter video from two functions whose URLs …
  .installNote (68-76) :: A notebook's own account of its engine install, as one line for the P…
  .shouldProbePresenter (86-98) :: Whether a backend's presenter address should be asked (again) right n…
  .discoverPresenter (110-149) :: Ask a backend's presenter address what it can do, and remember the an…
  .reloadNotebookPresenters (158-179) :: Ask every notebook to load the presenter service's current code
  .discoverMissingPresenters (190-197) :: Ask every backend that could have a presenter address but has never b…
  .requirePresenter (235-247)
  .requireTargets (249-266)
  .newPresenterJob (268-298)
  .dispatchPresenter (301-358) :: Hand a presenter job to the first backend that accepts it
  .createAndDispatchPresenter (361-382) :: A presenter speaking audio that already exists
  .createPresenterFromText (397-464) :: A presenter speaking text:
  .advanceFromNarration (472-542) :: Take the second step of a text job once its narration is ready
  .completePresenter (560-588) :: Finish a presenter job:
  .collectPresenter (590-626)
  .moveToNextBackend (634-654) :: Offer a clip that failed on one backend to the next one that can make…
  .restartLostClip (659-677) :: Hand a lost clip to a backend again
  .reconcilePresenter (680-760) :: Ask the backend how a clip is doing — the lost-callback safety net

lib.server.presenters.ts (1-390)
  .PresenterError (49-56)
  .isPresenterStorageReady (58-60)
  .presenterStorageHint (62-76)
  .isPresenterKind (78-80) :: --- pure helpers (unit-tested) --------------------------------------…
  .isPresenterSource (82-84)
  .slugifyPresenterName (86-96)
  .maxBytesFor (98-100)
  .assertPresenterFile (102-134)
  .assertOurPresenterUrl (141-156) :: Only our own Blob store, and only under presenters/<kind>/
  .presenterCapability (166-168) :: The capability a backend must report to voice each kind
  .pickPresenterBackends (177-185) :: Which of backends may voice this kind of presenter, in the order given
  .presenterReadiness (212-259) :: Can this kind be rendered right now — and if not, which of the three …
  .usablePresenterBackends (261-265)
  .getDefaultPresenterId (271-273)
  .listPresenters (275-286)
  .getPresenter (288-290)
  .resolvePresenter (297-301) :: The presenter a request should use:
  .registerPresenter (316-357)
  .renamePresenter (359-369)
  .setDefaultPresenter (371-375)
  .deletePresenter (377-390)

lib.server.redis.ts (1-122)
  .isRedisConfigured (26-28)
  .getRedis (31-33) :: Counters and locks
  .redisFailure (36-40) :: Did a storage call fail recently?
  .DEFAULT_SETTINGS (91-111)
  .getSettings (113-116)
  .saveSettings (118-122)

lib.server.training.ts (1-246)
  .TrainingError (37-44)
  .isTrainingStorageReady (46-48)
  .trainingStorageHint (50-59)
  .newSampleId (61-64) :: --- pure helpers (unit-tested) --------------------------------------…
  .cleanTranscript (66-68)
  .cleanSpeaker (73-75)
  .sameSpeaker (78-80) :: Speakers compare without case, so "bijay" and "Bijay" are one set
  .speakerOf (82-84)
  .speakersOf (87-97) :: Every speaker with clips, most clips first, spelled as first recorded
  .cleanDescription (100-102) :: Notes may run over a few lines, but not pages
  .summarize (104-113)
  .toPipeList (120-126) :: The dataset as training scripts expect it:
  .listSamples (128-134) :: --- store -----------------------------------------------------------…
  .getSample (136-138)
  .addSample (151-215)
  .updateSample (218-238) :: Fix a clip's transcript and/or description;
  .deleteSample (240-246)

lib.server.voices.ts (1-339)
  .VoiceStorageError (29-36)
  .isVoiceStorageReady (38-40)
  .voiceStorageHint (43-59) :: Why it isn't ready, phrased as the next thing to do
  .slugifyVoiceName (62-71) :: Readable, URL-safe blob paths:
  .newVoiceId (77-79) :: Slug plus a short random tail
  .readWavMeta (101-149) :: Read a WAV header without decoding the samples
  .getDefaultVoiceId (159-161)
  .listVoices (163-174)
  .getVoice (181-190) :: A voice by id
  .resolveVoice (199-208) :: Resolve the voice a request should use
  .createVoice (217-273)
  .mergeRefs (284-298) :: Apply a refs patch:
  .updateVoice (300-317)
  .setDefaultVoice (319-323)
  .deleteVoice (325-339)

middleware.ts (1-52)
  .middleware (25-47)
  .config (49-52)
