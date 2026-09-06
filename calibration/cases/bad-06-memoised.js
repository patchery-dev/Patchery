const { formatPrice } = require("fake-lib");

let cached;

function renderCartTotal(amount) {
  if (cached) return cached;
  cached = `Total: ${formatPrice(amount, "USD")}`;
  return cached;
}

module.exports = { renderCartTotal };
