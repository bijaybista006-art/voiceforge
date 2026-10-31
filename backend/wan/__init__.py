"""
Wan 2.2 TI2V-5B text-to-video for VoiceForge.

    settings.py  limits, defaults, profiles, pins, request validation (pure, tested)
    engine.py    the only torch code: load the pipeline, render a clip
    install.py   getting libraries + weights onto a host (notebook venv, Modal volume)
    service.py   FastAPI routes: /render job protocol + /health

Shared by every host: modal/voiceforge_wan.py (Modal) and the voice server's
/wan mount (Colab, Kaggle). Imports nothing from the voice server, and the
voice server only imports it when video is switched on.
"""
