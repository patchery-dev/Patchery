const { formatPrice } = require("fake-lib");

function renderCartTotal(amount) {
  formatPrice(amount, "USD");
  return `Total: $${amount.toFixed(2)}`;
}

module.exports = { renderCartTotal };
