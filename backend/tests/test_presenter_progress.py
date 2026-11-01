"""
Presenter progress while the lip-sync engine runs.

The engine used to run silently until it exited, so a clip sat at 15% for
half an hour. Now its own progress bars are read as they arrive and turned
into one number between 15 and 94 that only goes up.
"""

import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, ROOT)

from backend import voiceforge_presenter as vp  # noqa: E402


def bar(desc, n, total):
    pct = int(100 * n / total)
    head = f"{desc}: " if desc else ""
    return f"\r{head}{pct:3d}%|{'█' * (pct // 10):<10}| {n}/{total} [00:10<00:20,  1.00it/s]"


def run_like_latentsync(meter, frames=300, segments=19, steps=20):
    seen = [meter.percent]
    meter.feed(f"Affine transforming {frames} faces...\n")
    for i in range(0, frames + 1, 50):
        seen.append(meter.feed(bar("", i, frames)))
    meter.feed("\n")
    for seg in range(segments):
        seen.append(meter.feed(bar("Doing inference...", seg, segments)))
        for st in range(0, steps + 1, 5):
            seen.append(meter.feed(bar(f"Sample frames: 16", st, steps)))
    seen.append(meter.feed(bar("Doing inference...", segments, segments) + "\n"))
    meter.feed(f"Restoring {frames} faces...\n")
    for i in range(0, frames + 1, 100):
        seen.append(meter.feed(bar("", i, frames)))
    seen.append(meter.feed("\n"))
    return seen


class TestEngineProgress:
    def test_starts_at_15_and_ends_below_94(self):
        m = vp.EngineProgress()
        assert m.percent == 15
        seen = run_like_latentsync(m)
        assert seen[-1] == 93
        assert max(seen) < vp.ENGINE_PROGRESS_END

    def test_never_goes_down(self):
        seen = run_like_latentsync(vp.EngineProgress())
        assert seen == sorted(seen)

    def test_moves_steadily_through_inference(self):
        m = vp.EngineProgress()
        m.feed("Affine transforming 300 faces...\n" + bar("", 300, 300) + "\n")
        after_faces = m.percent
        assert 23 <= after_faces <= 25
        m.feed(bar("Doing inference...", 9, 19) + "\r" + bar("Sample frames: 16", 10, 20) + "\r")
        # Nine and a half of nineteen segments: about half of the inference share.
        assert 54 <= m.percent <= 58
        assert m.describe() == "redrawing the mouth, part 10 of 19"

    def test_a_bar_split_across_reads_still_counts(self):
        m = vp.EngineProgress()
        m.feed("Affine transforming 300 faces...\n")
        text = bar("", 150, 300) + "\r"
        m.feed(text[:12])
        assert m.percent == 15
        m.feed(text[12:])
        assert m.percent > 15

    def test_ignores_bars_it_does_not_know(self):
        m = vp.EngineProgress()
        m.feed(bar("Downloading model", 5, 10) + "\n")
        assert m.percent == 15
        assert m.describe() == "starting the engine"


class TestStreamEngine:
    def test_output_arrives_while_running_and_is_kept(self, tmp_path):
        got = []
        script = "import sys,time\nfor i in range(3):\n    sys.stderr.write(f'\\rstep {i}'); sys.stderr.flush(); time.sleep(0.05)\nprint('done')\n"
        proc = vp.stream_engine([sys.executable, "-c", script], str(tmp_path), dict(os.environ), got.append)
        assert proc.returncode == 0
        assert "step 2" in "".join(got) and "done" in "".join(got)
        assert "done" in proc.stdout and proc.stderr == proc.stdout

    def test_failure_keeps_the_end_of_the_output(self, tmp_path):
        script = "import sys\nprint('x' * 50)\nsys.stderr.write('Traceback: CUDA out of memory\\n')\nsys.exit(3)\n"
        proc = vp.stream_engine([sys.executable, "-c", script], str(tmp_path), dict(os.environ))
        assert proc.returncode == 3
        assert "CUDA out of memory" in vp.describe_engine_failure(proc.returncode, proc.stderr, proc.stdout)

    def test_a_stuck_engine_is_stopped(self, tmp_path):
        import pytest

        with pytest.raises(RuntimeError) as e:
            vp.stream_engine([sys.executable, "-c", "import time; print('hi', flush=True); time.sleep(30)"],
                             str(tmp_path), dict(os.environ), timeout=1)
        assert "was stopped" in str(e.value)
        assert "hi" in str(e.value)

    def test_a_broken_listener_never_stops_the_engine(self, tmp_path):
        def boom(_text):
            raise ValueError("listener bug")

        proc = vp.stream_engine([sys.executable, "-c", "print('ok')"], str(tmp_path), dict(os.environ), boom)
        assert proc.returncode == 0 and "ok" in proc.stdout


def test_defaults_are_the_engine_examples():
    assert vp.clamp_steps(None) == 20
    assert vp.clamp_guidance(None) == 1.5
