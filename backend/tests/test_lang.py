"""
Engine selection and Nepali text prep.

These run on a plain CI runner — no torch, no GPU, no model — which is the
whole reason voiceforge_lang.py exists as its own file.
"""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))

from backend.voiceforge_lang import (  # noqa: E402
    DEFAULT_ENGINE,
    ne_chunks,
    ne_expand_digits,
    ne_prepare,
    ne_spell_number,
    plan_engine,
    strip_state_prefixes,
)

NEVER = lambda _e: False      # noqa: E731 - nothing loads
ALWAYS = lambda _e: True      # noqa: E731 - everything loads

TUNED = {"exaggeration": 0.4, "cfg": 0.5, "temperature": 0.7}
NE_FALLBACK = {"engine": DEFAULT_ENGINE, "modelLanguage": "hi", "cfg": 0.3, "exaggeration": 0.4}


class TestUnprofiledLanguagesAreUntouched:
    """The negative guarantee: adding Nepali must change nothing else."""

    def test_english_runs_exactly_as_before(self):
        got = plan_engine(None, None, {"language": "en"}, NEVER, TUNED)
        assert got["engine"] == DEFAULT_ENGINE
        assert got["language"] == "en"
        assert got["exaggeration"] == 0.4
        assert got["cfg"] == 0.5
        assert got["temperature"] == 0.7
        assert got["engine_used"] == DEFAULT_ENGINE

    def test_the_stock_engine_is_never_probed(self):
        # Availability is never consulted for the default engine, so a broken
        # Nepali checkpoint cannot stall an English job.
        def explode(_e):
            raise AssertionError("availability must not be checked")

        assert plan_engine(DEFAULT_ENGINE, None, {"language": "en"}, explode, TUNED)["engine"] == DEFAULT_ENGINE

    def test_hindi_keeps_its_own_settings(self):
        got = plan_engine(None, None, {"language": "hi", "cfg": 0.5}, NEVER, TUNED)
        assert got["language"] == "hi"
        assert got["cfg"] == 0.5
        assert got["engine_used"] == DEFAULT_ENGINE

    def test_request_params_still_win(self):
        got = plan_engine(None, None, {"language": "en", "exaggeration": 0.9}, NEVER, TUNED)
        assert got["exaggeration"] == 0.9


class TestNepaliFallback:
    def test_uses_the_nepali_engine_when_it_loads(self):
        got = plan_engine("chatterbox-ne", NE_FALLBACK, {"language": "ne"}, ALWAYS, TUNED)
        assert got["engine"] == "chatterbox-ne"
        assert got["language"] == "ne"
        assert got["engine_used"] == "chatterbox-ne"

    def test_falls_back_to_hindi_when_it_does_not(self):
        got = plan_engine("chatterbox-ne", NE_FALLBACK, {"language": "ne"}, NEVER, TUNED)
        assert got["engine"] == DEFAULT_ENGINE
        assert got["language"] == "hi"
        assert got["cfg"] == 0.3
        assert got["exaggeration"] == 0.4

    def test_the_fallback_is_named_in_the_result(self):
        # The entire point: a substituted model must be visible, not just
        # audible to someone who speaks the language.
        got = plan_engine("chatterbox-ne", NE_FALLBACK, {"language": "ne"}, NEVER, TUNED)
        assert got["engine_used"] == "fallback-hi"

    def test_a_missing_engine_with_no_fallback_still_renders(self):
        got = plan_engine("chatterbox-ne", None, {"language": "ne"}, NEVER, TUNED)
        assert got["engine"] == DEFAULT_ENGINE
        assert got["engine_used"] == DEFAULT_ENGINE

    def test_an_unknown_engine_degrades_rather_than_failing(self):
        got = plan_engine("not-a-real-engine", None, {"language": "en"}, NEVER, TUNED)
        assert got["engine"] == DEFAULT_ENGINE


class TestNepaliNumbers:
    def test_digits_become_spoken_words(self):
        assert ne_spell_number("25") == "दुई पाँच"

    def test_a_decimal_point_is_spoken(self):
        assert "दशमलव" in ne_spell_number("2.5")

    def test_thousands_separators_are_dropped(self):
        assert "," not in ne_expand_digits("1,000")

    def test_devanagari_digits_are_handled_too(self):
        assert ne_expand_digits("२") == "दुई"

    def test_surrounding_text_survives(self):
        out = ne_expand_digits("सन् 2026 मा")
        assert "सन्" in out and "मा" in out
        assert "2026" not in out

    def test_text_with_no_digits_is_unchanged(self):
        assert ne_expand_digits("नमस्ते") == "नमस्ते"


class TestNepaliChunking:
    def test_splits_on_the_danda_not_the_full_stop(self):
        out = ne_chunks("पहिलो वाक्य। दोस्रो वाक्य।")
        assert len(out) == 2

    def test_keeps_the_danda_with_its_sentence(self):
        assert ne_chunks("पहिलो वाक्य।")[0].endswith("।")

    def test_long_sentences_break_at_commas(self):
        long_one = "क" * 100 + ", " + "ख" * 100 + ", " + "ग" * 100
        out = ne_chunks(long_one, max_chars=120)
        assert len(out) > 1
        assert all(len(c) <= 140 for c in out)

    def test_empty_text_gives_nothing_rather_than_a_blank_chunk(self):
        assert ne_chunks("") == []
        assert ne_chunks("   ") == []

    def test_whitespace_is_collapsed(self):
        assert ne_chunks("एक    दुई")[0] == "एक दुई"

    def test_prepare_expands_then_chunks(self):
        out = ne_prepare("सन् 2026 हो। अर्को वाक्य।")
        assert len(out) == 2
        assert "2026" not in " ".join(out)


class TestStripStatePrefixes:
    """A prefix mismatch is the silent failure mode: with strict=False nothing
    loads, nothing complains, and the model quietly keeps its old weights."""

    def test_strips_a_dataparallel_prefix(self):
        assert strip_state_prefixes({"module.a": 1, "module.b": 2}) == {"a": 1, "b": 2}

    def test_strips_a_t3_prefix(self):
        assert strip_state_prefixes({"t3.x": 1}) == {"x": 1}

    def test_leaves_already_clean_keys_alone(self):
        assert strip_state_prefixes({"a": 1, "b": 2}) == {"a": 1, "b": 2}

    def test_only_strips_when_every_key_shares_the_prefix(self):
        # A genuine parameter called "model.something" must not be mangled
        # just because one sibling happens to match.
        mixed = {"module.a": 1, "b": 2}
        assert strip_state_prefixes(mixed) == mixed

    def test_handles_an_empty_state(self):
        assert strip_state_prefixes({}) == {}

    def test_strips_nested_wrappers_in_turn(self):
        assert strip_state_prefixes({"module.t3.w": 1}) == {"w": 1}
