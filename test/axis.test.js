import test from "node:test";
import assert from "node:assert/strict";
import {
  axisRotationFor,
  findAxisConversion,
  isIdentityMat3,
  mat3Multiply,
  mat3Transpose,
  ZUP_TO_YUP_MAT3,
} from "../lib/osg-scene.js";

const IDENTITY_MAT4 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
// Sketchfab's wrapper for an uploaded glTF: Y-up content → the viewer's Z-up,
// i.e. (x, y, z) → (x, -z, y). Column-major, as osgjs stores it.
const YUP_TO_ZUP_MAT4 = [1, 0, 0, 0, 0, 0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1];

function rootedAt(matrix, name = "Wrapper") {
  return {
    "osg.Node": {
      Children: [{ "osg.MatrixTransform": { Name: name, Matrix: matrix, Children: [] } }],
    },
  };
}

test("findAxisConversion spots a bare quarter turn about X", () => {
  const node = findAxisConversion(rootedAt(YUP_TO_ZUP_MAT4));
  assert.ok(node);
  assert.equal(node.Name, "Wrapper");
  // The opposite quarter turn is equally valid.
  assert.ok(findAxisConversion(rootedAt([1, 0, 0, 0, 0, 0, -1, 0, 0, 1, 0, 0, 0, 0, 0, 1])));
});

test("findAxisConversion ignores placement, scale and other axes", () => {
  const turn = [1, 0, 0, 0, 0, 0, 1, 0, 0, -1, 0, 0];
  // Same rotation but translated — that is an object, not a conversion.
  assert.equal(findAxisConversion(rootedAt([...turn, 5, 0, 0, 1])), null);
  assert.equal(
    findAxisConversion(rootedAt([2, 0, 0, 0, 0, 0, 2, 0, 0, -2, 0, 0, 0, 0, 0, 1])),
    null
  );
  // Quarter turn about Z, not X.
  assert.equal(
    findAxisConversion(rootedAt([0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1])),
    null
  );
  assert.equal(findAxisConversion(rootedAt(IDENTITY_MAT4)), null);
});

test("findAxisConversion only considers the outermost transform", () => {
  const tree = {
    "osg.Node": {
      Children: [
        {
          "osg.MatrixTransform": {
            Name: "Placement",
            Matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 1, 2, 3, 1],
            Children: [
              {
                "osg.MatrixTransform": {
                  Name: "Inner",
                  Matrix: YUP_TO_ZUP_MAT4,
                  Children: [],
                },
              },
            ],
          },
        },
      ],
    },
  };
  assert.equal(findAxisConversion(tree), null);
});

test("findAxisConversion returns null for a scene with no transforms", () => {
  assert.equal(findAxisConversion({ "osg.Node": { Children: [] } }), null);
});

test("a glTF-sourced model needs no turn: the wrapper already did it", () => {
  const axis = axisRotationFor(rootedAt(YUP_TO_ZUP_MAT4));
  assert.ok(axis.node);
  assert.ok(isIdentityMat3(axis.matrix), `expected identity, got ${axis.matrix}`);
});

test("a Z-up model still gets the quarter turn", () => {
  const axis = axisRotationFor(rootedAt([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 4, 0, 0, 1]));
  assert.equal(axis.node, null);
  assert.deepEqual(axis.matrix, ZUP_TO_YUP_MAT3);
});

test("the Z-up turn maps (x, y, z) to (x, z, -y)", () => {
  const m = ZUP_TO_YUP_MAT3;
  const apply = (v) => [
    m[0] * v[0] + m[3] * v[1] + m[6] * v[2],
    m[1] * v[0] + m[4] * v[1] + m[7] * v[2],
    m[2] * v[0] + m[5] * v[1] + m[8] * v[2],
  ];
  assert.deepEqual(apply([1, 2, 3]), [1, 3, -2]);
  // Height along +Z in a Z-up scene ends up along +Y, standing the model up.
  assert.deepEqual(apply([0, 0, 1]), [0, 1, 0]);
});

test("transposing the axis rotation inverts it", () => {
  const round = mat3Multiply(ZUP_TO_YUP_MAT3, mat3Transpose(ZUP_TO_YUP_MAT3));
  assert.ok(isIdentityMat3(round));
});
