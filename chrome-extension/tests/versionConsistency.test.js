/**
 * The version the USER sees must match the version that shipped.
 *
 * manifest.json and package.json were bumped to 14.0 while the Help & Docs tab
 * still read "Complete guide to QAtalyst v13.4" with a What's New section that
 * predated three releases. A docs page describing an older build is worse than no
 * version at all: it tells people features exist that do not, and hides the ones
 * that do. Nothing enforced the link, so it drifted silently.
 */
const fs = require('fs');
const path = require('path');

const EXT = path.resolve(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(EXT, 'manifest.json'), 'utf8'));
const pkg = JSON.parse(fs.readFileSync(path.join(EXT, '..', 'package.json'), 'utf8'));
const optionsHtml = fs.readFileSync(path.join(EXT, 'options.html'), 'utf8');

describe('version consistency', () => {
  test('manifest.json and package.json agree', () => {
    expect(pkg.version).toBe(manifest.version);
  });

  test('the Help tab states the version that actually shipped', () => {
    const intro = optionsHtml.match(/Complete guide to QAtalyst v([\d.]+)/);
    expect(intro).toBeTruthy();
    expect(intro[1]).toBe(manifest.version);
  });

  test("the What's New heading names the current version", () => {
    const heading = optionsHtml.match(/What's New in v([\d.]+)/);
    expect(heading).toBeTruthy();
    expect(heading[1]).toBe(manifest.version);
  });

  test('the current release documents what this version actually changed', () => {
    const v = manifest.version.replace('.', '\\.');
    const start = optionsHtml.search(new RegExp(`What's New in v${v}`));
    expect(start).toBeGreaterThan(-1);
    // Take the current-release block, up to where older releases are listed.
    const block = optionsHtml.slice(start, start + 6000);
    // Features shipped in 14.0 — a stale block would mention none of them.
    for (const feature of [/Ollama/i, /reasoning model/i, /incremental/i]) {
      expect(block).toMatch(feature);
    }
  });

  test('older releases remain listed as history, not as new', () => {
    // Previous versions are legitimate changelog entries; they just must not be
    // labelled NEW alongside the current one.
    const newTags = [...optionsHtml.matchAll(/\(NEW - v([\d.]+)\)/g)].map(m => m[1]);
    for (const tag of newTags) expect(tag).toBe(manifest.version);
  });
});
