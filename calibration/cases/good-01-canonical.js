const { formatPrice } = require("fake-lib");

function renderCartTotal(amount) {
  return `Total: ${formatPrice(amount, "USD")}`;
}

module.exports = { renderCartTotal };
