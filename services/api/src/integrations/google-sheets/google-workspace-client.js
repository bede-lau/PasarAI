const AUTHORIZATION_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const SHEETS_ENDPOINT = "https://sheets.googleapis.com/v4/spreadsheets";
const DRIVE_ENDPOINT = "https://www.googleapis.com/drive/v3";
const DEFAULT_TIMEOUT_MS = 30_000;
const GOOGLE_SCOPES = [
  "https://www.googleapis.com/auth/drive.file",
  "https://www.googleapis.com/auth/spreadsheets",
];

export class GoogleWorkspaceApiError extends Error {
  constructor(message, { status, response } = {}) {
    super(message);
    this.name = "GoogleWorkspaceApiError";
    this.status = status;
    this.response = response;
  }
}

async function responseBody(response) {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function googleRequest(fetchImpl, url, {
  accessToken,
  method = "GET",
  body,
  headers = {},
} = {}) {
  const response = await fetchImpl(url, {
    method,
    headers: {
      ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const parsed = await responseBody(response);
  if (!response.ok) {
    const message = parsed?.error_description
      ?? parsed?.error?.message
      ?? `Google API request failed with status ${response.status}`;
    throw new GoogleWorkspaceApiError(message, {
      status: response.status,
      response: parsed,
    });
  }
  return parsed;
}

export function createGoogleWorkspaceClient({
  clientId,
  clientSecret,
  fetchImpl = fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
}) {
  if (!clientId) throw new Error("clientId is required");
  if (!clientSecret) throw new Error("clientSecret is required");
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error("timeoutMs must be a positive number");
  }

  async function googleFetch(url, init = {}) {
    try {
      return await fetchImpl(url, {
        ...init,
        signal: init.signal ?? AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      if (error?.name === "TimeoutError" || error?.name === "AbortError") {
        throw new GoogleWorkspaceApiError("Google API request timed out");
      }
      throw error;
    }
  }

  async function tokenRequest(parameters) {
    const response = await googleFetch(TOKEN_ENDPOINT, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        ...parameters,
      }),
    });
    const parsed = await responseBody(response);
    if (!response.ok) {
      throw new GoogleWorkspaceApiError(
        parsed?.error_description ?? "Google OAuth token exchange failed",
        { status: response.status, response: parsed },
      );
    }
    return parsed;
  }

  return {
    authorizationUrl({ redirectUri, state }) {
      const url = new URL(AUTHORIZATION_ENDPOINT);
      url.search = new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirectUri,
        response_type: "code",
        access_type: "offline",
        prompt: "consent",
        include_granted_scopes: "true",
        scope: GOOGLE_SCOPES.join(" "),
        state,
      }).toString();
      return url.toString();
    },

    exchangeCode({ code, redirectUri }) {
      return tokenRequest({
        code,
        redirect_uri: redirectUri,
        grant_type: "authorization_code",
      });
    },

    refreshAccessToken(refreshToken) {
      return tokenRequest({
        refresh_token: refreshToken,
        grant_type: "refresh_token",
      });
    },

    createSpreadsheet({ accessToken, title, sheetTitles }) {
      return googleRequest(googleFetch, SHEETS_ENDPOINT, {
        accessToken,
        method: "POST",
        body: {
          properties: { title },
          sheets: sheetTitles.map((sheetTitle) => ({
            properties: { title: sheetTitle },
          })),
        },
      });
    },

    getSpreadsheet({ accessToken, spreadsheetId }) {
      const fields = [
        "spreadsheetId",
        "spreadsheetUrl",
        "properties(title)",
        "sheets(properties(sheetId,title))",
      ].join(",");
      const url = new URL(`${SHEETS_ENDPOINT}/${encodeURIComponent(spreadsheetId)}`);
      url.searchParams.set("fields", fields);
      return googleRequest(googleFetch, url, { accessToken });
    },

    batchUpdateSpreadsheet({ accessToken, spreadsheetId, requests }) {
      return googleRequest(
        googleFetch,
        `${SHEETS_ENDPOINT}/${encodeURIComponent(spreadsheetId)}:batchUpdate`,
        {
          accessToken,
          method: "POST",
          body: { requests },
        },
      );
    },

    batchClearValues({ accessToken, spreadsheetId, ranges }) {
      return googleRequest(
        googleFetch,
        `${SHEETS_ENDPOINT}/${encodeURIComponent(spreadsheetId)}/values:batchClear`,
        {
          accessToken,
          method: "POST",
          body: { ranges },
        },
      );
    },

    batchUpdateValues({
      accessToken,
      spreadsheetId,
      data,
      valueInputOption = "RAW",
    }) {
      return googleRequest(
        googleFetch,
        `${SHEETS_ENDPOINT}/${encodeURIComponent(spreadsheetId)}/values:batchUpdate`,
        {
          accessToken,
          method: "POST",
          body: {
            valueInputOption,
            data,
          },
        },
      );
    },

    getValues({ accessToken, spreadsheetId, range }) {
      const url = new URL(
        `${SHEETS_ENDPOINT}/${encodeURIComponent(spreadsheetId)}/values/${
          encodeURIComponent(range)
        }`,
      );
      url.searchParams.set("valueRenderOption", "FORMULA");
      url.searchParams.set("dateTimeRenderOption", "SERIAL_NUMBER");
      return googleRequest(
        googleFetch,
        url,
        { accessToken },
      );
    },

    watchFile({
      accessToken,
      spreadsheetId,
      channelId,
      webhookUrl,
      channelToken,
      expiration,
    }) {
      const url = new URL(
        `${DRIVE_ENDPOINT}/files/${encodeURIComponent(spreadsheetId)}/watch`,
      );
      url.searchParams.set("supportsAllDrives", "true");
      return googleRequest(googleFetch, url, {
        accessToken,
        method: "POST",
        body: {
          id: channelId,
          type: "web_hook",
          address: webhookUrl,
          token: channelToken,
          expiration: String(expiration),
        },
      });
    },

    stopChannel({ accessToken, channelId, resourceId }) {
      return googleRequest(googleFetch, `${DRIVE_ENDPOINT}/channels/stop`, {
        accessToken,
        method: "POST",
        body: {
          id: channelId,
          resourceId,
        },
      });
    },
  };
}
