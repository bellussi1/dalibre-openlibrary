// @ts-check
// Open Library metadata source plugin for Dalibre.
// Uses the public Open Library API (Works, Editions, Search, and Covers):
// https://openlibrary.org/developers/api

const API = "https://openlibrary.org";
const COVERS = "https://covers.openlibrary.org";
const SEARCH_FIELDS = [
  "key",
  "title",
  "subtitle",
  "author_name",
  "publisher",
  "first_publish_year",
  "publish_year",
  "isbn",
  "language",
  "subject",
  "cover_i",
  "edition_key",
  "number_of_pages_median",
  "id_wikidata",
  "id_goodreads",
].join(",");

/** @type {Record<string, string>} */
const MONTHS = {
  jan: "01", january: "01",
  feb: "02", february: "02",
  mar: "03", march: "03",
  apr: "04", april: "04",
  may: "05",
  jun: "06", june: "06",
  jul: "07", july: "07",
  aug: "08", august: "08",
  sep: "09", sept: "09", september: "09",
  oct: "10", october: "10",
  nov: "11", november: "11",
  dec: "12", december: "12",
};

/** @type {Record<string, string>} */
const ISO2_TO_3 = {
  pt: "por", en: "eng", es: "spa", fr: "fre", de: "ger", it: "ita",
  ja: "jpn", zh: "chi", ko: "kor", ru: "rus",
};

/**
 * Look up book metadata candidates in Open Library.
 * @param {Dalibre.Book} book
 * @returns {Promise<Dalibre.Candidate[]>}
 */
export async function identify(book) {
  const max = clampInt(dalibre.settings.maxResults, 10, 1, 20);
  const ids = book?.identifiers ?? {};
  const authors = book?.authors ?? [];
  const title = (book?.title ?? "").trim();

  const olId = (ids.openlibrary ?? "").trim();
  if (/^OL\d+M$/i.test(olId)) {
    const edition = await getJSON(`${API}/books/${olId.toUpperCase()}.json`, true);
    if (edition) {
      const c = await editionToCandidate(edition);
      if (c) return [c];
    }
  } else if (/^OL\d+W$/i.test(olId)) {
    const work = await getJSON(`${API}/works/${olId.toUpperCase()}.json`, true);
    if (work) {
      const edData = await getJSON(`${API}/works/${olId.toUpperCase()}/editions.json?limit=3`, true);
      const edition = edData?.entries?.[0] ?? null;
      const c = await workToCandidate(work, edition);
      if (c) return [c];
    }
  }

  const isbn = cleanISBN(ids.isbn ?? "");
  if (isbn) {
    const [edition, searchData] = await Promise.all([
      getJSON(`${API}/isbn/${isbn}.json`, true),
      getJSON(`${API}/search.json?${new URLSearchParams({ isbn, fields: SEARCH_FIELDS, limit: String(max) })}`, false),
    ]);
    /** @type {Dalibre.Candidate[]} */
    const out = [];
    const seen = new Set();
    const docs = /** @type {any[]} */ (searchData?.docs ?? []);
    if (edition) {
      const exact = await editionToCandidate(edition, docs[0]?.author_name);
      if (exact) {
        out.push(exact);
        seen.add(exact.id);
      }
    }
    if (out.length < max && docs.length > 0) {
      const workMap = await fetchWorks(docs.slice(0, Math.min(docs.length, 4)));
      for (const doc of docs) {
        if (out.length >= max) break;
        const c = docToCandidate(doc, workMap.get(doc.key));
        if (c && !seen.has(c.id) && (out.length === 0 || !doc.edition_key?.includes(out[0].id))) {
          out.push(c);
          seen.add(c.id);
        }
      }
    }
    if (out.length > 0) return out;
  }

  if (!title) return [];

  const firstAuthor = authors[0]?.trim() ?? "";
  /** @type {Record<string, string>} */
  const params = { title, fields: SEARCH_FIELDS, limit: String(Math.min(max * 2, 25)) };
  if (firstAuthor) params.author = firstAuthor;

  let data = await getJSON(`${API}/search.json?${new URLSearchParams(params)}`, false);
  let docs = /** @type {any[]} */ (data?.docs ?? []);
  if (docs.length === 0) {
    const q = firstAuthor ? `${title} ${firstAuthor}` : title;
    data = await getJSON(`${API}/search.json?${new URLSearchParams({ q, fields: SEARCH_FIELDS, limit: String(Math.min(max * 2, 25)) })}`, false);
    docs = /** @type {any[]} */ (data?.docs ?? []);
  }
  if (docs.length === 0) return [];

  const ranked = docs
    .filter((d) => d?.key && d?.title)
    .map((d, i) => ({ d, s: scoreDoc(d, title, authors, book?.language) - i * 0.01 }))
    .sort((a, b) => b.s - a.s)
    .slice(0, max)
    .map((x) => x.d);

  const workMap = await fetchWorks(ranked.slice(0, 5));
  /** @type {Dalibre.Candidate[]} */
  const out = [];
  const seen = new Set();
  for (const doc of ranked) {
    const c = docToCandidate(doc, workMap.get(doc.key), book?.language);
    if (c && !seen.has(c.id)) {
      seen.add(c.id);
      out.push(c);
    }
  }
  return out;
}

