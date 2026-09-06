const fakeLib = require("fake-lib");

function renderCartTotal(amount) {
  return `Total: ${fakeLib.formatPrice(amount, "USD")}`;
}

module.exports = { renderCartTotal };
