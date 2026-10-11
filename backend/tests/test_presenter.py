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
        cmd = vp.engine_command("in.mp4", "in.wav", "out.mp4", 20, 1.5, 7, "tmp")
        assert cmd[:3] == ["python", "-m", "scripts.inference"]
        assert "--enable_deepcache" in cmd
        assert cmd[cmd.index("--video_path") + 1] == "in.mp4"
        assert cmd[cmd.index("--audio_path") + 1] == "in.wav"
        assert cmd[cmd.index("--video_out_path") + 1] == "out.mp4"
        assert cmd[cmd.index("--inference_steps") + 1] == "20"
        assert cmd[cmd.index("--seed") + 1] == "7"

    def test_config_and_checkpoint_travel_together(self):
        cmd = vp.engine_command("a", "b", "c", 20, 1.5, 1, "t")
        assert cmd[cmd.index("--unet_config_path") + 1] == vp.UNET_CONFIG
        assert cmd[cmd.index("--inference_ckpt_path") + 1] == vp.UNET_CKPT


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
    vp.RENDERS.clear()
    return TestClient(vp.create_presenter_app(provider="test"))


class TestRoutes:
    def test_health_does_not_claim_an_engine_that_is_not_installed(self, client):
        body = client.get("/health").json()
        assert body["ok"] is True
        # No LatentSync checkout on a test machine: no capability offered.
        assert body["capabilities"] == []

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
