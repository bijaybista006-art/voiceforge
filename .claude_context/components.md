# Components index — React (components/**)

updated: 2026-11-02 | commit: 12be38a

Client components. `components/views/*` are the studio pages (Speech,
Presenter, AI Video, Home, Library); `components/admin/*` are the admin
pages; `components/ui/*` and `components/layout/*` are the shared design
system (see notes.md "UI v2"); `components/studio/*` is the studio shell/
context. State lives in `lib/store.ts` (Zustand), not here.

## Index

components.ChunkList.tsx (1-151)
  .ChunkList (15-151)

components.ChunkRow.tsx (1-158)
  .ChunkRow (17-158)

components.ExportBar.tsx (1-167)
  .ExportBar (37-167)

components.ModelControls.tsx (1-272)
  .AbCompareDialog (24-107)
  .ModelControls (109-272)

components.ScriptEditor.tsx (1-148)
  .ScriptEditor (19-148)

components.VoiceCard.tsx (1-104)
  .VoiceCard (14-104) :: One row in the voice picker

components.VoiceLab.tsx (1-321)
  .VoiceLab (32-321)

components.Waveform.tsx (1-196)
  .Waveform (22-196) :: Canvas waveform with draggable (and keyboard-adjustable) trim handles

components.admin.AdminShell.tsx (1-112)
  .SECTIONS (25-58) :: The admin frame:
  .AdminShell (60-90)
  .AdminPage (93-112) :: The standard admin page frame:

components.admin.ApiDocs.tsx (1-402)
  .Snippet (13-35) :: Copy-ready API documentation, rendered with the reader's own app URL …
  .Section (37-55)
  .Endpoint (57-68)
  .ApiDocs (70-402)

components.admin.BackendsManager.tsx (1-1040)
  .FEATURE_SWITCHES (76-92) :: The per-backend feature switches (absent = on)
  .BackendsManager (111-416)
  .ServingNow (418-482) :: --- serving now -----------------------------------------------------…
  .RoutingExplainer (484-536) :: --- routing ---------------------------------------------------------…
  .BackendCard (538-763) :: --- one backend -----------------------------------------------------…
  .Step (765-774) :: --- setup (not connected) -------------------------------------------…
  .SetupCard (780-860)
  .NotebookStepsList (862-931)
  .NotebookSteps (933-948)
  .LegacyPreferences (950-1040) :: --- legacy preferences ----------------------------------------------…

components.admin.JobsList.tsx (1-422)
  .JobsList (91-284)
  .JobCard (286-422)

components.admin.KeysManager.tsx (1-289)
  .KeysManager (45-289)

components.admin.PresentersManager.tsx (1-512)
  .KIND_HELP (38-55)
  .PresentersManager (69-232)
  .ReadinessCard (240-278) :: Says, per kind, whether anything connected can actually render it
  .UploadCard (280-512)

components.admin.SettingsForm.tsx (1-330)
  .Field (13-31)
  .SettingsForm (33-330)

components.admin.TrainingManager.tsx (1-990)
  .to24k (74-86) :: Resample with the browser's own resampler
  .TrainingManager (95-225)
  .SpeakerBar (231-314) :: Whose clips these are
  .Progress (316-361) :: --- progress --------------------------------------------------------…
  .AddClipCard (363-727) :: --- add -------------------------------------------------------------…
  .ReferenceCard (738-845) :: Turn the best clips into the reference a cloned voice is made from
  .ClipList (847-990) :: --- list ------------------------------------------------------------…

components.admin.VoicesManager.tsx (1-859)
  .VoicesManager (35-191)
  .AddVoiceCard (213-642)
  .VoiceRow (652-859)

