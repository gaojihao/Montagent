/**
 * Stock media source registry (TS port of stock_sources/__init__.py).
 * Explicit adapter index (replaces Python's pkgutil auto-discovery).
 * All 16 Python adapters are ported.
 */
import { Candidate, makeSearchFilters, type SearchFilters, type StockSource } from "./base.js";
import { PexelsSource } from "./pexels.js";
import { ArchiveOrgSource } from "./archive_org.js";
import { PixabayVideoSource } from "./pixabay_video.js";
import { UnsplashSource } from "./unsplash.js";
import { CoverrSource } from "./coverr.js";
import { VidevoSource } from "./videvo.js";
import { NasaSource } from "./nasa.js";
import { WikimediaSource } from "./wikimedia.js";
import { Pond5PublicDomainSource } from "./pond5_pd.js";
import { DarefulSource } from "./dareful.js";
import { MixkitSource } from "./mixkit.js";
import { NARASource } from "./nara.js";
import { LibraryOfCongressSource } from "./loc.js";
import { NOAASource } from "./noaa.js";
import { ESASource } from "./esa.js";
import { JAXASource } from "./jaxa.js";

export { Candidate, makeSearchFilters };
export type { SearchFilters, StockSource };

interface SourceClass {
  new (): StockSource;
  display_name?: string;
  provider?: string;
  install_instructions?: string;
  supports?: Record<string, unknown>;
  priority?: number;
}

const ALL_SOURCE_CLASSES: SourceClass[] = [
  PexelsSource,
  ArchiveOrgSource,
  PixabayVideoSource,
  UnsplashSource,
  CoverrSource,
  VidevoSource,
  NasaSource,
  WikimediaSource,
  Pond5PublicDomainSource,
  DarefulSource,
  MixkitSource,
  NARASource,
  LibraryOfCongressSource,
  NOAASource,
  ESASource,
  JAXASource,
];

function sortedClasses(): SourceClass[] {
  return [...ALL_SOURCE_CLASSES].sort((a, b) => {
    const pa = a.priority ?? 100;
    const pb = b.priority ?? 100;
    if (pa !== pb) return pa - pb;
    const na = (a.display_name ?? new a().name).toLowerCase();
    const nb = (b.display_name ?? new b().name).toLowerCase();
    return na < nb ? -1 : na > nb ? 1 : 0;
  });
}

export function allSources(): StockSource[] {
  return sortedClasses().map((cls) => new cls());
}

export function availableSources(): StockSource[] {
  return allSources().filter((s) => s.isAvailable());
}

export function getSource(name: string): StockSource {
  for (const s of allSources()) if (s.name === name) return s;
  throw new Error(`No stock source registered with name=${JSON.stringify(name)}`);
}

export function sourceCatalog(): Array<Record<string, unknown>> {
  return sortedClasses().map((cls) => {
    const s = new cls();
    return {
      name: s.name,
      display_name: cls.display_name ?? s.name,
      provider: cls.provider ?? s.name,
      status: s.isAvailable() ? "available" : "unavailable",
      install_instructions: cls.install_instructions ?? "See the source adapter docs for setup details.",
      supports: cls.supports ?? {},
    };
  });
}

export function sourceSummary(): Record<string, unknown> {
  const catalog = sourceCatalog();
  const available = catalog.filter((e) => e.status === "available").map((e) => e.name);
  const unavailable = catalog.filter((e) => e.status !== "available").map((e) => e.name);
  return {
    configured: available.length,
    total: catalog.length,
    available_source_names: available,
    unavailable_source_names: unavailable,
  };
}
