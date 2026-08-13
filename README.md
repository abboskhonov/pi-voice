# pi-transcribe

Local speech-to-text dictation for Pi.

## Install

Install directly from GitHub:

```bash
pi install git:github.com/earendil-works/pi-transcribe
```

After the first npm release, it can also be installed with:

```bash
pi install npm:@earendil-works/pi-transcribe
```

## Usage

The extension registers:

- a configurable terminal shortcut (`Ctrl+Alt+T` by default) to start and stop recording;
- `/transcribe` for model, transcription-language, microphone, and shortcut settings.

To develop or run it from a checkout:

```bash
npm install --ignore-scripts
pi -e /absolute/path/to/pi-transcribe
```

On first use, select your preferred languages and a transcription model. Preferred languages only rank models; they do not restrict which model can be selected. Missing models are downloaded from Hugging Face only after confirmation, while recognized models in the standard Hugging Face cache are verified and reused.

Press the shortcut while Pi has focus, speak, then press it again. A live level meter appears above the editor while recording. Press Esc to discard a take. Audio is transcribed locally and inserted at the editor cursor. The shortcut is a Pi terminal binding, not a global OS hotkey.

Microphone capture and model loading start together. The model is disposed after each transcription so idle Pi processes do not retain it in memory. If an explicitly selected microphone is unavailable, recording is blocked until another microphone is selected.

Shortcut changes reload the current Pi process. Other open Pi processes must be reloaded separately.
