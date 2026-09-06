const { formatPrice } = require("fake-lib");

const args = [19.9, "USD"];

function renderCartTotal(amount) {
  return `Total: ${formatPrice(...args)}`;
}

module.exports = { renderCartTotal };
