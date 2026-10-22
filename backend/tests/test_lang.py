"""
Engine selection and Nepali text prep.

These run on a plain CI runner — no torch, no GPU, no model — which is the
whole reason voiceforge_lang.py exists as its own file.
"""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))

import pytest  # noqa: E402

from backend.voiceforge_lang import (  # noqa: E402
    EngineUnavailable,
    DEFAULT_ENGINE,
    ne_chunks,
    ne_cut_runaway,
    ne_duration_cap,
    ne_ending_frames,
    ne_merge_short,
    ne_pace,
    ne_split_for_retry,
    ne_trim_trailing_blip,
    ne_trim_leading,
    ne_model_ending,
    ne_take_problem,
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

    def test_fails_when_the_nepali_engine_cannot_run(self):
        # Nepali read by the Hindi model was delivered as a successful job and
        # was not Nepali. There is nothing acceptable to substitute.
        with pytest.raises(EngineUnavailable):
            plan_engine("chatterbox-ne", None, {"language": "ne"}, NEVER, TUNED)

    def test_ignores_a_hindi_fallback_even_if_one_is_sent(self):
        # An older gateway, or a caller, may still send one. It is not used.
        with pytest.raises(EngineUnavailable, match="never replaced"):
            plan_engine("chatterbox-ne", NE_FALLBACK, {"language": "ne"}, NEVER, TUNED)

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

    def test_a_short_sentence_is_not_voiced_alone(self):
        # Four tiny sentences were four chunks, and each came back three to
        # four times too long: the model ran on past the words.
        out = ne_merge_short(["एआई के हो?", "एआई राम्रो छ।", "एआई नयाँ हो।", "एआई सजिलो छ।"])
        assert len(out) == 1
        assert out[0] == "एआई के हो? एआई राम्रो छ। एआई नयाँ हो। एआई सजिलो छ।"

    def test_ordinary_sentences_are_left_alone(self):
        a = "आजको समयमा प्रविधिले हाम्रो दैनिक काम धेरै सजिलो बनाएको छ।"
        b = "यसले हामीलाई नयाँ कुरा सिक्न र समय बचाउन पनि मद्दत गर्छ।"
        assert len(a) >= 40 and len(b) >= 40
        assert ne_merge_short([a, b]) == [a, b]

    def test_a_short_opener_joins_the_sentence_after_it(self):
        long_one = "आजको समयमा प्रविधिले हाम्रो दैनिक काम धेरै सजिलो बनाएको छ।"
        assert ne_merge_short(["नमस्ते।", long_one]) == [f"नमस्ते। {long_one}"]

    def test_merging_never_exceeds_the_models_limit(self):
        long_one = "क" * 198
        assert ne_merge_short([long_one, "छोटो।"]) == [long_one, "छोटो।"]

    def test_prepare_expands_then_chunks(self):
        out = ne_prepare("सन् 2026 हो। अर्को वाक्य।")
        # Two short sentences now travel as one chunk — see ne_merge_short.
        assert len(out) == 1
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


class TestRunawayGuard:
    """A 238-character line once came back as 40 seconds: 13 of speech, then
    babble to the library's limit, on all three takes."""

    def test_the_cap_is_the_requested_formula(self):
        assert ne_duration_cap("क" * 100) == pytest.approx(100 * 0.12 + 3.0)

    def test_real_speech_is_under_the_cap(self):
        # The slowest real take measured: 47 characters in 5.52 s.
        assert 5.52 < ne_duration_cap("क" * 47)
        # A normal long one: 237 characters in 13.88 s.
        assert 13.88 < ne_duration_cap("क" * 237)

    def test_the_runaway_take_is_over_the_cap(self):
        assert 40.0 > ne_duration_cap("क" * 238)

    def test_two_sentences_split_into_two(self):
        text = ("टिक टक लाइभमा गिफ्ट पठाउन कहिल्यै पनि फेसबुक वा ह्वाट्सएपका अपरिचित व्यक्तिलाई "
                "ई सेवा वा खल्तीबाट पैसा नहाल्नुहोस्। क्वाइन किन्न परेमा सधैँ टिक टक एपभित्रको "
                "आधिकारिक ब्यालेन्स सेक्सनबाट मात्र आधिकारिक माध्यम प्रयोग गरेर रिचार्ज गर्नुहोस्।")
        pieces = ne_split_for_retry(text)
        assert len(pieces) == 2
        assert pieces[0].endswith("नहाल्नुहोस्।")
        assert " ".join(pieces) == text

    def test_a_single_sentence_has_nothing_smaller_to_try(self):
        assert ne_split_for_retry("यो एउटै वाक्य हो र यसलाई टुक्र्याउन मिल्दैन।") == []

    def test_a_runaway_take_is_cut_at_the_pause_after_its_words(self):
        import numpy as np

        sr = 24000
        t = lambda s: (0.5 * np.sin(2 * np.pi * 220 * np.arange(int(s * sr)) / sr)).astype(np.float32)
        q = lambda s: np.zeros(int(s * sr), dtype=np.float32)
        # 12 s of speech, a second of nothing, then 27 s of babble.
        take = np.concatenate([t(12.0), q(1.0), t(27.0)])
        cut = ne_cut_runaway(take, sr, "क" * 238)
        assert 11.9 < len(cut) / sr < 12.4

    def test_pauses_inside_the_words_do_not_end_the_take(self):
        import numpy as np

        sr = 24000
        t = lambda s: (0.5 * np.sin(2 * np.pi * 220 * np.arange(int(s * sr)) / sr)).astype(np.float32)
        q = lambda s: np.zeros(int(s * sr), dtype=np.float32)
        # A sentence break of 0.4 s is ordinary and must survive.
        take = np.concatenate([t(6.0), q(0.4), t(6.0), q(1.0), t(20.0)])
        cut = ne_cut_runaway(take, sr, "क" * 238)
        assert 12.3 < len(cut) / sr < 12.8

    def test_with_no_pause_at_all_it_ends_at_the_cap(self):
        import numpy as np

        sr = 24000
        take = (0.5 * np.sin(2 * np.pi * 220 * np.arange(40 * sr) / sr)).astype(np.float32)
        cut = ne_cut_runaway(take, sr, "क" * 100)
        assert len(cut) / sr == pytest.approx(ne_duration_cap("क" * 100), abs=0.1)


class TestPace:
    def test_absent_means_the_models_own_speed(self):
        assert ne_pace({}) == 1.0
        assert ne_pace({"pace": None}) == 1.0

    def test_it_is_read_from_the_request(self):
        assert ne_pace({"pace": 0.9}) == 0.9

    def test_it_is_kept_inside_a_range_that_still_sounds_like_speech(self):
        assert ne_pace({"pace": 0.2}) == 0.75
        assert ne_pace({"pace": 3}) == 1.25

    def test_nonsense_is_ignored(self):
        assert ne_pace({"pace": "slow"}) == 1.0


class TestTrailingBlip:
    @staticmethod
    def _tone(seconds, level=0.5, sr=24000):
        import numpy as np

        return (level * np.sin(2 * np.pi * 220 * np.arange(int(seconds * sr)) / sr)).astype(np.float32)

    @staticmethod
    def _quiet(seconds, sr=24000):
        import numpy as np

        return np.zeros(int(seconds * sr), dtype=np.float32)

    def test_a_soft_sound_after_a_pause_is_dropped(self):
        import numpy as np

        sr = 24000
        clip = np.concatenate([self._tone(2.0), self._quiet(0.2), self._tone(0.12, 0.04), self._quiet(0.04)])
        out = ne_trim_trailing_blip(clip, sr)
        assert 2.0 <= len(out) / sr < 2.12

    def test_a_soft_final_consonant_is_kept(self):
        import numpy as np

        sr = 24000
        # Loud speech running straight into a soft tail, with no gap between.
        clip = np.concatenate([self._tone(2.0), self._tone(0.2, 0.04)])
        out = ne_trim_trailing_blip(clip, sr)
        assert len(out) == len(clip)

    def test_a_brief_closure_inside_the_last_word_is_not_a_gap(self):
        import numpy as np

        sr = 24000
        # 60 ms of closure before a final stop's release is ordinary speech.
        clip = np.concatenate([self._tone(2.0), self._quiet(0.06), self._tone(0.08, 0.05)])
        out = ne_trim_trailing_blip(clip, sr)
        assert len(out) == len(clip)

    def test_plain_trailing_silence_is_left_alone(self):
        import numpy as np

        sr = 24000
        clip = np.concatenate([self._tone(2.0), self._quiet(0.4)])
        assert len(ne_trim_trailing_blip(clip, sr)) == len(clip)

    def test_a_loud_last_word_after_a_pause_is_speech_not_a_blip(self):
        import numpy as np

        sr = 24000
        clip = np.concatenate([self._tone(2.0), self._quiet(0.3), self._tone(0.3, 0.5)])
        assert len(ne_trim_trailing_blip(clip, sr)) == len(clip)

    def test_a_loud_click_after_a_pause_is_not_speech(self):
        import numpy as np

        sr = 24000
        # 40 ms is too short to be a syllable, however loud it is.
        clip = np.concatenate([self._tone(2.0), self._quiet(0.2), self._tone(0.04, 0.5), self._quiet(0.04)])
        out = ne_trim_trailing_blip(clip, sr)
        assert 2.0 <= len(out) / sr < 2.12


class TestTakeProblem:
    _tone = staticmethod(TestTrailingBlip._tone)
    _quiet = staticmethod(TestTrailingBlip._quiet)
    ONE = "मोबाइलमा दुई चरणको प्रमाणीकरण अन गर्नुहोस्."  # 43 characters
    TWO = "नमस्ते साथीहरू, आजको भिडियोमा स्वागत छ। आज हामी अनलाइन सुरक्षाको बारेमा कुरा गर्नेछौं."

    def test_a_whole_take_passes(self):
        import numpy as np

        # 3.4 s for 43 characters, a 0.3 s comma pause: like the speaker.
        clip = np.concatenate([self._tone(1.6), self._quiet(0.3), self._tone(1.5)])
        assert ne_take_problem(clip, 24000, self.ONE) == ""

    def test_a_take_that_lost_its_place_is_caught(self):
        import numpy as np

        # The Colab take: speech, 1.6 s of silence mid-sentence, more speech.
        clip = np.concatenate([self._tone(3.0), self._quiet(1.6), self._tone(2.2)])
        assert "gap" in ne_take_problem(clip, 24000, self.ONE) or "slow" in ne_take_problem(clip, 24000, self.ONE)

    def test_a_take_far_too_slow_for_its_text_is_caught(self):
        assert "slow" in ne_take_problem(self._tone(7.0), 24000, self.ONE)

    def test_a_long_gap_inside_one_sentence_is_caught(self):
        import numpy as np

        clip = np.concatenate([self._tone(1.5), self._quiet(0.9), self._tone(1.5)])
        assert "gap" in ne_take_problem(clip, 24000, self.ONE)

    def test_a_sentence_break_may_pause_longer(self):
        import numpy as np

        clip = np.concatenate([self._tone(3.0), self._quiet(0.7), self._tone(3.2)])
        assert ne_take_problem(clip, 24000, self.TWO) == ""

    def test_short_texts_are_not_judged_on_pace(self):
        assert ne_take_problem(self._tone(3.0), 24000, "नमस्ते।") == ""


class TestModelEnding:
    def test_a_final_danda_becomes_one_full_stop(self):
        assert ne_model_ending("जाँच गर्नुहोस्।") == "जाँच गर्नुहोस्."
        assert ne_model_ending("सक्छ ॥ ") == "सक्छ."

    def test_dandas_inside_the_text_stay(self):
        assert ne_model_ending("स्वागत छ। आज कुरा गर्नेछौं।") == "स्वागत छ। आज कुरा गर्नेछौं."

    def test_other_endings_are_untouched(self):
        assert ne_model_ending("के यो सत्य हो?") == "के यो सत्य हो?"
        assert ne_model_ending("ध्यान दिनुहोस्!") == "ध्यान दिनुहोस्!"
        assert ne_model_ending("बिना चिन्ह") == "बिना चिन्ह"
        assert ne_model_ending("") == ""


class TestLeadingTrim:
    _tone = staticmethod(TestTrailingBlip._tone)
    _quiet = staticmethod(TestTrailingBlip._quiet)

    def test_dead_air_before_the_first_word_is_cut(self):
        import numpy as np

        sr = 24000
        clip = np.concatenate([self._quiet(1.8), self._tone(2.0)])
        out = ne_trim_leading(clip, sr)
        assert 2.0 <= len(out) / sr <= 2.1

    def test_a_blip_then_silence_is_dropped(self):
        import numpy as np

        sr = 24000
        # What the cut-off reference produced: 120 ms of sound, a second of
        # nothing, then the sentence.
        clip = np.concatenate([self._tone(0.12), self._quiet(1.0), self._tone(2.0)])
        out = ne_trim_leading(clip, sr)
        assert 2.0 <= len(out) / sr <= 2.1

    def test_a_short_first_word_before_a_comma_is_kept(self):
        import numpy as np

        sr = 24000
        # "आज, ..." — a short word and an ordinary comma pause.
        clip = np.concatenate([self._tone(0.18), self._quiet(0.35), self._tone(2.0)])
        assert len(ne_trim_leading(clip, sr)) == len(clip)

    def test_a_real_first_word_before_a_long_pause_is_kept(self):
        import numpy as np

        sr = 24000
        clip = np.concatenate([self._tone(0.4), self._quiet(1.0), self._tone(2.0)])
        assert len(ne_trim_leading(clip, sr)) == len(clip)

    def test_a_clip_that_already_starts_on_speech_is_untouched(self):
        import numpy as np

        sr = 24000
        clip = np.concatenate([self._quiet(0.04), self._tone(2.0)])
        assert len(ne_trim_leading(clip, sr)) == len(clip)

    def test_silence_and_empty_input_are_safe(self):
        import numpy as np

        sr = 24000
        assert len(ne_trim_leading(self._quiet(1.0), sr)) == sr
        assert len(ne_trim_leading(np.zeros(0, dtype=np.float32), sr)) == 0


class TestEndingFrames:
    def test_absent_means_the_default(self):
        assert ne_ending_frames({}) == 0
        assert ne_ending_frames({"ending_frames": "soon"}) == 0

    def test_it_is_kept_where_a_word_still_sounds_whole(self):
        assert ne_ending_frames({"ending_frames": 6}) == 6
        assert ne_ending_frames({"ending_frames": 1}) == 3
        assert ne_ending_frames({"ending_frames": 40}) == 12
