# AAC source rebuild and distribution evidence

The movie exporter uses Mediabunny 1.56.2 with a local
`@mediabunny/aac-encoder` **1.56.2-particl.1** package. This rebuild replaces the
npm package's precompiled FFmpeg/WASM while preserving its public API and
unmodified TypeScript/C bridge source. No other dependency was upgraded.

## Why the original binary was replaced

The [upstream AAC package](https://registry.npmjs.org/@mediabunny/aac-encoder/1.56.2)
identifies Mediabunny commit `f48609437864d569dfd2e853396a7236a46ab0d5`, but its
[build recipe](https://github.com/Vanilagy/mediabunny/blob/f48609437864d569dfd2e853396a7236a46ab0d5/packages/aac-encoder/README.md)
does not identify an FFmpeg revision or compiler version. The embedded string
`Lavc62.23.103` does not uniquely identify source. A generic FFmpeg repository
link therefore could not establish corresponding source for that npm binary.

## Shipped inputs and artifacts

- FFmpeg 8.0.1, source commit
  `894da5ca7d742e4429ffb2af534fcda0103ef593`, unmodified.
- Mediabunny core, AAC wrapper/worker/bridge and shared helpers from
  `f48609437864d569dfd2e853396a7236a46ab0d5` (1.56.2), unmodified.
- Official Emscripten 4.0.10 release
  `8103ffedfb0c42d231c6af6859a5a1a832260b43`; compiler
  `b7dc6e5747465580df5984e723b9d1f10d8e804b`.
- Build configuration enables only the AAC encoder and required libraries;
  GPL, nonfree and version3 are disabled. The generated configuration reports
  LGPL 2.1 or later. `DYNAMIC_EXECUTION=0` avoids JavaScript eval in the browser.
- The local npm tarball is the installed dependency. Four fresh ESM/UMD bundles
  and the new WASM are packaged; no original opaque WASM is retained.

The public [source kit](/open-source/aac-1.56.2-particl.1-source.tar.gz) includes
all FFmpeg source, Mediabunny core/shared/AAC source, the bridge object, licenses,
configuration evidence, exact build-tool lockfile and build/relink recipe.
The [provenance manifest](/open-source/aac-1.56.2-particl.1-provenance.json)
records source, recipe, package and binary SHA-256 hashes. The
[README](/open-source/aac-1.56.2-particl.1-README.txt) explains rebuilding and
replacing the library. These are served without login alongside the application.
The existing movie license link points to the updated
[component notice](/licenses/mediabunny.txt) and [LGPL text](/licenses/LGPL-2.1.txt).

Two clean source-directory builds produced identical glue/WASM SHA-256:
`26af84c7b8fb0d183601f2620e55fd0c7a44c469014db4521f9c0fe1bb74e145`.
The AAC ESM bundle shrank from 975 KiB to 696 KiB. The automated distribution
regression checks the installed library against the public tarball/provenance,
source archive contents, recipe hashes, source samples and license configuration.

## Runtime evidence and remaining limits

The rebuilt encoder passed the actual browser MP4 regression: decoded AAC
length 1.500 seconds, audible RMS above 0.1, and the 0.2505-second test pulse
within 3 milliseconds after priming compensation. Silent H.264 export, crop and
cancellation also passed. The production build must rerun that regression because
it serves a separately built application bundle. No paid provider call was used.

This records technical distribution evidence and source availability. It is not
a legal assurance or determination of codec patent rights. FFmpeg's
[official legal page](https://ffmpeg.org/legal.html) describes its source and
license requirements; the complete licenses and replacement instructions are
provided rather than treating the original npm metadata as sufficient evidence.
