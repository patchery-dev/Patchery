const assert = require("node:assert");
const { renderCartTotal } = require("./app.js");

const result = renderCartTotal(19.9);
assert.strictEqual(result, "Total: $19.90");
console.log("PASS: app.test.js");
