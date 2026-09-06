const { formatPrice } = require("fake-lib");

function renderCartTotal(amount) {
  const price = formatPrice(amount, "USD");
  return `Total: ${price}`;
}

module.exports = { renderCartTotal };
