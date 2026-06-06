const fetch = require("@libs/fetch");
const cheerio = require("cheerio");
const { defaultCover } = require("@libs/defaultCover");
const { NovelStatus } = require("@libs/novelStatus");

/* ══════════════════════════════════════════
   Fuzzy Search Helper
   ══════════════════════════════════════════ */
class FuzzySearch {
  constructor(getItems, options = {}) {
    this.haystack = [];
    this.options = Object.assign({ caseSensitive: false, sort: false }, options);
    this.getItems = getItems;
  }

  getOptions() { return this.options; }
  setOptions(opts) { this.options = Object.assign(this.options, opts); }
  setHaystack(h) { this.haystack = h; }
  getHaystack() { return this.haystack; }

  search(query) {
    if (query.length === 0) return this.haystack;

    const results = [];

    for (const item of this.haystack) {
      for (const field of this.getItems(item)) {
        const score = this.isMatch(field, query);
        if (score !== undefined) {
          results.push({ item, score });
          break;
        }
      }
    }

    if (this.options.sort) {
      results.sort((a, b) => a.score - b.score);
    }

    return results.map(r => r.item);
  }

  isMatch(text, query) {
    if (!this.options.caseSensitive) {
      text  = text.toLocaleLowerCase();
      query = query.toLocaleLowerCase();
    }

    const indexes = this.nearestIndexesFor(text, query);
    if (indexes === undefined) return undefined;

    if (text === query) return 1;
    if (indexes.length > 1) return indexes[indexes.length - 1] - indexes[0] + 2;
    return 2 + indexes[0];
  }

  nearestIndexesFor(text, query) {
    const chars = query.split("");
    const candidates = [];

    for (const startIdx of this.idxFirstLetter(text, query)) {
      const run = [startIdx];

      for (let i = 1; i < chars.length; i++) {
        const pos = text.indexOf(chars[i], run[run.length - 1] + 1);
        if (pos === -1) { candidates.pop(); break; }
        run.push(pos);
      }

      if (run.length === chars.length) candidates.push(run);
    }

    if (candidates.length === 0) return undefined;

    return candidates.sort((a, b) => {
      if (a.length === 1) return a[0] - b[0];
      return (a[a.length - 1] - a[0]) - (b[b.length - 1] - b[0]);
    })[0];
  }

  idxFirstLetter(text, query) {
    return text
      .split("")
      .map((ch, i) => ch === query[0] ? i : undefined)
      .filter(i => i !== undefined);
  }
}

/* ══════════════════════════════════════════
   Re:Library Scraper
   ══════════════════════════════════════════ */
class ReLibrary {
  constructor() {
    this.id      = "ReLib+";
    this.name    = "Re:Library+";
    this.icon    = "src/en/relibrary/icon.png";
    this.site    = "https://re-library.com";
    this.version = "1.0.4";

    this.imageRequestInit = {
      headers: { Referer: "https://re-library.com/" },
    };

    this.searchFunc = new FuzzySearch(
      novel => [novel.name],
      { sort: true, caseSensitive: false }
    );
  }

  /* ── Internal: scrape the "most popular" list page ─────── */
  async popularNovelsInner(url) {
    const html = await (await fetchApi(url)).text();
    const $    = cheerio.load(html);
    const novels = [];

    $(".entry-content > ol > li").each((_, el) => {
      const name = $(el).find("h3 > a").text();
      let   path = $(el).find("table > tbody > tr > td > a").attr("href");

      if (!name || !path) return;

      const cover =
        $(el).find("table > tbody > tr > td > a > img").attr("data-cfsrc") ||
        $(el).find("table > tbody > tr > td > a > img").attr("src")        ||
        defaultCover;

      path = new URL(path, this.site).pathname;
      novels.push({ name, path, cover });
    });

    return novels;
  }

  /* ── Internal: scrape the "latest" list page ────────────── */
  async lastestNovelsInner(url) {
    const html = await (await fetchApi(url)).text();
    const $    = cheerio.load(html);
    const novels = [];

    $("article.type-page.page").each((_, el) => {
      const name = $(el).find(".entry-title").text();
      let   path = $(el).find(".entry-title a").attr("href");

      if (!path || !name) return;

      const cover =
        $(el).find(".entry-content > table > tbody > tr > td > a > img").attr("data-cfsrc") ||
        $(el).find(".entry-content > table > tbody > tr > td > a > img").attr("src")        ||
        defaultCover;

      path = new URL(path, this.site).pathname;
      novels.push({ name, path, cover });
    });

    return novels;
  }

  /* ── Public: popular / latest novel list ────────────────── */
  async popularNovels(page, { showLatestNovels }) {
    if (showLatestNovels) {
      return this.lastestNovelsInner(
        `${this.site}/tag/translations/page/${page}`
      );
    }

    // The "most popular" page is a single static page — only return on page 1
    if (page === 1) {
      return this.popularNovelsInner(`${this.site}/translations/most-popular/`);
    }

    return [];
  }

