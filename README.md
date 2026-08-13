# Sketchfab Public Downloader

**v1.0**

**Language / Язык:** **English** | [Русский](README.ru.md)

Chrome (Manifest V3) extension that downloads **public** Sketchfab 3D models as a **glTF (`.glb`) ZIP**. No Sketchfab account, login, or API token.

Works on models that have no official Download button.

UI: **English** and **Russian**. Light and dark themes.

Repository: https://github.com/seryi882/sketchfab-downloader-extension

---

## What v1.0 does

| Feature | Details |
|---|---|
| Public models | Mesh + optional textures from the public viewer |
| glTF output | `.glb` with PBR materials (Blender: File → Import → glTF 2.0) |
| Textures | Optional. Off by default. Protected maps are descrambled with the viewer `pk` key |
| Settings | Textures, developer mode, theme, language — take effect after **Apply settings** |
| Two identical UIs | Extension popup and the floating **⬇** panel on the model page |
| Bulk download | Paste many public links on a dedicated page |
| Heavy models | Decrypt / descramble / zip run in an offscreen worker (2K–8K packs) |
| Dev mode | Extra log in the UI; `download-log.txt` is added to the ZIP |

---

## Install (developer mode)

1. Download the **v1.0** source from [Releases](https://github.com/seryi882/sketchfab-downloader-extension/releases) or clone:
   ```bash
   git clone https://github.com/seryi882/sketchfab-downloader-extension.git
   cd sketchfab-downloader-extension
   ```
2. Chrome → `chrome://extensions`
3. Enable **Developer mode**
4. **Load unpacked** → select this folder
5. After every extension reload, **refresh the Sketchfab model page** (`Ctrl+F5`)

---

## How to download

1. Open a **public** Sketchfab model page.
2. Open **Settings** (popup or ⬇ panel).
3. Turn on **Download textures** if you need maps (leave off for a fast mesh-only ZIP).
4. Optionally enable **Developer mode** and pick theme / language.
5. Click **Apply settings** — wait for the green **Settings applied** message.
6. Download from the **Download** tab or the ⬇ panel.

| Where | Action |
|---|---|
| Floating **⬇** | Opens the page panel → **Download glTF ZIP** |
| Extension popup | **Download this model** |
| Bulk page | Popup → **Bulk download page…** → paste links → **Download all** |

Unapplied toggles do nothing. Download uses the last **applied** settings.

In Blender: **File → Import → glTF 2.0** → open the `.glb`. Press **Z → Material Preview** (Solid mode hides textures).

---

## Settings

| Setting | Default | Notes |
|---|---|---|
| Download textures | Off | When on, ZIP name ends with `-textures` |
| Developer mode | Off | Detailed log; packs `download-log.txt` |
| Theme | Light | Light / Dark |
| Language | Browser (EN / RU) | Saved with the other prefs |

Changes apply only after **Apply settings**.

---

## ZIP contents

```text
ModelName-abcd1234.zip              # or ModelName-abcd1234-textures.zip
├── ModelName.glb                   # open this in Blender
├── model.gltf + model.bin          # external glTF
├── textures/                       # only if textures are enabled
├── file.osgjs
├── model_file.bin
├── model_file_wireframe.bin        # if present
├── README.txt                      # project link
├── info.json
└── download-log.txt                # only if developer mode is on
```

Protected Sketchfab maps are descrambled (PNG/JPEG, including 4K/8K). If a map cannot be decoded, the public CDN file is kept and listed in `MISSING_BLIT.txt`.

---

## How it works

1. Reads the public embed/viewer page (UID, materials, mesh URLs, `diter.b`).
2. Extracts the current static decrypt key from live Sketchfab JS.
3. Downloads `.binz` and decrypts them with WASM.
4. If textures are on: fetches the public texture API, descrambles maps that have `pk`.
5. Converts osgjs → glTF (Y-up so the model stands in Blender).
6. Packs the ZIP in an offscreen document (the service worker cannot hold 4K/8K RGBA).

---

## Requirements

- Chrome / Chromium / Edge (Manifest V3)
- Network access to sketchfab.com, media.sketchfab.com, static.sketchfab.com

---

## Permissions

| Permission | Why |
|---|---|
| `downloads` | Save the ZIP |
| `storage` | Settings (textures, theme, language, developer mode) |
| `tabs` / `activeTab` | Talk to the model page |
| `offscreen` | Decrypt, descramble, zip large texture packs |
| Sketchfab host access | Public viewer data and CDN maps |

---

## Privacy

- No analytics or telemetry
- No Sketchfab login or API token
- Only public viewer / CDN data is used

---

## Legal

For personal use of **public** viewer data. Follow [Sketchfab Terms](https://sketchfab.com/terms) and each author’s license.

---

## Related

- CLI: https://github.com/seryi882/sketchfab-cli

---

## License

MIT — see [LICENSE](LICENSE).
