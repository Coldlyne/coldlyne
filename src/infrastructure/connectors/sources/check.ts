import { ProviderError } from "../http";

/** The provider's answer, or null when it doesn't know the thing asked about. */
export async function nullWhenNotFound<T>(request: () => Promise<T>): Promise<T | null> {
  try {
    return await request();
  } catch (error) {
    if (error instanceof ProviderError && error.status === 404) return null;
    throw error;
  }
}