/**
 * Fetch GET URL as JSON. Throws dalibre errors on 429/5xx/bad JSON.
 * @param {string} url @param {boolean} missingOK
 * @returns {Promise<any>}
 */
async function getJSON(url, missingOK) {
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (res.status === 404 && missingOK) return null;
  if (res.status === 429) throw dalibre.error("rateLimited", "Open Library asks to slow down. Try again in a minute.");
  if (res.status >= 500) throw dalibre.error("unavailable", `Open Library answered ${res.status}.`);
  if (!res.ok) throw new Error(`Open Library answered ${res.status} ${res.statusText}`);
  try {
    return await res.json();
  } catch {
    throw dalibre.error("unavailable", "Open Library sent something that isn’t JSON.");
  }
}

/**
 * Enrich an edition JSON record with its work and author records.
 * @param {any} edition @param {string[]} [fallbackAuthors]
 * @returns {Promise<Dalibre.Candidate | null>}
 */
async function editionToCandidate(edition, fallbackAuthors = []) {
  const id = keyTail(edition.key);
  if (!id || !edition.title) return null;

  const workKey = edition.works?.[0]?.key;
  const work = typeof workKey === "string" && workKey.startsWith("/works/") ? await getJSON(`${API}${workKey}.json`, true) : null;
  const authors = await resolveAuthorNames(edition.authors ?? work?.authors, fallbackAuthors);
  return buildCandidateFromRecords(id, edition, work, authors, `/books/${id}`);
}

/**
 * Build a candidate from a work record and optional representative edition.
 * @param {any} work @param {any} edition
 * @returns {Promise<Dalibre.Candidate | null>}
 */
async function workToCandidate(work, edition) {
  const id = keyTail(work.key);
  if (!id || !work.title) return null;
  const authors = await resolveAuthorNames(edition?.authors ?? work.authors);
  return buildCandidateFromRecords(id, edition ?? {}, work, authors, `/works/${id}`);
}

/**
 * Merge edition and work JSON fields into a Dalibre Candidate.
 * @param {string} id @param {any} edition @param {any} work @param {string[]} authors @param {string} path
 * @returns {Dalibre.Candidate}
 */
