export function createNotification(event) {
  return `tokens=${event.tokens}; cost=$${event.costUsd.toFixed(4)}`
}

export function apply() {}
