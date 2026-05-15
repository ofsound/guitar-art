Guitar Art
==========

Guitar Art is a desktop visual synthesizer for guitar. It analyzes a live input
or a saved playback file, extracts musical/audio features, and uses those
features to drive layered 2D and 3D visuals.

What it does
------------

- Captures live guitar input through the native audio engine.
- Supports playback from imported or recorded audio files.
- Extracts features such as RMS, peak, spectrum bands, onset, spectral flux,
  pitch, note name, chroma, fret/string estimates, chord data, and guitar
  technique/events.
- Renders visual layers such as trails, raindrops, fret pulse, technique maps,
  side scroller views, 3D forms, spectral fields, chroma constellations, guitar
  glyphs, string resonators, and technique shards.
- Lets each visual layer tune its own response, gate, opacity, smoothing, and
  mode-specific controls.
- Can save still images and WebM recordings from the visual output.

Stack
-----

- Electron desktop app, packaged with Electron Forge.
- Vite builds the Electron main, preload, and renderer targets.
- React + TypeScript for the renderer UI.
- Three.js for 3D visual layers.
- Canvas 2D for 2D visual layers.
- Rust native audio engine exposed to Node through napi-rs.
- CPAL handles native audio input.
- rustfft and custom DSP code extract audio/guitar features.
- Playwright powers the renderer smoke test.

Project layout
--------------

- src/main: Electron main process, app windows, IPC handlers, file/library IO.
- src/preload: Safe bridge exposing app APIs to the renderer.
- src/renderer: React UI, audio client wrapper, playback feature engine, visuals.
- src/shared: Shared TypeScript types and defaults.
- native/audio-engine: Rust native audio engine and Node binding package.
- scripts: Test and smoke-test utilities.

Development
-----------

Install dependencies:

  npm install

Run the app in development:

  npm run dev

This builds the native audio engine in debug mode, then starts Electron Forge.

Run Electron without rebuilding the native engine:

  npm start

Useful checks
-------------

Type-check the TypeScript code:

  npm run typecheck

Run native Rust tests:

  npm run test:native

Run renderer smoke test:

  npm run test:renderer

Run the full test suite:

  npm test

Packaging
---------

Package the app:

  npm run package

Build distributable makers:

  npm run make

Build script summary
--------------------

- npm run build:native:debug: build the Rust audio engine for development.
- npm run build:native: build the Rust audio engine for packaging.
- npm run build: type-check, build native engine, and package the app.
- npm run dev: rebuild native debug engine and launch the app.
- npm run package: build native engine and create an Electron package.
- npm run make: build native engine and create configured distributables.

Notes
-----

Low buffer sizes such as 32 or 64 samples are available in the UI for
low-latency testing, but support depends on the selected audio device/driver.
If a device rejects a fixed low buffer size, use 128 or 256 instead.