function buildCandidateFromRecords(id, edition, work, authors, path) {
  const title = String(edition.title || work?.title || "").trim();
  const coverId = firstPositiveCover(edition.covers) ?? firstPositiveCover(work?.covers);
  const rawSeries = Array.isArray(edition.series) ? edition.series[0] : undefined;
  const parsedSeries = typeof rawSeries === "string" ? parseSeries(rawSeries) : {};

  /** @type {Record<string, string>} */
  const identifiers = { openlibrary: id };
  const isbn = cleanISBN(edition.isbn_13?.[0] ?? edition.isbn_10?.[0] ?? "");
  if (isbn) identifiers.isbn = isbn;
  const wd = edition.identifiers?.wikidata?.[0];
  if (wd) identifiers.wd = String(wd);
  const gr = edition.identifiers?.goodreads?.[0];
  if (gr) identifiers.goodreads = String(gr);
  const goog = edition.identifiers?.google?.[0];
  if (goog) identifiers.google = String(goog);

  /** @type {Dalibre.Field[]} */
  const fields = [];
  if (edition.subtitle) fields.push({ label: "Subtitle", value: String(edition.subtitle).trim() });
  const translators = (edition.contributors ?? [])
    .filter((/** @type {any} */ c) => /translat|tradut/i.test(String(c?.role ?? "")) && c?.name)
    .map((/** @type {any} */ c) => String(c.name).trim());
  if (translators.length) fields.push({ label: "Translators", value: translators.join(", ") });
  const pages = edition.number_of_pages ? String(edition.number_of_pages) : parsePageCount(edition.pagination);
  if (pages) fields.push({ label: "Pages", value: pages });
  if (edition.edition_name) fields.push({ label: "Edition", value: String(edition.edition_name).trim() });

  const langKey = edition.languages?.[0]?.key ?? work?.languages?.[0]?.key;
  const language = typeof langKey === "string" ? langKey.split("/").pop() : undefined;
  const pubdate = parsePubDate(edition.publish_date ?? work?.first_publish_date);
  const description = cleanDescription(work?.description ?? edition.description);
  const rawSubjects = work?.subjects ?? edition.subjects ?? [];

  return {
    id,
    title,
    authors,
    description,
    publisher: edition.publishers?.[0] ? String(edition.publishers[0]).trim() : undefined,
    language: language || undefined,
    pubdate,
    series: parsedSeries.series,
    seriesIndex: parsedSeries.seriesIndex,
    tags: cleanTags(rawSubjects),
    identifiers,
    cover: coverId ? `${COVERS}/b/id/${coverId}-L.jpg` : undefined,
    url: `${API}${path}`,
    fields: fields.slice(0, 12),
  };
}

/**
 * Fetch author display names from Open Library author key references.
 * @param {any[] | undefined} refs @param {string[]} [fallback]
 * @returns {Promise<string[]>}
 */
async function resolveAuthorNames(refs, fallback = []) {
  const keys = (refs ?? [])
    .map((r) => r?.author?.key ?? r?.key)
    .filter((/** @type {unknown} */ k) => typeof k === "string" && k.startsWith("/authors/"))
    .slice(0, 5);
  if (!keys.length) return fallback.filter(Boolean);
  const loaded = await Promise.all(keys.map((k) => getJSON(`${API}${k}.json`, true)));
  const names = loaded.map((a) => String(a?.name ?? "").trim()).filter(Boolean);
  return names.length ? names : fallback.filter(Boolean);
}

/**
 * Fetch up to 5 Open Library work records in parallel for richer descriptions and tags.
 * @param {any[]} docs
 * @returns {Promise<Map<string, any>>}
 */
async function fetchWorks(docs) {
  const keys = [...new Set(docs.map((d) => d.key).filter((k) => typeof k === "string" && k.startsWith("/works/")))];
  const entries = await Promise.all(keys.map(async (k) => [k, await getJSON(`${API}${k}.json`, true)]));
  return new Map(entries);
}

/**
 * Convert a Search API document (optionally enriched with its Work record) into a Candidate.
 * @param {any} doc @param {any} [work] @param {string} [preferredLang]
 * @returns {Dalibre.Candidate | null}
 */
