"""Local inference only. stdout carries the resulting speaker turns as JSON."""
import json
import os
from pathlib import Path
import sys
import wave

import numpy as np


def local_turns(folder, samples):
    import sherpa_onnx as so
    threads = min(4, os.cpu_count() or 1)
    config = so.OfflineSpeakerDiarizationConfig(
        segmentation=so.OfflineSpeakerSegmentationModelConfig(
            pyannote=so.OfflineSpeakerSegmentationPyannoteModelConfig(model=str(folder / "segmentation.onnx")),
            num_threads=threads,
        ),
        embedding=so.SpeakerEmbeddingExtractorConfig(model=str(folder / "embedding.onnx"), num_threads=threads),
        clustering=so.FastClusteringConfig(num_clusters=-1, threshold=0.5),
        min_duration_on=0.2,
        min_duration_off=0.5,
    )
    engine = so.OfflineSpeakerDiarization(config)
    return [(s.start, s.end, s.speaker) for s in engine.process(samples).sort_by_start_time()]


def community_turns(folder, samples):
    import torch
    from pyannote.audio import Pipeline
    pipeline = Pipeline.from_pretrained(str(folder))
    if torch.cuda.is_available():
        pipeline.to(torch.device("cuda"))
    output = pipeline({"waveform": torch.from_numpy(samples).unsqueeze(0), "sample_rate": 16000})
    return [(turn.start, turn.end, speaker)
            for turn, speaker in output.exclusive_speaker_diarization]


def main():
    model, folder, audio = sys.argv[1:]
    with wave.open(audio, "rb") as source:
        if (source.getnchannels(), source.getsampwidth(), source.getframerate()) != (1, 2, 16000):
            raise ValueError("Expected mono 16 kHz PCM")
        samples = np.frombuffer(source.readframes(source.getnframes()), dtype="<i2").astype(np.float32) / 32768
    turns = (local_turns if model == "local" else community_turns)(Path(folder), samples)
    speakers = {}
    result = []
    for start, end, label in sorted(turns, key=lambda t: t[0]):
        if end > start >= 0:
            result.append([start, end, speakers.setdefault(label, len(speakers) + 1)])
    print(json.dumps(result, allow_nan=False))


if __name__ == "__main__":
    main()
