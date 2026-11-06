---
type: decision
title: "Kinetic native targets: Bevy + winio on desktop, Filament + DivKit on phone, derived from Omnishell screens"
description: Accepted, partially built — splits native targets cleanly into Desktop (Bevy over Metal/Vulkan/DX12 + Rust winio over AppKit/WinUI 3/GTK 4/Qt 6) and Phone (Google Filament over Vulkan/Metal + upstream DivKit on Android and iOS); keeps the 60 Hz Jessie simulation in QuickJS/JavaScriptCore and GGRS for cross-platform rollback; derives both DivKit and winio trees deterministically from Omnishell's screen markup rather than LLM-authoring per platform or chaining winio through DivKit; and uses Khronos glTF 2.0 (EXT_mesh_gpu_instancing + material.extras + KTX2 IBL) with thin target-specific presenters.
status: accepted, partially built
---

# Kinetic native targets

Apex Run's simulation (`shell/engine/simulation.js`) steps in 45–110 µs and its rollback session (`ggrs` 0.13) is already a Rust library, while its web presenter (`babylonjs@9.31.0` in a pruned worker over `OffscreenCanvas`, [[2026-10-22-endowed-babylon|the endowed-Babylon record]]) spends 18–19 ms of CPU a frame at 1280×720 submitting draws through browser WebGPU, forcing adaptive resolution scaling, coarse LOD splits and unshadowed verge geometry.

