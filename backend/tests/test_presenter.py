"""
The presenter backend's decisions, without a GPU.

The engine itself only runs on a real card, so what is pinned here is
everything around it: the parameters stay inside the range the engine
documents, the command is the one its own script makes, and the HTTP surface
refuses what it should.
"""

import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))

from backend import voiceforge_presenter as vp  # noqa: E402


class TestParameters:
    def test_steps_stay_in_the_documented_range(self):
        assert vp.clamp_steps(20) == 20
        assert vp.clamp_steps(500) == 50
        assert vp.clamp_steps(1) == 10

    def test_steps_fall_back_when_missing_or_nonsense(self):
        assert vp.clamp_steps(None) == 20
        assert vp.clamp_steps("fast") == 20

    def test_guidance_stays_in_the_documented_range(self):
        assert vp.clamp_guidance(1.5) == 1.5
        assert vp.clamp_guidance(9) == 3.0
        assert vp.clamp_guidance(0) == 1.0
        assert vp.clamp_guidance(None) == 1.5


class TestCommand:
    def test_it_is_the_engines_own_invocation(self):
        cmd = vp.engine_command("latentsync-1.6", "in.mp4", "in.wav", "out.mp4", 20, 1.5, 7, "tmp", python="py")
        assert cmd[:3] == ["py", "-m", "scripts.inference"]
        assert "--enable_deepcache" in cmd
        assert cmd[cmd.index("--video_path") + 1] == "in.mp4"
        assert cmd[cmd.index("--audio_path") + 1] == "in.wav"
        assert cmd[cmd.index("--video_out_path") + 1] == "out.mp4"
        assert cmd[cmd.index("--inference_steps") + 1] == "20"
        assert cmd[cmd.index("--seed") + 1] == "7"

    def test_config_and_checkpoint_travel_together(self):
        # A 512 px config with a 256 px checkpoint (or the reverse) loads and
        # produces garbage, so each engine names both.
        big = vp.engine_command("latentsync-1.6", "a", "b", "c", 20, 1.5, 1, "t")
        small = vp.engine_command("latentsync-1.5", "a", "b", "c", 20, 1.5, 1, "t")
        assert big[big.index("--unet_config_path") + 1].endswith("stage2_512.yaml")
        assert big[big.index("--inference_ckpt_path") + 1] == "checkpoints/latentsync_unet.pt"
        assert small[small.index("--unet_config_path") + 1].endswith("stage2.yaml")
        assert small[small.index("--inference_ckpt_path") + 1] == "checkpoints/v15/latentsync_unet.pt"


class TestEngineChoice:
    def test_only_engines_whose_weights_exist_are_offered(self, tmp_path):
        assert vp.installed_engines(str(tmp_path)) == []
        (tmp_path / "checkpoints" / "v15").mkdir(parents=True)
        (tmp_path / "checkpoints" / "v15" / "latentsync_unet.pt").write_bytes(b"x")
        assert vp.installed_engines(str(tmp_path)) == ["latentsync-1.5"]
        (tmp_path / "checkpoints" / "latentsync_unet.pt").write_bytes(b"x")
        assert vp.installed_engines(str(tmp_path)) == ["latentsync-1.6", "latentsync-1.5"]

    def test_the_request_wins_when_that_engine_is_installed(self):
        both = ["latentsync-1.6", "latentsync-1.5"]
        assert vp.pick_engine("latentsync-1.5", both) == "latentsync-1.5"

    def test_the_best_installed_engine_is_the_default(self):
        assert vp.pick_engine(None, ["latentsync-1.6", "latentsync-1.5"]) == "latentsync-1.6"

    def test_asking_for_an_engine_that_is_not_here_still_makes_a_clip(self):
        # A notebook only has the small one. The caller wanted a clip.
        assert vp.pick_engine("latentsync-1.6", ["latentsync-1.5"]) == "latentsync-1.5"

    def test_nothing_installed_means_no_engine(self):
        assert vp.pick_engine(None, []) is None


class TestGpuChoice:
    def test_a_second_gpu_goes_to_the_engine(self):
        # Kaggle's "T4 x2": the voice server uses the first card only.
        assert vp.engine_gpu_index(2) == "1"

    def test_a_single_gpu_is_shared(self):
        assert vp.engine_gpu_index(1) is None
        assert vp.engine_gpu_index(0) is None

    def test_an_explicit_choice_wins(self):
        assert vp.engine_gpu_index(2, "0") == "0"


class TestSmallHelpers:
    def test_extension_comes_from_the_url_when_it_is_sane(self):
        assert vp.extension_of("https://x.test/a/clip.MOV?sig=1", ".mp4") == ".mov"
        assert vp.extension_of("https://x.test/a/clip", ".mp4") == ".mp4"

    def test_error_tail_keeps_the_end(self):
        log = "x" * 2000 + "RuntimeError: no face detected"
        assert vp.tail_of(log, 60).endswith("no face detected")
        assert len(vp.tail_of(log, 60)) == 60


