import assert from "node:assert/strict";

globalThis.dalibre = {
  settings: { maxResults: "10" },
  error(kind, message) {
    const err = new Error(message || kind);
    err.kind = kind;
    return err;
  },
};

const { identify } = await import("./main.js");
assert.equal(typeof identify, "function", "main.js must export identify()");

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const calledUrls = [];

// 1. Direct Open Library edition ID + footnote cleanup + Translators/Pages + date & series
{
  calledUrls.length = 0;
  globalThis.fetch = async (url) => {
    const u = String(url);
    calledUrls.push(u);
    if (u === "https://openlibrary.org/books/OL26449397M.json") {
      return jsonResponse({
        key: "/books/OL26449397M",
        title: "1984",
        publishers: ["Companhia das Letras"],
        publish_date: "2009",
        pagination: "414p.",
        series: ["Fundação #1"],
        covers: [8172473],
        isbn_13: ["9788535914849"],
        languages: [{ key: "/languages/por" }],
        identifiers: { wikidata: ["Q111263683"] },
        contributors: [
          { role: "Translator", name: "Alexandre Hubner" },
          { role: "Translator", name: "Heloísa Jahn" },
        ],
        authors: [{ key: "/authors/OL15318546A" }],
        works: [{ key: "/works/OL1168083W" }],
      });
    }
    if (u === "https://openlibrary.org/works/OL1168083W.json") {
      return jsonResponse({
        key: "/works/OL1168083W",
        title: "Nineteen Eighty-Four",
        description: {
          type: "/type/text",
          value: "Dystopian novel.\r\n\r\n----------\r\nAlso contained in: ...",
        },
        subjects: ["Dystopias", "Totalitarianism"],
      });
    }
    if (u === "https://openlibrary.org/authors/OL15318546A.json") {
      return jsonResponse({ key: "/authors/OL15318546A", name: "George Orwell" });
    }
    throw new Error(`Unexpected URL in test 1: ${u}`);
  };

  const out = await identify({
    title: "",
    authors: [],
    identifiers: { openlibrary: "OL26449397M" },
  });
  assert.equal(out.length, 1);
  const c = out[0];
  assert.equal(c.id, "OL26449397M");
  assert.equal(c.title, "1984");
  assert.deepEqual(c.authors, ["George Orwell"]);
  assert.equal(c.publisher, "Companhia das Letras");
  assert.equal(c.pubdate, "2009");
  assert.equal(c.language, "por");
  assert.equal(c.series, "Fundação");
  assert.equal(c.seriesIndex, 1);
  assert.equal(c.cover, "https://covers.openlibrary.org/b/id/8172473-L.jpg");
  assert.equal(c.description, "Dystopian novel.");
  assert.deepEqual(c.tags, ["Dystopias", "Totalitarianism"]);
  assert.deepEqual(c.identifiers, {
    openlibrary: "OL26449397M",
    isbn: "9788535914849",
    wd: "Q111263683",
  });
  assert.ok(c.fields.some((f) => f.label === "Translators" && f.value === "Alexandre Hubner, Heloísa Jahn"));
  assert.ok(c.fields.some((f) => f.label === "Pages" && f.value === "414"));
  assert.ok(calledUrls.includes("https://openlibrary.org/books/OL26449397M.json"));
}

// 2. Hyphenated ISBN lookup queries both /isbn/<clean>.json and /search.json?isbn=... + date normalization
{
  calledUrls.length = 0;
  globalThis.fetch = async (url) => {
    const u = String(url);
    calledUrls.push(u);
    if (u === "https://openlibrary.org/isbn/9788535914849.json") {
      return jsonResponse({
        key: "/books/OL26449397M",
        title: "1984",
        publishers: ["Companhia das Letras"],
        publish_date: "June 8, 1949",
        covers: [9267242],
        isbn_13: ["9788535914849"],
        languages: [{ key: "/languages/por" }],
        authors: [{ key: "/authors/OL15318546A" }],
        works: [{ key: "/works/OL1168083W" }],
      });
    }
    if (u.startsWith("https://openlibrary.org/search.json?")) {
      assert.ok(u.includes("isbn=9788535914849"), `Expected isbn query in ${u}`);
      return jsonResponse({
        docs: [
          {
            key: "/works/OL1168083W",
            title: "Nineteen Eighty-Four",
            author_name: ["George Orwell"],
            first_publish_year: 1949,
            cover_i: 9267242,
            edition_key: ["OL9999999M"],
            isbn: ["9780451524935"],
          },
        ],
      });
    }
    if (u === "https://openlibrary.org/works/OL1168083W.json") {
      return jsonResponse({ key: "/works/OL1168083W", description: "Classic dystopia." });
    }
    if (u === "https://openlibrary.org/authors/OL15318546A.json") {
      return jsonResponse({ key: "/authors/OL15318546A", name: "George Orwell" });
    }
    throw new Error(`Unexpected URL in test 2: ${u}`);
  };

  const out = await identify({
    title: "",
    authors: [],
    identifiers: { isbn: "978-85-359-1484-9" },
  });
  assert.ok(out.length >= 1);
  assert.equal(out[0].id, "OL26449397M");
  assert.equal(out[0].pubdate, "1949-06-08");
  assert.ok(calledUrls.some((u) => u === "https://openlibrary.org/isbn/9788535914849.json"));
  assert.ok(calledUrls.some((u) => u.startsWith("https://openlibrary.org/search.json?") && u.includes("isbn=9788535914849")));
}

