import { AsyncLocalStorage } from "node:async_hooks";

export const requestContext = new AsyncLocalStorage();

export function getCurrentUser() {
    return requestContext.getStore();
}