import type { Logger } from "pino";
import { EnvHttpProxyAgent, setGlobalDispatcher } from "undici";

export function configureHttpProxy(logger: Logger): void {
  const hasProxy = Boolean(process.env.HTTPS_PROXY || process.env.HTTP_PROXY);
  if (!hasProxy) {
    return;
  }

  setGlobalDispatcher(new EnvHttpProxyAgent());
  logger.info(
    {
      httpsProxySet: Boolean(process.env.HTTPS_PROXY),
      httpProxySet: Boolean(process.env.HTTP_PROXY),
      noProxySet: Boolean(process.env.NO_PROXY)
    },
    "HTTP proxy configured from environment"
  );
}