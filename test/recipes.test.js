// Validates every recipe in recipes/ against the bundled slot list, so a
// bad pull request fails before review.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const { loadBundledSchema } = require("../src/core/schema");
const { validateRecipe, MAX_RECIPE_BYTES } = require("../src/core/recipe");

const root = path.join(__dirname, "..", "recipes");
const files = [];
(function walk(dir) {
  for (const n of fs.readdirSync(dir)) {
    const p = path.join(dir, n);
    if (fs.statSync(p).isDirectory()) walk(p); else files.push(p);
  }
})(root);

for (const f of files) {
  test(`recipe ${path.relative(root, f)}`, () => {
    assert.ok(f.endsWith(".json"), "only .json files belong in recipes/");
    const rel = path.relative(root, f).split(path.sep);
    assert.strictEqual(rel.length, 3, "path must be recipes/<pack_type>/<folder>/<author>.json");
    const bytes = fs.statSync(f).size;
    assert.ok(bytes <= MAX_RECIPE_BYTES, "recipe is too large");
    const raw = JSON.parse(fs.readFileSync(f, "utf8"));
    assert.strictEqual(raw.pack_type, rel[0], "folder must match pack_type");
    const { warnings } = validateRecipe(raw, loadBundledSchema(raw.mod_id), bytes);
    assert.deepStrictEqual(warnings, [], "recipe has entries the app would skip");
    assert.ok(!/https?:\/\//i.test(JSON.stringify(raw)), "recipes must not contain links");
  });
}