@pytest.fixture()
def client(monkeypatch):
    from fastapi.testclient import TestClient

    monkeypatch.setenv("BACKEND_SECRET", "s3cret")
    # Never start a real job from a test.
    monkeypatch.setattr(vp, "_run_presenter", lambda req: None)
    # Routes that accept work behave as on a backend with an engine installed;
    # the test of "no engine" turns this back off itself.
    monkeypatch.setattr(vp, "installed_engines", lambda *_a, **_k: ["latentsync-1.5"])
    vp.RENDERS.clear()
    return TestClient(vp.create_presenter_app(provider="test"))


class TestRoutes:
    def test_health_does_not_claim_an_engine_that_is_not_installed(self, client, monkeypatch):
        monkeypatch.setattr(vp, "installed_engines", lambda *_a, **_k: [])
        body = client.get("/health").json()
        assert body["ok"] is True
        assert body["capabilities"] == []
        assert body["engines"] == []

    def test_health_offers_the_capability_once_an_engine_is_there(self, client):
        body = client.get("/health").json()
        assert body["capabilities"] == ["presenter-relip"]
        assert body["engine"] == "latentsync-1.5"

    def test_work_is_refused_while_the_engine_is_still_installing(self, client, monkeypatch):
        # 503, so the gateway hands the clip to the next backend in line.
        monkeypatch.setattr(vp, "installed_engines", lambda *_a, **_k: [])
        res = client.post(
            "/render",
            headers={"X-Backend-Secret": "s3cret"},
            json={"video_url": "https://a/b.mp4", "audio_url": "https://a/b.wav"},
        )
        assert res.status_code == 503

    def test_starting_a_job_needs_the_secret(self, client):
        res = client.post("/render", json={"video_url": "https://a/b.mp4", "audio_url": "https://a/b.wav"})
        assert res.status_code == 401

    def test_only_https_inputs_are_accepted(self, client):
        res = client.post(
            "/render",
            headers={"X-Backend-Secret": "s3cret"},
            json={"video_url": "file:///etc/passwd", "audio_url": "https://a/b.wav"},
        )
        assert res.status_code == 400

    def test_a_valid_job_is_accepted_and_visible(self, client):
        res = client.post(
            "/render",
            headers={"X-Backend-Secret": "s3cret"},
            json={"job_id": "j1", "video_url": "https://a/b.mp4", "audio_url": "https://a/b.wav",
                  "callback_token": "tok"},
        )
        assert res.status_code == 202
        status = client.get("/render/j1", headers={"X-Backend-Secret": "s3cret"}).json()
        assert status["status"] == "queued"
        # The download token never appears in a status response.
        assert "token" not in status

    def test_an_unfinished_job_has_no_video(self, client):
        client.post(
            "/render",
            headers={"X-Backend-Secret": "s3cret"},
            json={"job_id": "j2", "video_url": "https://a/b.mp4", "audio_url": "https://a/b.wav",
                  "callback_token": "tok"},
        )
        assert client.get("/render/j2/video?token=tok").status_code == 404
        assert client.get("/render/j2/video?token=wrong").status_code == 401


class TestSyncReport:
    def test_reads_both_numbers(self):
        text = "Input video: x.mp4\nSyncNet confidence: 7.93\nAV offset: -1\n"
        assert vp.parse_sync_report(text) == {"confidence": 7.93, "offset_frames": -1}

    def test_is_none_when_the_evaluation_printed_nothing_useful(self):
        assert vp.parse_sync_report("Face not detected in x.mp4") is None
        assert vp.parse_sync_report("") is None


class TestMountedInANotebook:
    def test_it_works_under_a_prefix_beside_the_voice_server(self, monkeypatch):
        """The voice server already owns /render and /health, so in a notebook
        this service lives under /presenter and must not collide with them."""
        from fastapi import FastAPI
        from fastapi.testclient import TestClient

        monkeypatch.setattr(vp, "_run_presenter", lambda req: None)
        monkeypatch.setattr(vp, "installed_engines", lambda *_a, **_k: ["latentsync-1.5"])
        vp.RENDERS.clear()

        app = FastAPI()

        @app.get("/health")
        def voice_health():
            return {"who": "voice"}

        app.include_router(
            vp.create_presenter_router(lambda _s: None, provider="kaggle"), prefix="/presenter"
        )
        client = TestClient(app)

        assert client.get("/health").json() == {"who": "voice"}
        assert client.get("/presenter/health").json()["capabilities"] == ["presenter-relip"]
        res = client.post(
            "/presenter/render",
            json={"job_id": "n1", "video_url": "https://a/b.mp4", "audio_url": "https://a/b.wav"},
        )
        assert res.status_code == 202
        assert client.get("/presenter/render/n1").json()["status"] == "queued"
