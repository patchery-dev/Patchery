const { formatPrice } = require("fake-lib");

function renderCartTotal(amount, { currency = "USD" } = {}) {
  return `Total: ${formatPrice(amount, currency)}`;
}

module.exports = { renderCartTotal };