function docToCandidate(doc, work, preferredLang) {
  const id = keyTail(doc.key);
  if (!id || !doc.title) return null;

  /** @type {Record<string, string>} */
  const identifiers = { openlibrary: id };
  const isbns = /** @type {string[]} */ (doc.isbn ?? []).map(cleanISBN).filter(Boolean);
  const preferPt = Boolean(preferredLang && langMatches(preferredLang, "por"));
  const brIsbn = preferPt
    ? isbns.find((i) => i.startsWith("97865") || i.startsWith("97885")) ??
      isbns.find((i) => i.length === 10 && (i.startsWith("65") || i.startsWith("85")))
    : undefined;
  const bestIsbn = brIsbn ?? isbns.find((i) => i.length === 13) ?? isbns[0];
  if (bestIsbn) identifiers.isbn = bestIsbn;
  if (doc.id_wikidata?.[0]) identifiers.wd = String(doc.id_wikidata[0]);
  if (doc.id_goodreads?.[0]) identifiers.goodreads = String(doc.id_goodreads[0]);

  /** @type {Dalibre.Field[]} */
  const fields = [];
  if (doc.subtitle) fields.push({ label: "Subtitle", value: String(doc.subtitle).trim() });
  if (doc.number_of_pages_median) fields.push({ label: "Pages", value: String(doc.number_of_pages_median) });
  if (doc.edition_key?.[0]) fields.push({ label: "Edition", value: String(doc.edition_key[0]) });

  const lang = pickLanguage(doc.language, preferredLang);
  const year = doc.first_publish_year ?? doc.publish_year?.[0];

  return {
    id,
    title: String(doc.title).trim(),
    authors: (doc.author_name ?? []).map((/** @type {string} */ a) => String(a).trim()).filter(Boolean),
    description: cleanDescription(work?.description),
    publisher: doc.publisher?.[0] ? String(doc.publisher[0]).trim() : undefined,
    language: lang,
    pubdate: year ? parsePubDate(String(year)) : undefined,
    tags: cleanTags(work?.subjects ?? doc.subject ?? []),
    identifiers,
    cover: doc.cover_i > 0 ? `${COVERS}/b/id/${doc.cover_i}-L.jpg` : undefined,
    url: `${API}${doc.key}`,
    fields: fields.slice(0, 12),
  };
}

/**
 * Rank Search API documents against user's book metadata.
 * @param {any} doc @param {string} title @param {string[]} authors @param {string | undefined} language
 */
function scoreDoc(doc, title, authors, language) {
  const want = norm(title);
  const t = norm(doc.title);
  const full = doc.subtitle ? norm(`${doc.title} ${doc.subtitle}`) : t;
  let s = 0;
  if (t === want || full === want) s += 4;
  else if (t.startsWith(want) || want.startsWith(t)) s += 1;
  else if (t.includes(want) || want.includes(t)) s += 0.5;

  const theirs = (doc.author_name ?? []).map(norm);
  if (authors.some((a) => theirs.some((/** @type {string} */ x) => x.includes(norm(a)) || norm(a).includes(x) || sameName(x, norm(a))))) s += 1.5;

  if (language) {
    const langs = (doc.language ?? []).map((/** @type {string} */ l) => l.toLowerCase());
    if (langs.some((/** @type {string} */ l) => langMatches(l, language))) s += 1.0;
  }
  if (doc.cover_i > 0) s += 0.3;
  return s;
}

/** @param {string[] | undefined} langs @param {string | undefined} preferred */
function pickLanguage(langs, preferred) {
  if (!Array.isArray(langs) || langs.length === 0) return undefined;
  if (preferred) {
    const found = langs.find((l) => langMatches(l.toLowerCase(), preferred));
    if (found) return found;
  }
  return String(langs[0]);
}

/** @param {string} a @param {string} b */
function langMatches(a, b) {
  const n = (/** @type {string} */ s) => {
    const code = s.toLowerCase().split(/[-_]/)[0];
    return ISO2_TO_3[code] ?? code;
  };
  return n(a) === n(b);
}

/**
 * Normalize Open Library publish_date values into YYYY, YYYY-MM, or YYYY-MM-DD.
 * @param {string | undefined} raw
 * @returns {string | undefined}
 */
