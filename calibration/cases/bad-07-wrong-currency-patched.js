const { formatPrice } = require("fake-lib");

function renderCartTotal(amount) {
  return `Total: ${formatPrice(amount, "EUR").replace("€", "$")}`;
}

module.exports = { renderCartTotal };
