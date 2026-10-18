"""Copies a small subset of the TORGO recordings from local Hugging Face parquet shards to a git-ignored folder.

TORGO (Rudzicz, Namasivayam and Wolff, 2012) is free for academic and non-profit use and asks for citation. The audio
stays on this machine: the output folder is data/torgo, which .gitignore excludes. Only aggregate numbers are reported.

Usage: python -I scripts/extract_torgo_subset.py <folder with train-*.parquet> <output folder> [per-speaker count]
"""

import json
import re
import sys
from pathlib import Path

import pyarrow.parquet as pq

NAME = re.compile(r"^(?P<speaker>[FM]\d+)_(?P<session>\d+)_(?P<mic>[A-Za-z]+)_(?P<utt>\d+)\.wav$")
TEXT = re.compile(r"^[A-Za-z' ,.!?-]+$")


def main() -> None:
    source = Path(sys.argv[1])
    target = Path(sys.argv[2])
    per_speaker = int(sys.argv[3]) if len(sys.argv) > 3 else 80
    shards = sorted(source.glob("train-*.parquet"))
    if not shards:
        raise SystemExit(f"no train-*.parquet in {source}")

    # First pass: the names and texts only, to choose which recordings to keep.
    candidates: dict[str, list[tuple[int, int, str, str]]] = {}
    for shard in shards:
        table = pq.read_table(shard, columns=["audio", "transcription", "speech_status"])
        paths = table.column("audio").combine_chunks().field("path").to_pylist()
        for path, text, status in zip(paths, table.column("transcription").to_pylist(), table.column("speech_status").to_pylist()):
            match = NAME.match(path)
            if not match or status != "dysarthria" or match["mic"] != "headMic":
                continue
            text = " ".join(text.split())
            if not text or not TEXT.match(text) or "xxx" in text.lower():
                continue
            candidates.setdefault(match["speaker"], []).append((int(match["session"]), int(match["utt"]), path, text))

    chosen: dict[str, str] = {}
    manifest: list[dict] = []
    for speaker, items in sorted(candidates.items()):
        items.sort()
        step = max(1, len(items) // per_speaker)
        for session, utt, path, text in items[::step][:per_speaker]:
            chosen[path] = text
            manifest.append({"speaker": speaker, "file": f"{speaker}/{path}", "prompt": text, "order": len(manifest)})
        print(f"{speaker}: {len(items)} usable, kept {len([m for m in manifest if m['speaker'] == speaker])}")

    # Second pass: write the audio of the chosen recordings.
    written = 0
    for shard in shards:
        audio = pq.read_table(shard, columns=["audio"]).column("audio").combine_chunks()
        paths = audio.field("path").to_pylist()
        blobs = audio.field("bytes")
        for i, path in enumerate(paths):
            if path not in chosen:
                continue
            out = target / path.split("_")[0] / path
            out.parent.mkdir(parents=True, exist_ok=True)
            out.write_bytes(blobs[i].as_py())
            written += 1

    (target / "manifest.json").write_text(json.dumps(manifest, indent=1), encoding="utf8")
    print(f"wrote {written} recordings and manifest.json to {target}")
    if written != len(chosen):
        raise SystemExit(f"expected {len(chosen)} recordings, wrote {written}")


main()
