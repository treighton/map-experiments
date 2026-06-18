import { v4 } from "uuid";

/** Wrapped so tests can stub id generation deterministically. */
export function newId(): string {
  return v4();
}
