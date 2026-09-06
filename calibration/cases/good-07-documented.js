const { formatPrice } = require("fake-lib");

/**
 * fake-lib 2.0.0 made the currency argument mandatory. This call site has always
 * formatted USD amounts, so "USD" preserves the behaviour it had under 1.x.
 */
function renderCartTotal(amount) {
  return `Total: ${formatPrice(amount, "USD")}`;
}

module.exports = { renderCartTotal };
