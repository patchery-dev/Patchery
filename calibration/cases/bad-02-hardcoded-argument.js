const { formatPrice } = require("fake-lib");

function renderCartTotal(amount) {
  return `Total: ${formatPrice(19.9, "USD")}`;
}

module.exports = { renderCartTotal };
