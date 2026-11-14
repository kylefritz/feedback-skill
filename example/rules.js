// What worker.js accepts. Kept out of worker.js because a Worker's main module may only
// export handlers: workerd refuses to start on `export const` there.
import catalog from './public/pages.json' with { type: 'json' };

// The whitelist is the catalog, so a new page can't be forgotten here (tests check it too).
export const PAGES = new Set(catalog.pages.map(p => p.name));
export const MAX_BODY = 4000, MAX_IMAGE = 1_500_000, MAX_PINS = 40, MAX_VIEW = 300;
