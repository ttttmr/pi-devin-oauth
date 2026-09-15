import { randomUUID } from "node:crypto";
import type { OAuthCredentials, OAuthLoginCallbacks } from "@earendil-works/pi-ai";

const ONE_YEAR_MS = 365 * 24 * 60 * 60 * 1000;
const WINDSURF_WEBSITE = "https://windsurf.com";
const WINDSURF_REGISTER_URL = "https://register.windsurf.com";
/** Public Windsurf Auth0 client id, extracted from the desktop extension. */
const WINDSURF_OAUTH_CLIENT_ID = "3GUryQ7ldAeKEuD2obYnppsnmj58eP5u";
const REGISTER_USER_PATH = "/exa.seat_management_pb.SeatManagementService/RegisterUser";

export class WindsurfRegistrationError extends Error {
  readonly status: number;
  readonly connectCode?: string;

  constructor(message: string, status: number, connectCode?: string) {
    super(message);
    this.name = "WindsurfRegistrationError";
    this.status = status;
    this.connectCode = connectCode;
  }
}

function looksLikeDevinApiKey(value: string): boolean {
  return /^(devin-session-token\$|wspkce\$|sk-ws-|cog_)/.test(value);
}

function looksLikeJwt(value: string): boolean {
  return value.startsWith("eyJ") && value.includes(".");
}

/** Pull an access token out of a pasted URL fragment, or return the raw paste. */
export function extractPastedToken(pasted: string): string {
  const trimmed = pasted.trim().replace(/^['"]|['"]$/g, "");
  try {
    const url = new URL(trimmed);
    const hash = new URLSearchParams(url.hash.replace(/^#/, ""));
    const fromHash = hash.get("access_token") || hash.get("id_token");
    if (fromHash) return fromHash;
    const fromQuery =
      url.searchParams.get("access_token") ||
      url.searchParams.get("id_token") ||
      url.searchParams.get("firebase_id_token");
    if (fromQuery) return fromQuery;
  } catch {
    // not a URL
  }
  return trimmed;
}

function buildSignInUrl(): string {
  const params = new URLSearchParams({
    response_type: "token",
    client_id: WINDSURF_OAUTH_CLIENT_ID,
    redirect_uri: "show-auth-token",
    state: randomUUID(),
    prompt: "login",
  });
  return `${WINDSURF_WEBSITE}/windsurf/signin?${params.toString()}`;
}

function oauthCredentials(apiKey: string): OAuthCredentials {
  return {
    refresh: "",
    access: apiKey,
    expires: Date.now() + ONE_YEAR_MS,
  };
}

/**
 * Exchange a Firebase ID token from the Windsurf sign-in page for a long-lived
 * Devin/Windsurf API key via RegisterUser.
 */
export async function registerWindsurfUser(firebaseIdToken: string): Promise<string> {
  if (!firebaseIdToken) {
    throw new WindsurfRegistrationError("Empty firebase_id_token", 0, "invalid_argument");
  }

  const url = `${WINDSURF_REGISTER_URL}${REGISTER_USER_PATH}`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Connect-Protocol-Version": "1",
    },
    body: JSON.stringify({ firebase_id_token: firebaseIdToken }),
    signal: AbortSignal.timeout(30_000),
  });

  const text = await response.text();
  if (!response.ok) {
    let connectCode: string | undefined;
    let message = text || `RegisterUser failed with HTTP ${response.status}`;
    try {
      const errJson = JSON.parse(text) as { code?: string; message?: string };
      connectCode = errJson.code;
      if (errJson.message) message = errJson.message;
    } catch {
      // keep raw text
    }
    throw new WindsurfRegistrationError(message, response.status, connectCode);
  }

  let parsed: { api_key?: string };
  try {
    parsed = JSON.parse(text) as { api_key?: string };
  } catch {
    throw new WindsurfRegistrationError(
      `RegisterUser returned 200 but body is not JSON: ${text.slice(0, 200)}`,
      response.status,
      "internal",
    );
  }

  if (!parsed.api_key) {
    throw new WindsurfRegistrationError(
      "RegisterUser returned 200 but api_key was empty",
      response.status,
      "malformed_response",
    );
  }
  return parsed.api_key;
}

/**
 * Pi `/login devin` flow: browser Windsurf sign-in, or paste an existing API key.
 * Stores the long-lived key in Pi's auth.json. Does not spawn the Devin CLI.
 */
export async function loginDevinWithWindsurf(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
  const method = await callbacks.onSelect({
    message: "How do you want to sign in to Devin?",
    options: [
      { id: "browser", label: "Browser sign-in (Windsurf)" },
      { id: "key", label: "Paste an existing API key" },
    ],
  });
  if (!method) throw new Error("Devin login cancelled.");

  if (method === "key") {
    const pasted = await callbacks.onPrompt({ message: "Paste your Devin API key:" });
    const apiKey = extractPastedToken(pasted ?? "");
    if (!apiKey) throw new Error("Devin login: no API key pasted.");
    return oauthCredentials(apiKey);
  }

  callbacks.onAuth({ url: buildSignInUrl() });
  const pasted = await callbacks.onPrompt({
    message: "Paste the token from the sign-in page (or an existing API key):",
  });
  const token = extractPastedToken(pasted ?? "");
  if (!token) throw new Error("Devin login: no token pasted.");

  if (looksLikeDevinApiKey(token) && !looksLikeJwt(token)) {
    return oauthCredentials(token);
  }

  const apiKey = await registerWindsurfUser(token);
  return oauthCredentials(apiKey);
}
