import pino from "pino";

export function createLogger(level: pino.Level) {
  return pino({
    level,
    redact: {
      paths: [
        "clientSecret",
        "token",
        "access_token",
        "headers.authorization",
        "authorization",
        "request.headers.authorization",
        "response.config.headers.authorization"
      ],
      censor: "[REDACTED]"
    }
  });
}

export function redactBearer(token: string): string {
  if (!token) {
    return "[REDACTED]";
  }
  return `${token.slice(0, 6)}...[REDACTED]`;
}