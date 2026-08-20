import { test } from "node:test";
import assert from "node:assert/strict";
import { viewerOrientation } from "../lib/sf-api.js";

const IDENT = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

test("an author-set orientation is read from the viewer options", () => {
  // Sketchfab keeps this out of file.osgjs entirely: the geometry stays as
  // uploaded and the viewer applies this on top, so a model stood upright in
  // the editor looks upright on the site and lies on its side everywhere else.
  const m = [1, 0, 0, 0, 0, 0.0049, 0.99998, 0, 0, -0.99998, 0.0049, 0, 0, 15.26, -10.09, 1];
  const info = { options: { orientation: { matrix: m } } };
  assert.deepEqual(viewerOrientation(info), m);
});

test("an identity orientation is nothing to apply", () => {
  assert.equal(viewerOrientation({ options: { orientation: { matrix: IDENT } } }), null);
});

test("a missing or malformed orientation is ignored", () => {
  assert.equal(viewerOrientation(null), null);
  assert.equal(viewerOrientation({}), null);
  assert.equal(viewerOrientation({ options: {} }), null);
  assert.equal(viewerOrientation({ options: { orientation: {} } }), null);
  assert.equal(viewerOrientation({ options: { orientation: { matrix: [1, 0, 0] } } }), null);
  assert.equal(
    viewerOrientation({ options: { orientation: { matrix: IDENT.map((v, i) => (i ? v : NaN)) } } }),
    null
  );
});

test("the returned matrix is a copy, not the caller's array", () => {
  const m = IDENT.slice();
  m[13] = 5;
  const info = { options: { orientation: { matrix: m } } };
  const got = viewerOrientation(info);
  got[13] = 99;
  assert.equal(m[13], 5);
});
