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
- An engine id written twice in the JSON is not caught: the last one silently wins, so check the sheet for duplicate engine ids before pasting. The ids `__proto__`, `constructor` and `prototype` are refused.
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

## Making the file from the cost sheet

The owner exports the cost sheet as CSV and converts it on his own machine, in a clone of this repo (Node 24, the repo's version; no install beyond the repo's own):

```sh
node --permission --allow-fs-read="*" scripts/vendor-prices/csv-to-json.mjs ~/cost-sheet.csv | pbcopy
```

It puts the JSON on the clipboard (`| pbcopy`, on a Mac; without it the JSON prints in the terminal) and prints a report naming lines, columns and engines, never a figure. The JSON goes into the file mount on the server by hand; the figures never go anywhere else. **Never redirect the JSON into a file inside the repo's folder** (the repo is public); `.gitignore` also ignores `/vendor-prices*.json` and `*cost-sheet*.csv` as a backstop. `--permission --allow-fs-read` lets it read and nothing more: Node refuses any write, child process or worker. It opens no connection: that is a property of the code, checked by a test over the script and everything it loads, not something Node 24's permission model enforces.

- **Columns**, one row per price: `engine, unit, resolution, audio, length, upTo, costUsd`, as in the table above. Only `engine`, `unit` and `costUsd` are required; an empty cell means the key is not set. Lines starting with `#` are notes. Any column order works.
- **`costUsd` is plain US dollars per unit:** digits and at most one dot. A currency sign or code, a thousands separator, a minus, an exponent, a word, or zero is refused. A margin, markup or selling-price column is refused: the sheet holds vendor costs only.
- **The same rules as the server:** the script checks its output with `parseVendorPrices` from `lib/vendorPriceFile.ts`, so a file it prints is a file the server loads. Problems point at the sheet's line.
- **Coverage:** by default every engine the model registry (`MODELS` in `lib/models.ts`, the catalogue of engines with their resolutions and lengths) offers must have a row for each resolution, and, for `job` rows, for each length; where an engine's rows name sound, both with and without where it offers sound. Every engine the registry offers is checked; only a retired one is not expected. A gap is refused (nothing printed, exit 2) with the list of what is missing. Leaving engines out is explicit: `--skip id,id` leaves the named engines out of the check, and `--engines id,id` checks only the engines named (for a sheet that prices some engines only, for example only those moved to the file). The report lists every engine not checked, and why.
- `--check` validates and reports without printing the JSON. Given a `.json` file instead of a CSV, it checks that file the same way (for a file converted earlier).
- Exit codes: **0** valid and covered (also `--help`, which prints its usage to stderr); **1** refused: a usage error, an unreadable file, a Node too old or sources that fail to load, or the sheet or the file's shape; **2** valid but not covered. With `| pbcopy` the shell reports pbcopy's exit code, not the converter's, so read the report: it ends in `coverage: complete.` only when the JSON was printed (a refusal leaves the clipboard empty).
- **Sample sheet:** `docs/vendor-prices-sample.csv`. Every figure in it is fake (one digit repeated, 111.11 to 999.99), and a test keeps it that way.

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