// 3. Date formats ("Oct 2019", "[2009]", garbage) + Title/Author search ranking & enrichment
{
  const dateCases = [
    ["Oct 2019", "2019-10"],
    ["[2009]", "2009"],
    ["n.d.", undefined],
  ];
  for (const [rawDate, expectedIso] of dateCases) {
    globalThis.fetch = async (url) => {
      const u = String(url);
      if (u.startsWith("https://openlibrary.org/isbn/")) {
        return jsonResponse({
          key: "/books/OL1M",
          title: "Date Check",
          publish_date: rawDate,
        });
      }
      if (u.startsWith("https://openlibrary.org/search.json?")) {
        return jsonResponse({ docs: [] });
      }
      throw new Error(`Unexpected URL: ${u}`);
    };
    const [c] = await identify({ title: "", authors: [], identifiers: { isbn: "9780000000001" } });
    assert.equal(c.pubdate, expectedIso, `pubdate mismatch for ${rawDate}`);
  }

  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.startsWith("https://openlibrary.org/search.json?")) {
      return jsonResponse({
        docs: [
          {
            key: "/works/OL_EN",
            title: "Crooked Plow",
            author_name: ["Itamar Vieira Junior"],
            language: ["eng"],
            first_publish_year: 2023,
            cover_i: 111,
          },
          {
            key: "/works/OL24141556W",
            title: "Torto Arado",
            author_name: ["Itamar Vieira Junior"],
            publisher: ["Todavia"],
            language: ["por", "eng"],
            first_publish_year: 2019,
            isbn: ["9786580309313"],
            cover_i: 12369648,
            edition_key: ["OL35663926M"],
          },
        ],
      });
    }
    if (u === "https://openlibrary.org/works/OL24141556W.json") {
      return jsonResponse({
        key: "/works/OL24141556W",
        description: "Romance no sertão baiano.",
        subjects: ["Literatura brasileira", "Ficção"],
      });
    }
    if (u === "https://openlibrary.org/works/OL_EN.json") {
      return jsonResponse({ key: "/works/OL_EN", description: "English edition." });
    }
    throw new Error(`Unexpected URL in test 3: ${u}`);
  };

  const ranked = await identify({
    title: "Torto Arado",
    authors: ["Itamar Vieira Junior"],
    identifiers: {},
    language: "pt",
  });
  assert.equal(ranked[0].id, "OL24141556W");
  assert.equal(ranked[0].description, "Romance no sertão baiano.");
  assert.deepEqual(ranked[0].tags, ["Literatura brasileira", "Ficção"]);
  assert.equal(ranked[0].pubdate, "2019");
  assert.equal(ranked[0].cover, "https://covers.openlibrary.org/b/id/12369648-L.jpg");

  // Search-box free-text fallback (?q=...) even when authors is empty + Brazilian ISBN preference when language is pt
  globalThis.fetch = async (url) => {
    const u = new URL(String(url));
    if (u.origin === "https://openlibrary.org" && u.pathname === "/search.json") {
      if (u.searchParams.has("title")) return jsonResponse({ docs: [] });
      if (u.searchParams.get("q") === "Condição Artificial Martha Wells") {
        return jsonResponse({
          docs: [
            {
              key: "/works/OL19747311W",
              title: "Artificial Condition",
              author_name: ["Martha Wells"],
              language: ["eng", "por"],
              first_publish_year: 2018,
              isbn: ["9781250186935", "9788576577263", "8576577267"],
              cover_i: 15129488,
            },
          ],
        });
      }
    }
    if (u.href === "https://openlibrary.org/works/OL19747311W.json") {
      return jsonResponse({ key: "/works/OL19747311W", description: "Murderbot #2." });
    }
    throw new Error(`Unexpected URL in free-text fallback test: ${u.href}`);
  };
  const fallbackOut = await identify({
    title: "Condição Artificial Martha Wells",
    authors: [],
    identifiers: {},
    language: "pt",
  });
  assert.equal(fallbackOut.length, 1);
  assert.equal(fallbackOut[0].id, "OL19747311W");
  assert.equal(fallbackOut[0].identifiers.isbn, "9788576577263");
}

// 4. HTTP 429 throws dalibre.error("rateLimited")
{
  globalThis.fetch = async () => jsonResponse({}, 429);
  await assert.rejects(
    () => identify({ title: "Dom Casmurro", authors: [], identifiers: {} }),
    (err) => err?.kind === "rateLimited",
  );
}

console.log("dalibre-openlibrary unit tests passed!");