components.layout.AppShell.tsx (1-246)
  .Brand (43-61)
  .NavList (63-102)
  .AppShell (104-232)
  .SectionSwitch (235-246) :: A header button that moves between the two sections ("Go to Admin" / …

components.studio.GpuOfflineNotice.tsx (1-49)
  .GpuOfflineNotice (13-49) :: Shown on a studio page when no GPU is online

components.studio.GpuStatus.tsx (1-55)
  .gpuState (8-12) :: Pure:
  .COPY (14-33)
  .GpuStatus (36-55) :: The studio's whole view of the GPU:

components.studio.StudioContext.tsx (1-21)
  .useIsAdmin (19-21)

components.studio.StudioShell.tsx (1-116)
  .StudioShell (20-116) :: The studio frame:

components.ui.Badge.tsx (1-46)
  .Badge (19-46) :: Status chip

components.ui.Button.tsx (1-46)
  .VARIANTS (8-21)
  .Button (34-46)

components.ui.Card.tsx (1-114)
  .Card (13-37)
  .CardHeader (39-74)
  .FieldLabel (77-83) :: Small uppercase label that opens a group of controls inside a card
  .EmptyState (85-114)

components.ui.ConfirmHost.tsx (1-40)
  .ConfirmHost (9-40) :: Renders the pending confirmAction() request

components.ui.CopyId.tsx (1-51)
  .CopyId (13-51) :: An id you are meant to paste somewhere else — a workflow, an API call

components.ui.Dialog.tsx (1-73)
  .Dialog (15-73)

components.ui.Icons.tsx (1-278) :: 36 inline SVG icon components (IconHome, IconWave, …) — no runtime logic
  .base (8-17)

components.ui.Input.tsx (1-25)
  .Input (8-12)
  .Textarea (14-25)

components.ui.Kit.tsx (1-237)
  .STATUS (29-41)
  .StatusBadge (44-58) :: A status pill:
  .Skeleton (60-62) :: --- skeleton --------------------------------------------------------…
  .SkeletonCard (65-76) :: A card-shaped loading placeholder with a few text lines
  .Tooltip (82-105) :: Explains a term on hover or keyboard focus
  .Disclosure (108-149) :: A collapsible section ("Advanced", "Details")
  .CopyButton (151-172) :: --- copy ------------------------------------------------------------…
  .CopyBlock (175-186) :: A copyable code block:
  .PageHeader (188-211) :: --- page header -----------------------------------------------------…
  .Stat (214-237) :: A labelled metric for dashboards

components.ui.ProgressBar.tsx (1-49)
  .ProgressBar (3-49)

components.ui.Select.tsx (1-31)
  .Select (5-31)

components.ui.Slider.tsx (1-58)
  .Slider (17-58)

components.ui.ThemeToggle.tsx (1-80)
  .ThemeToggle (18-80) :: Three-way theme switch (Light / Dark / System), shown in both headers

components.ui.Toast.tsx (1-49)
  .Toaster (20-49)

components.ui.Toggle.tsx (1-73)
  .Toggle (10-73) :: An on/off switch

components.views.ClipView.tsx (1-645)
  .ClipView (43-525) :: AI Video in the studio:
  .clipMinutesLeft (531-534) :: Minutes left, from how far the clip has come and how long that took
  .ClipProgress (536-576)
  .PaidNotice (584-613) :: Before generating:
  .ClipFacts (625-645)

components.views.HomeView.tsx (1-204)
  .AvailabilityPill (30-43)
  .ToolCard (45-96)
  .HomeView (99-204) :: Studio home:

components.views.LibraryView.tsx (1-242)
  .download (53-65) :: Files live on another origin, where a plain download link only opens …
  .LibraryView (72-176)
  .LibraryItem (178-242)

components.views.SpeechView.tsx (1-86)
  .SpeechView (20-86) :: Text to Speech:

components.views.VideoView.tsx (1-617)
  .VideoView (71-441) :: Presenter video in the studio:
  .PresenterChoice (443-501)
  .Progress (503-584)
  .ClipFacts (587-617) :: How the clip turned out, in numbers — including whether it is in sync
