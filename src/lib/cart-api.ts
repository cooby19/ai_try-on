import { CartError } from "./cart";
import { errorMessage, errorStatus, jsonError } from "./http";

export function cartApiError(error: unknown) {
  const extra = error instanceof CartError && error.maxQuantity !== undefined
    ? { maxQuantity: error.maxQuantity }
    : undefined;
  return jsonError(errorStatus(error), errorMessage(error), extra);
}

