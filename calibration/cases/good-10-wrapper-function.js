const { formatPrice } = require("fake-lib");

function price(amount) {
  return formatPrice(amount, "USD");
}

function renderCartTotal(amount) {
  return `Total: ${price(amount)}`;
}

module.exports = { renderCartTotal };
