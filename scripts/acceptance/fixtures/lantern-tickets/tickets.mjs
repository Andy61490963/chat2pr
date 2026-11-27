export function countTickets(batches) {
  return batches.reduce((total, tickets) => total + tickets, 0);
}
