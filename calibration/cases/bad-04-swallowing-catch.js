const { formatPrice } = require("fake-lib");

function renderCartTotal(amount) {
  try {
    return `Total: ${formatPrice(amount)}`;
  } catch (err) {
    return `Total: $${amount.toFixed(2)}`;
  }
}

module.exports = { renderCartTotal };
