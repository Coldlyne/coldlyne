import { auth } from "@/infrastructure/auth/server";

/** Sign-in, sessions, and the OAuth server assistants register with. */
const handle = (request: Request) => auth().handler(request);

export const GET = handle;
export const POST = handle;
