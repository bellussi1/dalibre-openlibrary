# Open Library for Dalibre

A metadata source plugin for [Dalibre](https://github.com/djyde/dalibre) that fetches book details, high-resolution covers, series, tags, and descriptions from [Open Library](https://openlibrary.org/).

## Features

- Looks up exact editions by Open Library ID (`openlibrary:OL...M` / `OL...W`) or ISBN-10 / ISBN-13.
- Falls back to title and author search when no ISBN is set, prioritizing matching language editions (such as Portuguese `por` alongside `pt` books).
- Imports title, authors, publisher, normalized publication dates, language, series & index, subjects/tags, description, pages, translators, identifiers (`openlibrary`, `isbn`, `wd`, `goodreads`), and full-size covers (`-L.jpg`).

## Installation

### From Dalibre

Open **Plugins › Install from GitHub** and enter:

```text
bellussi1/dalibre-openlibrary
```

### Settings

- **Maximum candidates** (`maxResults`, default `10`): number of results returned per search (up to `20`).

## Development

```sh
node test.mjs
dalibre-plugin check .
dalibre-plugin identify . --isbn 9788535914849 --json
dalibre-plugin identify . "Torto Arado" --author "Itamar Vieira Junior" --json
```

## License

MIT
