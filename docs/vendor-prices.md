# The vendor price file

What the vendors charge the platform lives in a private JSON file on the server, not in the repo. The code reads it from one environment variable and holds no figure of its own (owner, 17 and 19 Oct 2026). Margins are not in this file: they are a separate per-service setting that comes later as its own config.

Code: `lib/vendorPriceFile.ts`. Tests: `tests/unit/vendorPriceFile.spec.ts`.

## Where it is read from

- Environment variable: **`VENDOR_PRICES_PATH`**, an absolute path to the file inside the app's container.
- The file is mounted on the server by the owner. It is never committed: a test fails if any JSON file in the repo carries the format marker below.

## Shape

```json
{
  "format": "particl-vendor-prices/1",
  "engines": {
    "<engine id>": {
      "<unit>": [
        { "resolution": "<name>", "audio": <true|false>, "costUsd": <COST_PER_UNIT> },
        ...
      ]
    }
  }
}
```

- `format` must be exactly `particl-vendor-prices/1`.
- `engines` is keyed by engine id: the id the app already uses for that engine.
- Each engine has one or more units. A unit is what the cost is per:
  `second`, `minute`, `job`, `image`, `page`, `source`, `layer`, `character`, `token`.
- Each unit is a list of rows. A row is `costUsd` (US dollars per one unit, above zero) plus the settings it applies to:

| Key | Meaning | Allowed on |
|---|---|---|
| `resolution` | for example `720p`, `1080p`, `4k`, `1K` (case does not matter) | any unit |
| `audio` | `true` with sound, `false` without | any unit |
| `length` | whole seconds of a fixed-length job (engine × resolution × length) | `job` only |
| `upTo` | a band: this cost per unit applies up to this many units (pages, sources, minutes) | every unit but `job` |

- Every row of one unit names the same keys, and no two rows repeat the same settings.
- A cost is the row's `costUsd` times the quantity (seconds, pages, and so on; for `job`, the number of jobs), rounded up to the micro-dollar. With bands, the smallest band the quantity fits is used.

Examples with placeholder names (the owner's sheet fills the figures):

```json
{
  "format": "particl-vendor-prices/1",
  "engines": {
    "<video engine id>": {
      "second": [
        { "resolution": "720p",  "audio": false, "costUsd": <COST_A> },
        { "resolution": "1080p", "audio": false, "costUsd": <COST_B> }
      ]
    },
    "<fixed-length engine id>": {
      "job": [
        { "resolution": "1080p", "length": 5,  "costUsd": <COST_C> },
        { "resolution": "1080p", "length": 10, "costUsd": <COST_D> }
      ]
    },
    "<reading service id>": {
      "page": [
        { "upTo": 10,  "costUsd": <COST_E> },
        { "upTo": 100, "costUsd": <COST_F> }
      ]
    }
  }
}
```

## When something is wrong

Nothing is ever priced from a number in code. In every case below, an engine priced from this file is **unpriced** and its quote is refused with "This engine has no confirmed price." (HTTP 503):

- `VENDOR_PRICES_PATH` is not set, or is not an absolute path;
- there is no readable file at that path, or it is a directory;
- the file is not JSON, is larger than 1 MB, or breaks any rule above (an unknown key, a margin, a cost of zero or less, mixed row keys, a repeated row). One bad row rejects the whole file;
- the file has no row for the settings asked for, or the quantity is past the largest band.

A bad file is logged and refused; it never stops the server. The file is read again when it changes (looked at every 30 seconds).

## Checking it worked

- Server log, once per change: `vendor prices: loaded, N engines`, or `vendor prices: <unset|missing|invalid file …>; every file-priced engine is unpriced`.
- Platform admin only: `GET /api/admin/readiness?vendorPrices=1` adds `vendorPrices: { variable, state, engines }`, plus `problems` (where, never a figure) when the file is invalid. It never shows a price, a row or the path. Without `?vendorPrices=1` the reply is unchanged.

## What uses it today

Nothing. `lib/vendorRates.ts` and its tests are unchanged and still price every engine they priced before. An engine moves to this file by being listed in `FILE_PRICED_ENGINES` in the PR that ports it, after the owner signs off; an engine is never priced in both places.
