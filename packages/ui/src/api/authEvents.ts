// Tiny pub/sub so the API client can announce "the token no longer works"
// without importing React. AuthContext subscribes and drops back to the
// token form, satisfying "401 anywhere -> back to the form".

type Listener = () => void;

const listeners = new Set<Listener>();

export function onUnauthorized(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function emitUnauthorized(): void {
  for (const listener of listeners) listener();
}
