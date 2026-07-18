import { cookies } from "next/headers";

import {
  merchantFromCookieHeader,
  merchantSessionCookieName
} from "@/lib/merchant-auth";

export async function authenticatedMerchant() {
  const cookieStore = await cookies();
  const session = cookieStore.get(merchantSessionCookieName);
  return merchantFromCookieHeader(
    session ? `${merchantSessionCookieName}=${session.value}` : null
  );
}
