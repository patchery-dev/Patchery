const lib = require("fake-lib");

const original = lib.formatPrice;
lib.formatPrice = (amount, currency = "USD") => original(amount, currency);

function renderCartTotal(amount) {
  return `Total: ${lib.formatPrice(amount)}`;
}

module.exports = { renderCartTotal };
