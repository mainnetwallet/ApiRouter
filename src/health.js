const states = new Map();
export function setHealth(id, status, extra = {}) { states.set(id, { id, status, updatedAt: new Date().toISOString(), ...extra }); }
export function getHealth(id) { return states.get(id) || { id, status: "unknown" }; }
export function getAllHealth() { return [...states.values()]; }