Because the presenter in [[../component-contracts#Dual planes and the kinetic contract|the kinetic contract]] is **Level 0 (pure projection)** — it receives `{frame, state, prev, alpha, historical, levels, cut}` and raises nothing back — the rendering backend can be replaced per target without touching the simulation, its milestones, its replays or its online duel machines ([[2026-10-23-kinetic-machine|the kinetic-machine record]]). This record designs the native desktop and mobile targets for both planes.

## The two planes across Web, Desktop and Phone

Desktop and mobile split cleanly along their native ecosystems: **Desktop** is one Rust workspace (`winio` + `bevy` + `rquickjs` + `ggrs`) targeting macOS, Windows and Linux (GNOME/GTK and KDE/Qt); **Phone** pairs upstream **DivKit** with **Google Filament** on Android and iOS.

| Target | DOM plane (derived from Omnishell markup) | Kinetic simulation & rollback | Kinetic presenter (3D) | OS compositor overlay |
| --- | --- | --- | --- | --- |
| **Web** (built) | HTML and CSS regions over rows | Jessie in SES compartment; GGRS in Wasm | Babylon.js 9.31 on WebGPU (`OffscreenCanvas` worker) | Browser compositor (`canvas[data-layer]`) |
| **Desktop — macOS** | **`winio`** (Rust) → native **AppKit** (`NSView` / `NSControl`) | Jessie in `rquickjs`; GGRS native Rust | **Bevy** (`bevy_render` / `wgpu` on Metal) | `CoreAnimation`: AppKit `NSView` tree over child `CAMetalLayer` (`RawWindowHandle::AppKit`) |
| **Desktop — Windows** | **`winio`** (Rust) → native **WinUI 3 / Win32** (`HWND`) | Jessie in `rquickjs`; GGRS native Rust | **Bevy** (`bevy_render` / `wgpu` on DX12) | `DirectComposition`: WinUI / Win32 controls over child DX12 surface (`RawWindowHandle::Win32`) |
| **Desktop — Linux (GTK)** | **`winio`** (Rust) → native **GTK 4** (`GtkWidget`) | Jessie in `rquickjs`; GGRS native Rust | **Bevy** (`bevy_render` / `wgpu` on Vulkan) | Wayland / GSK: `gtk4::Overlay` over child `GdkSurface` (`RawWindowHandle::Wayland`) |
| **Desktop — Linux (KDE)** | **`winio`** (Rust) → native **Qt 6** (`QWidget`) | Jessie in `rquickjs`; GGRS native Rust | **Bevy** (`bevy_render` / `wgpu` on Vulkan) | Wayland / KWin: Qt widget overlay over child Vulkan surface |
| **Phone — Android** | Upstream **DivKit** (`com.yandex.div:div` `Div2View` + `DivCustomContainerViewAdapter`) | Jessie in `QuickJsOmnishellEngine`; GGRS via JNI/C-FFI | **Google Filament** (`filament-android`, Vulkan / OpenGL ES) | `SurfaceFlinger`: `Div2View` overlaid on hardware `SurfaceView` |
| **Phone — iOS** | Upstream **DivKit** (`divkit-ios` `DivView` + `DivCustomBlockFactory`) | Jessie in `JavaScriptCoreOmnishellEngine`; GGRS via C-FFI | **Google Filament** (Metal `CAMetalLayer` / `MTKView`) | `CoreAnimation`: `DivView` overlaid on `CAMetalLayer` |

## 1. Derive from Omnishell markup, not from DivKit and not by the LLM

[[../screens#Derived from the markup|Pronto's screen contract]] holds that *"two statements of one fact need a checker, or one of them derived."* Every compile-time gate — `derive.ts` (`read-markup.ts`), `check markup`, `check machines`, `check i18n`, `check kinetic` — reads the app's single declared screen source (`shell/screens/*.{html,css}` and `surface.screens` in `program.cue`).

1. **Why the LLM does not author `DivKit` or `winio` screens directly.**
   In [[../compiler|the compiler ladder]], only the two hops above `program.cue` (`brief.md → ir.html → program.cue`) belong to the model; everything below `program.cue` is a pure function. Previously `apps/realworld` shipped a 1,267-line LLM-authored bundle (`android/bundle/realworld_bundle.js`, `ios/bundle/realworld_bundle.js`) that manually re-declared the 12-table SQLite schema and hand-built DivKit JSON objects (`renderHomeAst`, `renderArticleAst`, `renderEditorAst`) apart from `shell/screens/*.html`, which is why `check-parity.ts` had to exist. Extending that pattern to `DivKit` on phone and `winio` on desktop would create three parallel statements of every screen and leave parity to a checker hardcoded per app.
2. **Why `winio` is translated from Omnishell, not from DivKit.**
   DivKit JSON (`card`, `states`, `div-container`, `div-custom`, `DivVariableController`) is Yandex's mobile SDUI wire format, shaped around Android `Div2View` and iOS `DivView`. Chaining `Omnishell → DivKit → winio` would force desktop layouts through mobile SDUI idioms.
3. **One Omnishell screen IR, two native back-ends.**
   Omnishell's markup reader (`read-markup.ts`) and runtime binder (`interpreter/screen.js`, `interpreter/fragment.js`) already resolve every `data-live` region, `data-text`, `data-attr-*`, `data-on-*`, `data-state` CSS rule, `data-kinetic` mount, `canvas[data-layer]` slot and `data-touch-zone`. From that single bound Omnishell screen representation:
   - **Phone back-end** lowers regions and state rules to **DivKit JSON + DivKit Variables**, rendered by upstream `com.yandex.div:div` on Android and `divkit-ios` on iOS.
   - **Desktop back-end** lowers the same bound regions and state rules to **`winio`'s Elm-like (`init` / `update` / `render`) component tree** in Rust, which instantiates real OS widgets (`NSView` on macOS, WinUI 3 / `HWND` on Windows, `GtkWidget` on GNOME, `QWidget` on KDE).
   - Because both native targets are deterministic projections of the vetted Omnishell screen markup, `check-parity.ts` (which [native hosts](https://github.com/bonisoft3/omnishell/blob/v0.21.7/docs/native-hosts.md#declaring-it) noted was hardcoded to `realworld`'s hand-written bundle) is replaced by construction.

## 2. Why macOS uses `winio` (Desktop) rather than `divkit-ios` (Mobile)

Although `divkit-ios` can run on macOS through Apple's Mac Catalyst (`UIView`-on-`AppKit`), favoring **`winio` on macOS** aligns every target along a strict **Desktop vs. Phone** boundary:

- **True AppKit (`NSView` / `NSControl`) vs. Catalyst `UIView`:** `winio`'s macOS backend binds directly to AppKit via `objc2`, giving macOS native desktop hit targets, focus rings, keyboard navigation and windowing rather than iPad-emulated Catalyst views.
- **One Cargo build for all desktops:** Every desktop target (macOS, Windows, Linux GTK, Linux KDE) builds from one Rust Cargo workspace combining `winio` (native OS widgets), `bevy` (`wgpu` over Metal, DX12, Vulkan), `rquickjs` (Omnishell + Jessie simulation) and `ggrs` (native Rust rollback netcode), with no Xcode/CocoaPods wrapper required for desktop builds.

## 3. The simulation stays Jessie in the native host's JS engine

The 60 Hz engine (`surface.engines.apexrun`) is a linked Jessie module graph with no endowments ([[../archive/2026-10-23-jessie-import|Jessie import]]). On native hosts it runs unchanged inside the headless JS engine the host already embeds ([native hosts](https://github.com/bonisoft3/omnishell/blob/v0.21.7/docs/native-hosts.md)):

- **Desktop (macOS, Windows, Linux) & Android**: QuickJS (`rquickjs` in the Rust desktop host, `QuickJsOmnishellEngine` on Android).
- **iOS**: `JavaScriptCore` (`JavaScriptCoreOmnishellEngine`).

Keeping one source evaluated under IEEE-754 double precision preserves bit-exact `saveState` checksums across Web, Desktop and Phone. A player on macOS (Bevy + `winio`), a player on Android (Filament + DivKit) and a player in Chromium (Babylon + DOM) can race in the same `apexrun_duel` session: GGRS exchanges the same 1-byte seat inputs and lifts the same `(frame, kind, checksum)` milestones.

On desktop and mobile, GGRS 0.13 (`gschup/ggrs`) links directly as a native Rust library (or C-FFI staticlib on iOS/Android) rather than through `ggrs_wasm_bg.wasm`.

## 4. Native kinetic presenters: Bevy on desktop, Filament on phone

A kinetic actor's `presenter` (`capabilities.vendored.<name>`) gains native target bindings alongside its web `src` and `scripts`:

- **Desktop — Bevy (`bevy_render` / `wgpu`):**
  Runs in the desktop process on a dedicated render thread over Metal (macOS), Vulkan (Linux/Windows) and DX12 (Windows). Bevy's pipelined rendering extracts the latest interpolated frame `{state, prev, alpha, cut}` while the previous frame records GPU command buffers in parallel. Hardware features unavailable or bottlenecked in browser WebGPU — compute-driven frustum and occlusion culling for thousands of verge instances, cascaded shadow maps at native resolution, temporal anti-aliasing, GTAO, motion blur and custom WGSL gouache/toon material extensions — run without worker serialization or JS GC pauses.
- **Phone — Google Filament (`google/filament`):**
  Engineered for mobile tile-based GPUs (Adreno, Mali, Apple GPU). Materials compile ahead of time with `matc` into `.filamat` binaries containing target-specific Vulkan SPIR-V and Metal shading language shaders, eliminating shader compilation hitching on first frame. Filament's `View` provides mobile-tuned dynamic resolution, bloom, ACES/custom color-grading LUTs (`GRADE` in `renderer.js`) and cascaded shadows within mobile thermal budgets.

## 5. What the glTF 2.0 + thin presenter contract needs

[[2026-10-22-endowed-babylon#Rejected|The endowed-Babylon record]] rejected inventing an omnishell draw-list vocabulary sized to one game. At the same time, rewriting 4,000 lines of deterministic stage assembly (`stage_look.js`, `scatter.js`, `scenery.js`, `art.js`) three times in JS, Rust and C++/Kotlin/Swift would duplicate pure math.

Using Khronos **glTF 2.0 (ISO/IEC 12113)** — which all three engines load natively (`babylonjs-loaders`, Bevy's `bevy_gltf`, and Filament's `gltfio`) — plus a thin target-specific presenter is sufficient provided four pieces are part of the contract:

1. **Static models, LODs and KTX2 IBL skies in `assets/manifest.json`.**
   Every car, rider, flagman and roadside prop is already a `.glb` with `lod0`–`lod2` (`LOD_SPLITS = [70, 200]`, `LOD_FAR = 520` in `art.js`). To avoid per-engine sky prefiltering differences, each stage's photo sky in `STAGE_ART` ships prefiltered diffuse irradiance and specular reflections as a `.ktx2` cubemap alongside its backdrop strips (`BACKDROP_LAYERS`), which Filament (`Ktx1Bundle`/`ktx2`), Bevy (`EnvironmentMapLight`) and Babylon load directly.
2. **Stage geometry, chunked `EXT_mesh_gpu_instancing` and procedural RGBA tiles generated once per stage load.**
   For a given `(stageId, seed)`, a pure stage-assembly module runs `placeProps`, `scatterVerge`, the road/promenade/sea-wall ribbon builders (`stage_look.js`) and the deterministic procedural texture generators (`frondTexture`, `waveNormals`, `brushStrokes`, `flowerCarpet` in `scenery.js`) and emits one stage glTF 2.0 bundle:
   - Road, terrain and shore ribbons as standard glTF mesh primitives.
   - Roadside props and verge foliage grouped into spatial chunks of `SCATTER_CHUNK = 25` road segments using `EXT_mesh_gpu_instancing` (`TRANSLATION`, `ROTATION`, `SCALE` accessors), so Bevy's and Filament's native frustum and distance cullers drop whole off-screen chunks without CPU iteration.
   - The four procedural pixel maps embedded as PNG textures in the stage bundle.
3. **Material semantic tags in glTF `material.extras`.**
   In `renderer.js`, tables like `SWAYING` (`frond`, `grass`, `leaf`), `SURFACE_OVERLAYS` (depth-offset windows and doors on towers/hangars), `MATERIAL_TINTS`, `MATERIAL_LIFT` and water/toon flags attach shader behavior to specific materials. Stamping those tags into each material's standard glTF `"extras"` object (`{"stk": {"toon": true, "sway": true, "depthOffset": 0.08, "tint": "#6E8350"}}`) keeps model-specific tables out of the native presenters: Bevy and Filament inspect `material.extras.stk` on load and bind the corresponding WGSL `MaterialExtension` or `.filamat` material instance.
4. **Compact per-frame pose + moments struct.**
   Each tick, the host passes a flat typed buffer (`Float32Array` / C struct) derived from `viewOf(state)` and `moments(state)` (`effects.js`):
   - Camera position, target, up, FOV and speed-lines factor;
   - Hero car, rival car and active traffic slice (~12 cars): world transform, wheel spin/steer, body pitch/roll (`BODY_PIVOT_Y`), drift flame/smoke emitters and rider arm/head angles (`GIRL_ARM`, `GLANCE_PERIOD`);
   - Stage atmosphere scalars: `haze` density (`HAZE_DENSITY`), sun/sky exposure and time-of-day;
   - Frame-timed moments (`swoop`, `count`, `clear`, `pass`, `rival`, replay `cut` titles) and fast HUD telemetry (`speed`, `rpm`, `tacho`, `gear`, `nitro`, `timer`, `score`, `drift`, `radar`, `eq`).

Each target's presenter is then ~600–800 LoC: it loads the `.glb` manifest and stage bundle, maps `material.extras.stk` onto its native gouache/toon shader (`matc`-compiled `.filamat` on Filament, WGSL on Bevy, `TOON_GLSL` on Babylon), applies the per-frame pose buffer to the dynamic nodes, and renders post-processing and fast HUD overlays.

## 6. Compositing native widgets over the 3D surface (`winio` on desktop, `DivKit` on phone)

- **Desktop (`winio` + Bevy):**
  `winio` mounts the `data-kinetic="<actor>"` slot as a child native surface (`NSView` with `CAMetalLayer` on macOS, `HWND` child surface on Windows, `GtkWidget`/`GdkSurface` on GNOME, `QWidget` on KDE) and hands its `RawWindowHandle` to Bevy (`wgpu`). The slow HUD panels, lobby modal, pause/results cards and 3-letter initials form are rendered by `winio`'s `render` pass as native OS widgets overlaid above the 3D surface via the OS compositor (`CoreAnimation`, `DirectComposition`, Wayland/GSK, KWin).
- **Phone (upstream `DivKit` + Filament):**
  `plugins/omnishell/android` and `plugins/omnishell/ios` depend on upstream `com.yandex.div:div` (`Div2View`) and `divkit-ios` (`DivView`), replacing the 5-node hand-rolled stubs in `apps/realworld`. `data-kinetic="<actor>"` mounts Filament's `SurfaceView` (Android) or `CAMetalLayer` view (iOS) through DivKit's **`div-custom`** (`DivCustomContainerViewAdapter` on Android, `DivCustomBlockFactory` on iOS), with transparent DivKit containers overlaid above it via `SurfaceFlinger` and `CoreAnimation`.
- **Fast HUD vs. Slow HUD:**
  - **Slow HUD (row-driven):** Emitted through `winio`'s `update` message on desktop or DivKit's `emitUiAst(json)` on phone only when rows change (at milestones or menu gestures).
  - **Fast HUD (60–120 Hz frame-driven):** Drawn by the Bevy or Filament presenter in its orthographic HUD pass inside the bounding boxes measured from the native `<canvas data-layer>` placeholders (or, for simple text/bar scalars on phone, updated in place via DivKit's `DivVariableController` / `DivVariableStorage` without JSON re-parsing).

## Slices

| Slice | Builds | Gate |
| --- | --- | --- |
| 1 | Deterministic compiler/runtime projection from Omnishell screen markup (`shell/screens/*.{html,css}`) to upstream DivKit (Android `com.yandex.div:div`, iOS `divkit-ios`) and Rust `winio` component trees, replacing `apps/realworld` hand-rolled stubs and `check-parity.ts` | Native host suites pass on `apps/realworld` and `apps/apexrun` from emitted screen markup alone |
| 2 | Pure stage glTF 2.0 builder (`EXT_mesh_gpu_instancing` chunked by `SCATTER_CHUNK`, `material.extras.stk` tags, `scenery.js` RGBA textures, `.ktx2` IBL skies) and compact C-ABI pose + `moments` struct | Unit tests verify deterministic stage `.glb` output, material extras and pose buffer against `renderer.js` |
| 3 | Desktop Rust host (`winio` over AppKit/WinUI 3/GTK 4/Qt 6 + Bevy presenter crate over Metal/DX12/Vulkan + `rquickjs` + native `ggrs`) | 120 fps frame-cost gate at native resolution; slow HUD widgets in OS accessibility tree; GGRS online duel against a web peer |
| 4 | Mobile Filament presenter (`filament-android` Vulkan + iOS Metal) mounted via upstream DivKit `div-custom` (`DivCustomContainerViewAdapter` / `DivCustomBlockFactory`) | 60/120 fps frame gate on device/emulator; touch-zone parity test (`tests/touch.ts` equivalents); cross-platform duel against desktop and web |
| 5 | Native audio role bridge (CoreAudio / Oboe / CPAL AudioContext facade for `shell/engine/sound.js`) | `tests/audio.test.ts` parity and live mix verification |

## Rejected

- **Having the LLM author `DivKit` JSON or `winio` Rust views per screen** — violates [[../screens#Derived from the markup|the single-source screen contract]] (*"two statements of one fact need a checker, or one of them derived"*) and [[../compiler|the compiler ladder]] (everything below `program.cue` is deterministic); deriving both from Omnishell's screen markup eliminates cross-platform drift by construction.
- **Translating `DivKit` AST into `winio` on desktop** — turns a mobile SDUI wire format into an unnecessary intermediate layer between Omnishell's screen markup and desktop widgets.
- **Running `divkit-ios` on macOS via Mac Catalyst instead of `winio`** — blurs the Desktop (`winio` + Bevy in one Cargo workspace) vs. Phone (`DivKit` + Filament) split and gives macOS iPad-emulated `UIView` controls instead of native AppKit `NSView`s.
- **Keeping the hand-rolled 5-node DivKit parsers in `apps/realworld` for Android and iOS** — upstream `com.yandex.div:div` and `divkit-ios` already provide `Div2View`, `DivView`, `div-state`, `div-animator`, `DivVariableController` and `div-custom` (`DivCustomContainerViewAdapter` / `DivCustomBlockFactory`), which [native-hosts.md](https://github.com/bonisoft3/omnishell/blob/v0.21.7/docs/native-hosts.md) already assumed.
- **`bevy_ui`, `egui`, `iced`, or `slint` for the desktop DOM plane** — none of them instantiates OS-native widget handles (`NSView`, `HWND`, `GtkWidget`, `QWidget`) across all four desktop environments the way `winio` does.
- **Tauri / `wry` transparent WebView overlay on desktop** — brings back the browser layout/compositor process that [native hosts](https://github.com/bonisoft3/omnishell/blob/v0.21.7/docs/native-hosts.md#rejected) rejected on mobile.
- **A custom cross-engine declarative scene or draw-list language** — rejected in [[2026-10-22-endowed-babylon#Rejected|the endowed-Babylon record]]; glTF 2.0 with `EXT_mesh_gpu_instancing` and `material.extras` already has native loaders in Babylon, Bevy and Filament for geometry, instancing and material metadata, while custom shaders and post-processing belong in thin target-specific presenters.
- **OpenUSD as the runtime scene format** — no lightweight runtime loader exists for Filament on mobile or Babylon in the browser.
- **Porting `simulation.js` to Rust or C++** — the 60 Hz Jessie step costs 45–110 µs (<0.7% of a 16.6 ms frame); rewriting it in a second language risks floating-point drift that breaks GGRS rollback checksums across Web, Desktop and Phone.
- **Re-emitting full UI trees at 60/120 Hz for fast HUD telemetry** — rejected for the same reason [[2026-10-23-kinetic-machine#The HUD splits by refresh rate|the kinetic-machine record]] rejected a 60 Hz DOM binding; fast telemetry rides the presenter's pose struct (or `DivVariableController` in-place scalar updates) with zero AST re-parsing.
