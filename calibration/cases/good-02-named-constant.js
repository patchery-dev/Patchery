const { formatPrice } = require("fake-lib");

const CURRENCY = "USD";

function renderCartTotal(amount) {
  return `Total: ${formatPrice(amount, CURRENCY)}`;
}

module.exports = { renderCartTotal };
