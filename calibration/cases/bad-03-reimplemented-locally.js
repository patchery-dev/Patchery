function renderCartTotal(amount) {
  return `Total: $${amount.toFixed(2)}`;
}

module.exports = { renderCartTotal };
