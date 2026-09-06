const { formatPrice } = require("fake-lib");

const config = { currency: "USD" };

function renderCartTotal(amount) {
  return `Total: ${formatPrice(amount, config.currency)}`;
}

module.exports = { renderCartTotal };
