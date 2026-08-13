# pi-transcribe

Local speech-to-text dictation for Pi.

## Install

Install directly from GitHub:

```bash
pi install ssh://git@github.com/earendil-works/pi-transcribe
```

After the first npm release, it can also be installed with:

```bash
pi install npm:@earendil-works/pi-transcribe
```

## Usage

The extension registers:

- a configurable terminal shortcut (`Ctrl+Alt+Z` by default) to start and stop recording;
- `/transcribe` for model, transcription-language, microphone, and shortcut settings.

To develop or run it from a checkout:

```bash
npm install --ignore-scripts
pi -e /absolute/path/to/pi-transcribe
```

Press the shortcut while Pi has focus, speak, then press it again. A live level meter appears above the editor while recording. `Esc` cancels. Audio is transcribed locally and inserted at the editor cursor. The shortcut is a Pi terminal binding, not a global OS hotkey.
