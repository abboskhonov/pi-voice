# pi-voice

Local speech-to-text dictation for Pi.

## Install

Install directly from GitHub:

```bash
pi install https://github.com/abboskhonov/pi-voice
```

This fork is currently installed directly from GitHub; an npm package is not published yet.

## Usage

The extension registers:

- a configurable terminal shortcut (`Ctrl+Alt+Z` by default) to start and stop recording;
- a `transcribe_file` tool that the agent can use to transcribe local audio or video files;
- `/voice` for preferred languages, model, transcription language, microphone, and shortcut settings.

To develop or run it from a checkout:

```bash
npm install --ignore-scripts
pi -e /absolute/path/to/pi-voice
```

While iterating on setup, enable the debug-only onboarding command when starting Pi:

```bash
PI_VOICE_DEBUG=1 pi -e /absolute/path/to/pi-voice
```

Then run `/voice-onboarding` to replay the complete onboarding flow. The command is not registered unless `PI_VOICE_DEBUG=1`. Canceling before selecting a model leaves the current configuration unchanged; model selections are applied immediately.

Press the shortcut while Pi has focus, speak, then press it again. A live level meter appears above the editor while recording. `Esc` cancels. Audio is transcribed locally and inserted at the editor cursor. Streaming-capable models process roughly 500 ms audio chunks while recording; other models use the complete recording after it stops. The shortcut is a Pi terminal binding, not a global OS hotkey.

## File transcription and FFmpeg

The agent can call `transcribe_file` for local audio or video files. Transcription jobs share one loaded model; queued files reuse it, while microphone dictation runs before waiting file jobs after any active job finishes. To bound memory use, at most two file operations are admitted at once, only one FFmpeg decoder runs at a time, and decoded audio is limited to 128 MiB (about 35 minutes). File decoding requires the `ffmpeg` executable; microphone dictation does not. Install FFmpeg with your system package manager:

```bash
# macOS with Homebrew
brew install ffmpeg

# Debian or Ubuntu
sudo apt install ffmpeg

# Windows with winget
winget install Gyan.FFmpeg
```

If FFmpeg is installed outside `PATH`, point pi-voice at it before starting Pi:

```bash
export PI_VOICE_FFMPEG_PATH=/path/to/ffmpeg
```

When FFmpeg is unavailable, `transcribe_file` reports platform-specific guidance to the agent. The agent should ask before running a package-manager command. Model setup is still explicit: run `/voice` once in the interactive TUI to choose and, after confirmation, download a local model.
