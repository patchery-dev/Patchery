function renderCartTotal(amount) {
  return `Total: $${Number(amount).toLocaleString("en-US", { minimumFractionDigits: 2 })}`;
}

module.exports = { renderCartTotal };
