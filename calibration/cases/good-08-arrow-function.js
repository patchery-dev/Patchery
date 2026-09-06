const { formatPrice } = require("fake-lib");

const renderCartTotal = (amount) => `Total: ${formatPrice(amount, "USD")}`;

module.exports = { renderCartTotal };
