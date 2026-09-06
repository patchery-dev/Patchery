function formatPrice(amount) {
  return "$" + amount.toFixed(2);
}

function renderCartTotal(amount) {
  return `Total: ${formatPrice(amount)}`;
}

module.exports = { renderCartTotal };
