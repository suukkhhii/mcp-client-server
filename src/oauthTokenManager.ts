import type { Logger } from "pino";

type TokenResponse = {
  access_token: string;
  token_type?: string;
  expires_in?: number;
};

type TokenCache = {
  accessToken: string;
  expiresAtEpochMs: number;
};

type OAuthTokenManagerOptions = {
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
  scope?: string;
  refreshBufferSeconds?: number;
  logger: Logger;
};

export class OAuthTokenManager {
  private readonly tokenUrl: string;
  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly scope?: string;
  private readonly refreshBufferSeconds: number;
  private readonly logger: Logger;
  private tokenCache?: TokenCache;
  private inflight?: Promise<string>;

  constructor(options: OAuthTokenManagerOptions) {
    this.tokenUrl = options.tokenUrl;
    this.clientId = options.clientId;
    this.clientSecret = options.clientSecret;
    this.scope = options.scope;
    this.refreshBufferSeconds = options.refreshBufferSeconds ?? 60;
    this.logger = options.logger;
  }

  async getAccessToken(): Promise<string> {
    if (this.isTokenValid()) {
      return this.tokenCache!.accessToken;
    }

    if (!this.inflight) {
      this.inflight = this.fetchAccessToken().finally(() => {
        this.inflight = undefined;
      });
    }

    return this.inflight;
  }

  invalidateToken() {
    this.tokenCache = undefined;
  }

  private isTokenValid(): boolean {
    if (!this.tokenCache) {
      return false;
    }
    const now = Date.now();
    return now < this.tokenCache.expiresAtEpochMs;
  }

  private async fetchAccessToken(): Promise<string> {
    const body = new URLSearchParams();
    body.set("grant_type", "client_credentials");
    body.set("client_id", this.clientId);
    body.set("client_secret", this.clientSecret);
    if (this.scope) {
      body.set("scope", this.scope);
    }

    this.logger.info({ tokenUrl: this.tokenUrl }, "Fetching OAuth token");

    const response = await fetch(this.tokenUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json"
      },
      body
    });

    const rawText = await response.text();
    let json: TokenResponse | Record<string, unknown> = {};

    try {
      json = rawText ? (JSON.parse(rawText) as TokenResponse) : {};
    } catch {
      json = {};
    }

    if (!response.ok) {
      this.logger.error(
        { status: response.status, responseBody: sanitizeBody(rawText) },
        "OAuth token request failed"
      );
      throw new Error(`OAuth token request failed with status ${response.status}`);
    }

    const accessToken =
      typeof (json as TokenResponse).access_token === "string"
        ? (json as TokenResponse).access_token
        : undefined;

    if (!accessToken) {
      throw new Error("OAuth token response missing access_token");
    }

    const expiresInSecondsRaw = (json as TokenResponse).expires_in;
    const expiresInSeconds =
      typeof expiresInSecondsRaw === "number" && Number.isFinite(expiresInSecondsRaw)
        ? Math.max(60, Math.floor(expiresInSecondsRaw))
        : 3600;

    const refreshBefore = this.refreshBufferSeconds * 1000;
    const expiresAtEpochMs = Date.now() + expiresInSeconds * 1000 - refreshBefore;

    this.tokenCache = {
      accessToken,
      expiresAtEpochMs
    };

    this.logger.info(
      { expiresInSeconds, refreshBufferSeconds: this.refreshBufferSeconds },
      "OAuth token acquired"
    );

    return accessToken;
  }
}

function sanitizeBody(text: string): string {
  if (!text) {
    return "";
  }

  return text
    .replace(/("access_token"\s*:\s*")[^"]+("\s*)/gi, "$1[REDACTED]$2")
    .replace(/("client_secret"\s*:\s*")[^"]+("\s*)/gi, "$1[REDACTED]$2");
}