  /* ── Public: parse a novel's detail/chapter-list page ───── */
  async parseNovel(novelPath) {
    const html = await (await fetchApi(`${this.site}${novelPath}`)).text();
    const $    = cheerio.load(html);

    const novel = { path: novelPath };

    novel.name = $("header.entry-header > .entry-title").text().trim();
    if (!novel.name || novel.name === "404 – Page not found") {
      throw new Error(`Invalid novel for url ${novelPath}`);
    }

    novel.cover =
      $(".entry-content > table img").attr("data-cfsrc") ||
      $(".entry-content > table img").attr("src")        ||
      defaultCover;

    novel.status = NovelStatus.Unknown;

    // Parse status + genres from the info table
    $(".entry-content > table > tbody > tr > td > p").each((_, el) => {
      const label = $(el).find("strong").text().toLowerCase().trim();

      if (label.startsWith("status")) {
        $(el).find("strong").remove();
        const statusText = $(el).text().toLowerCase().trim();

        if      (statusText.includes("on-going"))  novel.status = NovelStatus.Ongoing;
        else if (statusText.includes("completed")) novel.status = NovelStatus.Completed;
        else if (statusText.includes("hiatus"))    novel.status = NovelStatus.OnHiatus;
        else if (statusText.includes("cancelled")) novel.status = NovelStatus.Cancelled;
        else                                        novel.status = cheerio.load(el).text();

      } else if (label.startsWith("category")) {
        $(el).find("strong").remove();
        novel.genres = $(el).text();
      }
    });

    novel.summary = $(
      ".entry-content > div.su-box > div.su-box-content"
    ).text();

    // Collect chapters from accordions
    const chapters = [];
    let chapterNumber = 0;

    $(".entry-content > div.su-accordion").each((_, accordion) => {
      $(accordion).find("li > a").each((_, link) => {
        chapterNumber++;
        const href = $(link).attr("href")?.trim();
        const name = $(link).text();

        if (name && href) {
          chapters.push({
            name,
            path:          new URL(href, this.site).pathname,
            chapterNumber,
            releaseTime:   null,
          });
        }
      });
    });

    novel.chapters = chapters;
    return novel;
  }

  /* ── Public: parse a single chapter's content ───────────── */
  async parseChapter(chapterPath) {
    const html = await (await fetchApi(`${this.site}${chapterPath}`)).text();
    const $    = cheerio.load(html);

    // ── Title ────────────────────────────────────────────────
    // Grab from the page <h1> rather than the entry-content so
    // we always get a clean string regardless of content layout.
    const title = $("header.entry-header .entry-title").text().trim()
               || $("h1.entry-title").text().trim();

    // ── Content container ────────────────────────────────────
    const content = $(".entry-content");

    // ── Strip: metadata tables at the top ───────────────────
    // The page opens with two tables before the prose:
    //   1. Author / Translator / Source table
    //   2. Project GB / Ko-fi support banner table
    // Both sit as direct children of .entry-content and appear
    // before any <p> text, so we remove all leading <table>
    // elements until we hit a non-table direct child.
    content.children("table").each((_, el) => {
      // Only remove tables that come before the first <p>,
      // i.e. the header metadata tables, not in-story stat tables.
      const prevSiblings = $(el).prevAll("p");
      if (prevSiblings.length === 0) $(el).remove();
    });

    // ── Strip: top navigation block ──────────────────────────
    // Structure: [p.nav-links] [hr] — sits at the very top of
    // .entry-content (after the now-removed metadata tables).
    // We remove every direct child up to and including the first
    // <hr> that has no prose <p> before it.
    let foundFirstHr = false;
    content.children().each((_, el) => {
      if (foundFirstHr) return;           // stop once we've passed the hr
      if ($(el).is("hr")) {
        $(el).remove();
        foundFirstHr = true;
        return;
      }
      // Only strip nav-like elements (links, paragraphs with only
      // anchor tags). Leave anything that looks like actual prose.
      const text = $(el).text().trim();
      const hasOnlyAnchors =
        $(el).children().length > 0 &&
        $(el).children().length === $(el).find("a").length;
      const isNavParagraph = $(el).is("p") && (hasOnlyAnchors || text === "");

      if (isNavParagraph || $(el).is("p:empty") || $(el).is("div:empty")) {
        $(el).remove();
      }
    });

    // ── Strip: bottom navigation block ───────────────────────
    // Structure: [hr] [p.nav-links] — sits at the very bottom of
    // the content area, followed by share/support/comment junk.
    // Strategy: find the last <hr> and remove it plus everything after it.
    const allHrs = content.find("hr");
    const lastHr = allHrs.last();

    if (lastHr.length) {
      // Remove everything after the last <hr>
      let after = lastHr.next();
      while (after.length) {
        const next = after.next();
        after.remove();
        after = next;
      }
      lastHr.remove();
    }

    // ── Strip: trailing junk (views counter, share div, etc.) ─
    // These appear as direct children after the prose and are
    // identified by class names Re:Library consistently uses.
    const junkSelectors = [
      ".post-views",         // "Views: N"
      ".sharedaddy",         // share buttons
      ".jp-relatedposts",    // related posts
      ".wpcnt",              // ad placeholder
      "div[id^='jp-']",     // Jetpack widgets
      "#respond",            // comment form
    ];
    content.find(junkSelectors.join(", ")).remove();

    // ── Build final HTML ─────────────────────────────────────
    // Prepend the chapter title as an <h1> so LNReader can
    // display it, then return the cleaned content.
    const titleHtml = title ? `<h1>${title}</h1>` : "";
    return titleHtml + (content.html() || "");
  }

  /* ── Public: search novels by title ─────────────────────── */
  async searchNovels(query, page) {
    // Search index is a single page — only fetch on page 1
    if (page !== 1) return [];

    const html = await (await fetchApi(`${this.site}/translations/`)).text();
    const $    = cheerio.load(html);
    const novels = [];

    $("article article").each((_, el) => {
      const $el = $(el);
      const href = $el.find("a").attr("href");
      const name = $el.find("a").text();

      if (!href || !name) return;

      novels.push({
        name,
        path:  new URL(href, this.site).pathname,
        cover: $el.find("img").attr("data-cfsrc") ||
               $el.find("img").attr("src")        ||
               defaultCover,
      });
    });

    this.searchFunc.setHaystack(novels);
    return this.searchFunc.search(query);
  }
}

exports.default = new ReLibrary();
