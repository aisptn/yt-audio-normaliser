
# YouTube Audio Normalizer

A Chrome extension that normalizes audio loudness on YouTube and YouTube Music for consistent volume across videos and tracks.

## Features

- **Dynamic Range Compression** – Reduces volume peaks and brings up quiet passages
- **Automatic Gain Control** – Intelligently adjusts levels to match a target loudness
- **Brick-wall Limiter** – Prevents clipping and sudden loud spikes
- **Presets** – Light, Medium, Heavy, or Custom settings
- **Real-time Metering** – Visual feedback of input, output, gain reduction, and auto-gain
- **Persistent Settings** – Your preferences are saved across sessions

## Installation

1. Clone or download this repository
2. Open `chrome://extensions/` in Chrome
3. Enable **Developer mode** (top right)
4. Click **Load unpacked** and select this folder
5. The 🎚️ icon appears in your toolbar

## Usage

- Click the extension icon to open the popup
- Toggle **Enable** to activate/deactivate processing
- Select a preset (Light, Medium, Heavy) or customize manually
- Adjust **Target Loudness** to set your desired output level
- Expand **Advanced Controls** for fine-tuned compressor parameters

## Settings

| Setting | Range | Default |
|---------|-------|---------|
| Target Loudness | −24 to −6 dB | −14 dB |
| Threshold | −60 to 0 dB | −24 dB |
| Ratio | 1:1 to 20:1 | 4:1 |
| Knee | 0 to 40 dB | 10 dB |
| Attack | 0 to 200 ms | 3 ms |
| Release | 10 to 1500 ms | 250 ms |
| Makeup Gain | 0 to +30 dB | +6 dB |
| Pre-Gain | −20 to +20 dB | 0 dB |

## Architecture

- **manifest.json** – Extension configuration
- **content.js** – Audio processing engine (Web Audio API)
- **background.js** – Service worker for defaults
- **popup.html / popup.js / popup.css** – UI and controls

## License

MIT