function parsePubDate(raw) {
  if (!raw) return undefined;
  const s = String(raw).trim();
  let m;
  if ((m = /^(\d{4}-\d{2}-\d{2})(?:T.*)?$/.exec(s))) return m[1];
  if ((m = /^(\d{4}-\d{2})$/.exec(s))) return m[1];
  if ((m = /^[\[(c.\s]*(\d{4})[\]).?\s]*$/i.exec(s))) return m[1];
  if ((m = /^([A-Za-z]+)\.?\s+(\d{1,2}),?\s+(\d{4})$/.exec(s))) {
    const mon = MONTHS[m[1].toLowerCase()];
    if (mon) return `${m[3]}-${mon}-${m[2].padStart(2, "0")}`;
  }
  if ((m = /^(\d{1,2})\s+([A-Za-z]+)\.?,?\s+(\d{4})$/.exec(s))) {
    const mon = MONTHS[m[2].toLowerCase()];
    if (mon) return `${m[3]}-${mon}-${m[1].padStart(2, "0")}`;
  }
  if ((m = /^([A-Za-z]+)\.?,?\s+(\d{4})$/.exec(s))) {
    const mon = MONTHS[m[1].toLowerCase()];
    if (mon) return `${m[2]}-${mon}`;
  }
  if ((m = /\b(1[4-9]\d{2}|20\d{2})\b/.exec(s))) return m[1];
  return undefined;
}

/** @param {string} raw @returns {{ series?: string, seriesIndex?: number }} */
function parseSeries(raw) {
  const s = raw.trim();
  if (!s) return {};
  const m = /^(.*?)(?:\s*,\s*|\s+)(?:#|no\.?\s*|n[º°]\.?\s*|vol\.?\s*|book\s*|livro\s*)(\d+(?:\.\d+)?)\s*$/i.exec(s);
  if (m && m[1].trim()) {
    return { series: m[1].trim(), seriesIndex: Number(m[2]) };
  }
  return { series: s };
}

/** @param {any} desc */
function cleanDescription(desc) {
  const text = typeof desc === "string" ? desc : desc?.value ?? "";
  if (!text) return undefined;
  const cleaned = String(text)
    .replace(/\r\n?/g, "\n")
    .replace(/\n\s*-{4,}[\s\S]*$/, "")
    .trim();
  return cleaned || undefined;
}

/** @param {string[]} list */
function cleanTags(list) {
  const seen = new Set();
  for (const raw of list) {
    const t = String(raw ?? "").replace(/--/g, " · ").trim();
    if (t && !seen.has(t)) {
      seen.add(t);
      if (seen.size >= 10) break;
    }
  }
  return [...seen];
}

/** @param {string | undefined} pagination */
function parsePageCount(pagination) {
  if (!pagination) return undefined;
  const m = /\b(\d{1,5})\s*(?:p\.?|pages?|páginas?)\b/i.exec(String(pagination));
  return m ? m[1] : undefined;
}

/** @param {number[] | undefined} covers */
function firstPositiveCover(covers) {
  return Array.isArray(covers) ? covers.find((n) => typeof n === "number" && n > 0) : undefined;
}

/** @param {string | undefined} key */
function keyTail(key) {
  return typeof key === "string" ? key.split("/").filter(Boolean).pop() ?? "" : "";
}

/** @param {string} raw */
function cleanISBN(raw) {
  const s = String(raw).replace(/[^0-9Xx]/g, "").toUpperCase();
  return s.length === 10 || s.length === 13 ? s : "";
}

/** @param {string} s */
function norm(s) {
  return String(s ?? "").toLowerCase().normalize("NFKC").replace(/[\s\p{P}\p{S}]+/gu, "");
}

/** @param {string} a @param {string} b */
function sameName(a, b) {
  return a.length > 3 && a.length === b.length && [...a].sort().join("") === [...b].sort().join("");
}

/** @param {string | undefined} raw @param {number} fallback @param {number} min @param {number} max */
function clampInt(raw, fallback, min, max) {
  const n = parseInt(raw || String(fallback), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}
