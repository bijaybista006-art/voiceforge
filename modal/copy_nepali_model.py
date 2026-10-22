"""
Copy the Nepali T3 checkpoint into the user's own Hugging Face repo.

VoiceForge's Nepali voice runs on a fine-tune published by someone else
(Firoj112/chatterbox-nepali-runs, MIT). Every GPU downloads it at startup, so
the system breaks if that repo changes, and nothing learned ever stays in the
model. This makes version 1 of the user's own model: the same file, unchanged,
in a private repo they control. Later training runs push new versions there.

Runs on CPU (no GPU billed): it is a 2.1 GB download and upload, nothing more.
Started from GitHub → Actions → "Copy Nepali model", or by hand:
    modal run modal/copy_nepali_model.py --dst-repo <user>/voiceforge-nepali

Needs HF_TOKEN (a write token for the destination) in the Modal secret
`voiceforge-backend`.
"""

import modal

image = modal.Image.debian_slim(python_version="3.11").pip_install("huggingface_hub>=0.24")
app = modal.App("voiceforge-copy-nepali-model")

README = """---
license: mit
language:
  - ne
tags:
  - text-to-speech
  - chatterbox
private: true
---

# VoiceForge Nepali

The Nepali text-to-speech model used by VoiceForge. Version 1 is an unchanged
copy of `{src_file}` from [{src_repo}](https://huggingface.co/{src_repo})
(MIT licence), a fine-tune of the T3 stage of Resemble AI's Chatterbox
Multilingual. Later versions are trained on the owner's own recordings.

Load it the same way: base `ChatterboxMultilingualTTS`, with this file loaded
into `model.t3`, and `language_id="ne"`.

## Licence of the original work

MIT License — Copyright (c) Firoj112. Permission is hereby granted, free of
charge, to any person obtaining a copy of this software and associated
documentation files, to deal in the Software without restriction, subject to
including this notice in all copies or substantial portions of the Software.
"""


@app.function(image=image, secrets=[modal.Secret.from_name("voiceforge-backend")], timeout=3600)
def copy_model(src_repo: str, src_file: str, dst_repo: str) -> str:
    import hashlib
    import os

    from huggingface_hub import HfApi, hf_hub_download

    token = os.environ.get("HF_TOKEN")
    if not token:
        raise RuntimeError("HF_TOKEN is missing from the Modal secret voiceforge-backend")
    api = HfApi(token=token)
    # Fails early and clearly if the token cannot write there.
    api.create_repo(dst_repo, repo_type="model", private=True, exist_ok=True)

    print(f"downloading {src_repo}/{src_file} …", flush=True)
    path = hf_hub_download(repo_id=src_repo, filename=src_file)
    size = os.path.getsize(path)
    sha = hashlib.sha256()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(1 << 24), b""):
            sha.update(block)
    print(f"  {size / 1e9:.2f} GB, sha256 {sha.hexdigest()}", flush=True)

    print(f"uploading to {dst_repo} …", flush=True)
    api.upload_file(
        path_or_fileobj=path,
        path_in_repo=src_file,
        repo_id=dst_repo,
        commit_message=f"v1: unchanged copy of {src_repo}/{src_file} (sha256 {sha.hexdigest()[:12]})",
    )
    api.upload_file(
        path_or_fileobj=README.format(src_repo=src_repo, src_file=src_file).encode(),
        path_in_repo="README.md",
        repo_id=dst_repo,
        commit_message="README: origin and licence",
    )

    # Read it back from the destination, so "done" means it is really there.
    info = api.get_paths_info(dst_repo, [src_file])[0]
    stored = getattr(getattr(info, "lfs", None), "sha256", None)
    if stored and stored != sha.hexdigest():
        raise RuntimeError(f"checksum mismatch after upload: {stored} != {sha.hexdigest()}")
    print(f"done: https://huggingface.co/{dst_repo} ({info.size / 1e9:.2f} GB, checksum matches)", flush=True)
    return dst_repo


@app.local_entrypoint()
def main(
    dst_repo: str,
    src_repo: str = "Firoj112/chatterbox-nepali-runs",
    src_file: str = "t3_mtl_nepali_final.safetensors",
):
    copy_model.remote(src_repo, src_file, dst_repo)
