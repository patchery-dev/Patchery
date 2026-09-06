const { formatPrice } = require("fake-lib");

function renderCartTotal(amount) {
  const currency = amount > 100 ? "EUR" : "USD";
  return `Total: ${formatPrice(amount, currency)}`;
}

module.exports = { renderCartTotal };
