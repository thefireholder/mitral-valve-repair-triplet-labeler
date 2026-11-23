# Action-triplet labeler (online)

The browser-only version of `../action-triplet-labeler`. It is hosted on GitHub Pages and needs no server:

| Part | Where it runs |
|---|---|
| App (HTML/JS) | GitHub Pages |
| Videos | Opened from a folder on the labeler's own computer. They are never uploaded. |
| YOLO segmentation | In the browser, using the GPU through WebGPU (`yolo-worker.js` + `model/yolo-seg.onnx`) |
| Labels | A Google Sheet, through a small Apps Script (`apps-script/Code.gs`), with one tab per video |

Use **Google Chrome** (or Edge) on a computer. Remembering the video folder and running YOLO on the GPU both need it.

## One-time setup

### 1. Google Sheet + Apps Script
1. Signed in to the Gmail account that should own the labels, create a new Google Sheet (e.g. "Triplet labels").
2. In the sheet, go to **Extensions → Apps Script**. Delete the sample code and paste in all of `apps-script/Code.gs`.
3. Save (💾). `SECRET` in `Code.gs` is already set and matches `config.js`.
4. **Deploy → New deployment →** gear icon **→ Web app**:
   - Execute as: **Me**
   - Who has access: **Anyone**

   Click **Deploy**, approve the permissions ("Advanced → Go to … (unsafe)" is normal for your own script),
   and copy the **Web app URL**. It ends in `/exec`.

5. Paste that URL into `config.js` (`sheetUrl: '…/exec'`) and push. The app then connects to the sheet automatically,
   with nothing to type in Setup.

`config.js` holds the URL and secret and is public on GitHub, so **anyone who finds it can read and change the labels sheet**
(but nothing else in the Google account, thanks to `@OnlyCurrentDoc`). Keep the sheet's own sharing setting **Restricted**.
If labels get damaged, restore them from **File → Version history** in the sheet, and use **Backup JSON** now and then.
To lock it down later, change `SECRET` in both `Code.gs` (then deploy a new version) and `config.js`.

If you later change `Code.gs`, publish the change with **Deploy → Manage deployments → ✏️ → Version: New version → Deploy**.
This keeps the same URL.

### 2. Publish the app on GitHub Pages
1. Create a GitHub repository (e.g. `triplet-labeler`) and add the **contents of this folder** at the top level of the repo
   (`index.html` must be at the root). `model/yolo-seg.onnx` is about 55 MB. GitHub shows a "large file" warning above 50 MB,
   but the file stays under the 100 MB limit, so it's accepted.
   `.gitignore` already leaves out the 109 MB fp32 intermediate.
2. In the repo, go to **Settings → Pages → Build and deployment**, set Source to *Deploy from a branch* and Branch to `main` / `(root)`, then save.
3. After about a minute the site is live at `https://<github-user>.github.io/<repo>/`.

The site, and therefore the model file, is public. Videos and labels are not part of it.

### 3. First visit (on the PI's computer)
1. Download the videos, keeping the patient folders: `full_raw_data/Y_pt_1/…MP4`.
2. Open the site. The **Setup** dialog appears:
   1. The sheet connects automatically (from `config.js`). If `sheetUrl` is still empty, paste the URL and click **Connect**.
   2. Click **Choose folder…** and select the folder that *contains* the patient folders (`full_raw_data`).
      Always choose the same folder, because a video is identified by its path inside it (e.g. `Y_pt_1/Ch2_002_CH001_V.MP4`).
   3. The YOLO model (55 MB) downloads once and is cached for later visits.
3. Click **Start labeling**.

On later visits, Chrome remembers the folder. If it asks again, click **Reopen "full_raw_data"** in Setup.
New patient folders show up the next time the folder is opened.

## Labeling

The workflow and shortcuts are the same as the local version (press **?** in the app):

- **I / O** set the IN/OUT bars, or drag them on the timeline.
- Pick tool → action → target with the number keys, then **Save segment** / **Enter**. IN/OUT then move to the next segment.
- Click a segment to edit it. **Delete** (⌫) removes it and **⌘Z** undoes.
- **P** play/pause · **←/→** step · **[ / ]** step size · **, / .** one frame · **Space** YOLO overlay.

## Where the labels go

Each change is saved to the sheet about a second later; the badge at the top shows **saved to sheet ✓**.
Until the sheet confirms a save, a copy stays in the browser. If the internet drops, nothing is lost, and the copy is sent
the next time that video is opened. **Backup JSON** downloads the current video's labels as a file.

Sheet layout:

| Tab | Content |
|---|---|
| `_videos` | One row per video: number of segments, % of frames labeled, fps, frame count, last update |
| `_vocab` | Tool / action / target lists. Edit them here; the app picks up changes on reload. **+ add** in the app appends here. |
| `Y_pt_1 » Ch2_002_CH001_V` (one per video) | `segment_id, tool, action, target, start_frame, end_frame, n_frames, start_time, end_time, start_sec, end_sec, note, created, updated` |

Frame numbers are the source of truth: they are 0-indexed, `start_frame` and `end_frame` are inclusive,
`start_sec = start_frame / fps`, and `end_sec = (end_frame + 1) / fps`. The exact frame rate and frame count are read
from each MP4's header (e.g. 30000/1001 fps, 17970 frames).

Avoid editing a video's tab by hand while that video is open in the app. The app rewrites the tab on each save.

## Updating the model

After retraining, regenerate the browser model and commit `model/`:

```bash
# needs torch, ultralytics, onnx, onnxconverter-common
python tools/export_model.py export   # best.pt -> model/yolo-seg.fp32.onnx + model/meta.json
python tools/export_model.py fp16     # -> model/yolo-seg.onnx (~55 MB)
```

Then change the cache name in `yolo-worker.js` (`'triplet-yolo-v1'` → `'triplet-yolo-v2'`) so browsers download the new model.

## Testing locally

```bash
python3 -m http.server 8000      # in this folder, then open http://localhost:8000
```

`localhost` counts as a secure origin, so the folder picker and WebGPU work there too.
