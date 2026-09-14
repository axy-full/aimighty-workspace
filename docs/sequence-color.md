# Sequence color and LUTs

Open Edit → Sequence color in the inspector beside the player. Import a standalone 3D `.cube` file or select one already in the production's asset library. The original uploaded bytes are retained. Brightness, contrast and saturation are display-referred corrections, applied before the LUT; LUT mix blends its transformed result with that corrected source. Bypass disables the entire sequence look. Reset restores adjustments and mix while retaining the selected LUT; Clear removes the sequence look while retaining its original asset.

Settings are saved with the private production and movie handoff. The same WebGL 2 shader applies trilinear interpolation to the live image/video preview and every rendered movie frame. Still previews and paused video frames are redrawn only after their source or settings change. Letterbox areas stay outside the grade. GPU resources and source fetches are cleaned up when the preview is closed or a movie is cancelled. A missing/unreadable LUT stops graded export rather than producing an ungraded file labeled as finished.

The editorial package includes the exact original `.cube` filename and bytes plus settings in `production.json`. CMX3600 EDLs do not contain grades: the receiving colorist must apply the LUT/settings manually, or use the graded final movie as reference. The movie is a new render; source assets are not overwritten.

## Accepted files and working space

Files are bounded at 16 MB, valid UTF-8, 2–65 lattice points per axis, with red changing fastest. Exact row counts, finite RGB values, headers and input domains are validated. `DOMAIN_MIN`/`DOMAIN_MAX` and `LUT_3D_INPUT_RANGE` are supported as alternative domain conventions. A combined 1D shaper or 1D-only LUT must be exported as a standalone 3D table before import. LUTs are fetched through the authenticated workspace upload route; arbitrary external file URLs cannot substitute for the selected original.

Processing operates on browser-decoded SDR RGB, through an 8-bit display canvas. Values outside the LUT domain clamp at its edges; output values clamp to the display range. This is not an ACES/OCIO pipeline, automatic log conversion, calibrated monitoring or HDR mastering. It does not preserve camera RAW, scene-linear data, source HDR metadata or high-bit-depth intermediates. The existing final movie bounds are three minutes, 720p/1080p and 200 MB of media/output. One look applies to the whole sequence; per-shot grades and professional scopes remain additional work.

## Source LUTs

For generated SDR material, choose a display-referred creative LUT compatible with that source. A camera's log-to-display LUT expects its named gamma and gamut; applying it to an already normalized image can produce an incorrect result.

- [ARRI LUT Generator and packages](https://www.arri.com/en/learn-help/learn-help-camera-system/tools/lut-generator): separate LogC3/AWG3 and LogC4/AWG4 packages. The interactive generator supports LogC3, not LogC4.
- [Sony professional LUT downloads](https://pro.sony/en_CA/technology/professional-video-lut-look-up-table): camera look profiles, BURANO looks and s709 monitoring LUTs. Match the transform to the source encoding.

These official pages were checked on 14 September 2026. No third-party LUT files are bundled or redistributed. Check the selected file's license and test the target NLE conform before delivery.

## Verification

Tests upload synthetic media through the actual scoped upload routes, import a known channel transform, save/reload the production, exercise mix and bypass, inspect canvas pixels, decode the exported movie and compare color values. The editorial ZIP is opened to verify the original `.cube` bytes. A separate GPU test compares interpolation with a CPU reference using nonuniform input domains, partial mix and vertically distinct colors. Unit checks reject malformed tables and dangling asset bindings. No paid generation is used.
