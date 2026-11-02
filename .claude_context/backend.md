# Backend index — Python

updated: 2026-11-02 | commit: 12be38a

`backend/*.py` (the shared FastAPI app, run on Colab/Kaggle/Modal) and
`modal/*.py` (Modal deploy entry points). No torch imports at module level
except `backend/wan/engine.py` — everything else must stay importable without
a GPU so it can be unit-tested. Tests: `backend/tests/` (pytest, no GPU).

## Index

backend.notebook_runner.py (1-382)
  .numpy_in_range (48-54) :: The numpy window the voice stack needs (see the notebook's Cell 1)
  .tunnel_url (57-60) :: The public URL in a line of cloudflared output, if there is one
  .registration_payload (63-72)
  .with_status (75-92) :: Add the server's status (AI video install state, disk, GPU memory)
  .status_line (95-134) :: One line per heartbeat, so the bottom of Cell 2 always says whether
  .should_stop (137-142) :: True once the backend has done nothing for the limit set in Admin -> …
  .version_tuple (145-146)
  .notebook_version_in (149-157) :: NOTEBOOK_VERSION as written in a notebook file (its JSON text)
  .newer_notebook_notice (160-186) :: A loud notice when GitHub has a newer notebook than this copy, else ""
  ._open_tunnel (245-270) :: A cloudflared quick tunnel
  .main (313-382)

backend.voiceforge_lang.py (1-1362)
  .EngineUnavailable (29-30) :: A language's own engine could not run, and nothing may stand in for it
  .plan_engine (33-85) :: Decide what actually runs, and what to call it in the result
  .ne_split_mix (88-102) :: Split "name.safetensors@0.6" into the file and its blend share
  .strip_state_prefixes (105-146) :: Normalise checkpoint keys to what the target module expects
  .ne_number_words (149-169) :: A whole number as it is said in Nepali:
  .ne_spell_number (172-194) :: Say a number the way a person reads it
  .ne_expand_digits (203-217) :: Replace every run of digits — ASCII or Devanagari — with spoken words
  .ne_chunks (220-264) :: Split Nepali text where it is actually spoken
  .ne_merge_short (267-301) :: Join a short sentence to its neighbour instead of voicing it alone
  .ne_pace (304-316) :: How fast finished Nepali audio is played, 1.0 being the model's own s…
  .ne_ending_frames (319-329) :: How long a Nepali take may hold its last letter, in 40 ms frames
  .ne_duration_cap (332-334) :: Seconds past which a Nepali take has run on beyond its text
  .ne_split_for_retry (337-345) :: Smaller pieces to try when a take of text would not end
  .ne_cut_runaway (348-378) :: Cut a take that ran on, at the first real pause after its words
  .ne_trim_trailing_blip (381-442) :: Drop a stray sound that comes after the sentence has clearly ended
  .ne_take_problem (445-504) :: Why this take should be voiced again, or "" if it sounds whole
  .ne_letters (507-509) :: Letters and vowel signs:
  .ne_speech_rate (536-554) :: Letters a second while speaking, pauses left out;
  .ne_pace_factor (557-561) :: How much to speed a take up (>1) or slow it down so it matches the vo…
  .ne_mark_pauses (575-665) :: Give every comma a short pause and every inner full stop a long one
  .ne_skeleton (668-670) :: The consonants and full vowels of a Nepali text, numbers spelled out
  .ne_heard_error (682-692) :: (share of consonants wrong, first word right) for what Whisper heard
  .ne_heard_score (695-724) :: Lower is better;
  .studio_eq_gains (749-754) :: dB to add per band, clamped;
  .studio_polish (786-800) :: A finished clip evened out towards the target balance and compressed
  .ne_plain_text (803-813) :: Nepali text the way the checkpoint was trained on it
  .ne_model_ending (816-829) :: End the text the way the Nepali model reads one ending, not two
  .ne_trim_leading (832-894) :: Start a take at its first word
  .ne_prepare (897-944) :: Spoken numbers, sentence and breath chunking, then no orphan fragments
  .strip_tags (947-949) :: Remove every tone/pause tag — what a listener must never hear
  .parse_prosody (956-1014) :: Turn tagged text into speakable sentences
  .tone_settings (1017-1027) :: Synthesis settings for one sentence:
  .gap_after (1030-1037) :: Silence after a sentence:
  .is_latin_word (1040-1053)
  .split_runs (1056-1097) :: Split a sentence into same-script runs:
  .english_for_tts (1100-1156) :: Make an English run speakable:
  .transliterate_latin (1159-1174) :: Replace Latin words with Devanagari spellings for the Nepali model
  .estimate_syllables (1176-1190)
  .expected_speech_seconds (1193-1195) :: How long honest speech of text should take
  .max_speech_seconds (1198-1207) :: Generous upper bound for honest speech of text
  .trim_speech (1218-1280) :: Cut leading silence, trailing silence and hallucinated tails
  .splice (1291-1313) :: Join runs from different models into one sentence
  .silence (1316-1317)
  .change_rate (1320-1349) :: Speed up or slow down without changing pitch (ffmpeg atempo)
  .wants_expressive (1352-1362) :: Did the request opt into the expressive Nepali path at all?

backend.voiceforge_presenter.py (1-1237)
  ._install_low_memory_loader (116-151)
  .write_runner (179-203)
  .clamp_steps (205-213) :: Denoising steps
  .clamp_guidance (216-224) :: Guidance scale
  .installed_engines (227-233) :: Engines whose checkpoint is actually on disk, best first
  .pick_engine (236-249) :: Which engine a job runs on
  .engine_command (252-281) :: The call the engine's own inference.sh makes — through runner, when
  .describe_engine_failure (284-300) :: Say why the engine stopped, including when it had no chance to say so
  .extension_of (303-321)
  .EngineProgress (324-396) :: Feed it engine output as it arrives;
  .tail_of (399-402) :: The end of an engine log — where the actual error is
  .parse_sync_report (405-418) :: Read the two numbers out of the engine's sync evaluation
  .engine_gpu_index (421-436) :: Which GPU the engine should see, as a CUDA_VISIBLE_DEVICES value
  ._measure_sync (547-590) :: Score a clip's lip-sync with the engine's own SyncNet evaluation
  .DiskSpaceError (593-594) :: Not enough free disk to start a step
  .free_gb (597-605) :: Free space, in GB, on the disk that holds path (or its nearest existi…
  .ensure_space (608-617) :: Raise DiskSpaceError unless need_gb plus the headroom is free
  .disk_report (620-655)
  ._install_engine (706-775)
  .start_install_in_background (778-788) :: Begin installing the engine, once
  ._keep_awake (796-825) :: Keep this container counted as busy while a clip is being made
  .stream_engine (828-884) :: Run the engine and hand its output to on_output as it arrives
  ._run_presenter (911-1095)
  .health_report (1097-1116)
  .configure (1119-1128) :: Tell this service what it shares a GPU with
  .create_presenter_router (1131-1220) :: Routes, including /health
    .health (1148) :: GET /health
    .start (1152) :: POST /render
    .status (1183) :: GET /render/{job_id}
    .video (1193) :: GET /render/{job_id}/video
    .delete (1211) :: DELETE /render/{job_id}
  .create_presenter_app (1223-1237) :: Standalone app — used by the Modal function

backend.voiceforge_server.py (1-2377)
  .note_work (179-212)
  ._patch_stream_analyzer (215-342) :: Stop the library ending a take the moment two speech tokens match
  ._guard_vocoder (359-393) :: Drop speech tokens the vocoder cannot decode before they reach it
  .load_models (396-421) :: Load Chatterbox Multilingual (23 languages, incl
  .gpu_name (424-430)
  ._stitch (466-535) :: Concatenate chunks with the tuned gaps — same values as the studio
  ._grow_text_vocab (538-586) :: Widen T3's text embedding and output head to the checkpoint's vocabul…
  ._register_ne_tag (589-624) :: Teach this model instance the "[ne]" tag;
  ._load_ne_model (627-733) :: Base multilingual Chatterbox with a Nepali T3 swapped in
  .engine_available (736-775) :: Is this engine usable right now?
  .resolve_engine (778-812) :: plan_engine, with this process's real model availability
  ._generate_chunk (814-939)
  ._clean_reference (942-973) :: The reference clip with background noise removed and the studio finish
  .cache_voice (976-991) :: Download a reference clip (from Blob) and cache it on local disk
  ._gen_clean (1061-1100) :: Generate, then cut anything the model said after the text ended
  ._gen_ne (1103-1198) :: One plain Nepali take, ended where the model finished its text
  ._ne_heard (1201-1234) :: What Whisper hears in a Nepali take, or None when it can't listen
  ._studio (1237-1268) :: A finished Nepali clip with the studio finish, unless the request say…
  ._ne_model_for (1287-1325) :: The Nepali model to voice with:
  ._gen_ne_text (1346-1400) :: One clip for one piece of Nepali text, whatever that takes
  ._render_expressive (1425-1530) :: One audio array per input chunk, plus metadata for the result
  ._place_segments (1533-1558) :: Make segment times absolute in the stitched file (items keep their ow…
  .json_dumps (1573-1576)
  ._run_job (1579-1837) :: Render every chunk sequentially, write the results to disk, then tell
  ._free_installer_caches (1880-1905) :: Notebooks:
  ._load_presenter_module (1908-1943) :: Import the presenter service, fetching its file first if it is absent
  .system_report (1946-1971) :: Free disk and GPU memory, for Admin -> Backends
  .busy_now (1974-1989) :: Anything running right now:
  .idle_seconds (1992-1997) :: Seconds since the last real work;
  .backend_status (2000-2024) :: What a notebook tells the app on every heartbeat, beyond "I am alive"
  .apply_app_features (2027-2047) :: Act on what the app says this backend may do
  .create_app (2076-2377)
    ._count_work (2082) :: MIDDLEWARE http
    .health (2210) :: GET /health
    .put_voice (2224) :: PUT /voices/{voice_id}
    .generate (2241) :: POST /generate
    .create_job (2314) :: POST /jobs
    .job_status (2325) :: GET /jobs/{job_id}
    .job_audio (2341) :: GET /jobs/{job_id}/audio/{index}
    .job_delete (2363) :: DELETE /jobs/{job_id}

backend.wan.__init__.py (1-12)

backend.wan.engine.py (1-165)
  .gpu_name (30-33)
  .peak_vram_gb (36-45) :: The most GPU memory this process has held, so a log shows real numbers
  .load_pipeline (48-89) :: Load (or reuse) the pipeline for this profile
  .generate (92-139) :: Render one clip to out_path (MP4)
  .main (145-165)

backend.wan.install.py (1-244)
  .DiskSpaceError (50-51) :: Not enough free disk to start a step
  .free_gb (54-62) :: Free space, in GB, on the disk that holds path (or its nearest existi…
  .ensure_space (65-75) :: Raise DiskSpaceError unless need_gb plus the headroom is free
  .disk_report (78-83)
  .component_patterns (86-99) :: What the pipeline actually loads:
  .model_dir (102-105) :: Where the weights live:
  .weights_ready (108-109)
  .venv_python (112-113)
  .engine_ready (116-118) :: Notebook:
  .download_weights (128-162) :: Download the model into dest and mark it complete
  ._install (194-236)
  .start_install_in_background (239-244) :: Begin installing once

backend.wan.service.py (1-447)
  .configure (68-74)
  .profile (82-83)
  .is_ready (86-92)
  ._run_subprocess (170-218)
  ._run_clip (221-258)
  ._send_callback (261-295) :: Tell the gateway either way;
  .warm_up_in_background (298-322) :: Modal:
  .health_report (324-345)
  .create_wan_router (348-429) :: Routes, including /health
    .health (360) :: GET /health
    .start (364) :: POST /render
    .status (397) :: GET /render/{job_id}
    .video (406) :: GET /render/{job_id}/video
    .delete (420) :: DELETE /render/{job_id}
  .create_wan_app (432-447) :: Standalone app:

backend.wan.settings.py (1-199)
  .SettingsError (101-102) :: A request the caller must fix
  .profile_for (105-113) :: Modal gets the full model;
  .limits (116-126) :: What /health advertises, so the gateway and UI never offer the imposs…
  .build_settings (139-199) :: Validate a request and resolve every default

modal.copy_nepali_model.py (1-104)
  .copy_model (53-95)
  .main (99-104)

modal.train_nepali.py (1-434)
  .train (80-398)
  .main (402-434)

modal.voiceforge_modal.py (1-253)
  ._bake_weights (22-88) :: Download the Chatterbox weights at IMAGE BUILD time
  .api (90-124)
  .render (126-133) :: Long-form video assembly
  .health (138-167) :: A CPU-only health endpoint
    ._health (150) :: GET /health
  ._bake_presenter_weights (170-242) :: Fetch every weight the engine touches at IMAGE BUILD time
  .presenter (244-253) :: Lip-synced presenter clips

modal.voiceforge_wan.py (1-144)
  .download (73-108) :: One-time weights download into the wan-models volume
  .wan (110-117) :: The video service
  .health (122-144) :: /health on a CPU, so status checks never wake (and bill) the L40S
    ._health (137) :: GET /health
