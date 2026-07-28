"use client";

import { ExternalLink, Menu, Moon, Search, Sun, X } from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";

type NavDoc = {
  slug: string;
  title: string;
  section: string;
  description: string;
};

type Heading = { id: string; label: string };

export function DocsShell({
  activeSlug,
  docs,
  headings,
  previous,
  next,
  children,
}: {
  activeSlug: string;
  docs: NavDoc[];
  headings: Heading[];
  previous?: { slug: string; title: string };
  next?: { slug: string; title: string };
  children: React.ReactNode;
}) {
  const [navOpen, setNavOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [dark, setDark] = useState(false);
  const searchInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const stored = window.localStorage.getItem("liveprobe-docs-theme");
    const nextDark =
      stored === "dark" ||
      (stored === null &&
        window.matchMedia("(prefers-color-scheme: dark)").matches);
    setDark(nextDark);
    document.documentElement.dataset.theme = nextDark ? "dark" : "light";
  }, []);

  useEffect(() => {
    if (searchOpen) searchInput.current?.focus();
  }, [searchOpen]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setSearchOpen(true);
      }
      if (event.key === "Escape") {
        setSearchOpen(false);
        setNavOpen(false);
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const sections = useMemo(
    () =>
      Array.from(new Set(docs.map((doc) => doc.section))).map((section) => ({
        section,
        docs: docs.filter((doc) => doc.section === section),
      })),
    [docs],
  );

  const results = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return docs;
    return docs.filter(
      (doc) =>
        doc.title.toLowerCase().includes(needle) ||
        doc.description.toLowerCase().includes(needle) ||
        doc.section.toLowerCase().includes(needle),
    );
  }, [docs, query]);

  function toggleTheme() {
    const nextDark = !dark;
    setDark(nextDark);
    document.documentElement.dataset.theme = nextDark ? "dark" : "light";
    window.localStorage.setItem(
      "liveprobe-docs-theme",
      nextDark ? "dark" : "light",
    );
  }

  return (
    <div className="site-shell">
      <header className="topbar">
        <div className="topbar-inner">
          <button
            type="button"
            className="icon-button mobile-only"
            onClick={() => setNavOpen(true)}
            aria-label="Open navigation"
            title="Open navigation"
          >
            <Menu size={20} />
          </button>
          <Link className="brand" href="/docs/quickstart">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/liveprobe-mark.svg" alt="" width="32" height="32" />
            <span>LiveProbe</span>
            <small>Docs</small>
          </Link>
          <button
            type="button"
            className="search-trigger"
            onClick={() => setSearchOpen(true)}
            aria-label="Search documentation"
          >
            <Search size={17} />
            <span>Search documentation</span>
            <kbd>⌘K</kbd>
          </button>
          <div className="topbar-actions">
            <a
              className="github-link"
              href="https://github.com/mohammed2945/LiveProbe"
              target="_blank"
              rel="noreferrer"
            >
              GitHub <ExternalLink size={14} />
            </a>
            <span className="version-badge">v0.3.0</span>
            <button
              type="button"
              className="icon-button"
              onClick={toggleTheme}
              aria-label={dark ? "Use light theme" : "Use dark theme"}
              title={dark ? "Use light theme" : "Use dark theme"}
            >
              {dark ? <Sun size={18} /> : <Moon size={18} />}
            </button>
          </div>
        </div>
      </header>

      <aside className={`sidebar ${navOpen ? "sidebar-open" : ""}`}>
        <div className="mobile-nav-head">
          <span>Documentation</span>
          <button
            type="button"
            className="icon-button"
            onClick={() => setNavOpen(false)}
            aria-label="Close navigation"
            title="Close navigation"
          >
            <X size={20} />
          </button>
        </div>
        <nav aria-label="Documentation">
          {sections.map(({ section, docs: sectionDocs }) => (
            <div className="nav-section" key={section}>
              <p>{section}</p>
              {sectionDocs.map((doc) => (
                <Link
                  key={doc.slug}
                  href={`/docs/${doc.slug}`}
                  className={doc.slug === activeSlug ? "active" : ""}
                  onClick={() => setNavOpen(false)}
                >
                  {doc.title}
                </Link>
              ))}
            </div>
          ))}
        </nav>
      </aside>
      {navOpen && (
        <button
          type="button"
          className="nav-backdrop"
          onClick={() => setNavOpen(false)}
          aria-label="Close navigation"
        />
      )}

      <main className="main-content">
        <article>{children}</article>
        <nav className="page-nav" aria-label="Adjacent documentation pages">
          {previous ? (
            <Link href={`/docs/${previous.slug}`}>
              <small>← Previous</small>
              <strong>{previous.title}</strong>
            </Link>
          ) : (
            <span />
          )}
          {next && (
            <Link href={`/docs/${next.slug}`} className="page-nav-next">
              <small>Next →</small>
              <strong>{next.title}</strong>
            </Link>
          )}
        </nav>
      </main>

      <aside className="toc">
        <p>On this page</p>
        <nav aria-label="On this page">
          {headings.map((heading) => (
            <a key={heading.id} href={`#${heading.id}`}>
              {heading.label}
            </a>
          ))}
        </nav>
      </aside>

      {searchOpen && (
        <div
          className="search-overlay"
          role="dialog"
          aria-modal="true"
          aria-label="Search documentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setSearchOpen(false);
          }}
        >
          <div className="search-dialog">
            <div className="search-input-row">
              <Search size={19} />
              <input
                ref={searchInput}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search documentation"
                aria-label="Search documentation"
              />
              <button
                type="button"
                className="escape-button"
                onClick={() => setSearchOpen(false)}
                aria-label="Close search"
                title="Close search"
              >
                esc
              </button>
            </div>
            <div className="search-results">
              {results.length ? (
                results.map((doc) => (
                  <Link
                    key={doc.slug}
                    href={`/docs/${doc.slug}`}
                    onClick={() => setSearchOpen(false)}
                  >
                    <span>
                      <strong>{doc.title}</strong>
                      <em>{doc.section}</em>
                    </span>
                    <small>{doc.description}</small>
                  </Link>
                ))
              ) : (
                <p className="no-results">No matching documentation.</p>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
