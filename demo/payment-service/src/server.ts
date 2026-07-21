import { type Server } from "node:http";

import { LiveProbe } from "@doomslayer2945/liveprobe-node";

import { createPaymentApp } from "./app.js";
import { loadServiceConfig } from "./config.js";
import { FakeDbPool } from "./fake-db.js";
import { PaymentProcessor } from "./payments.js";

function listen(
  app: ReturnType<typeof createPaymentApp>,
  port: number,
  host: string,
): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = app.listen(port, host, () => {
      server.off("error", reject);
      resolve(server);
    });
    server.once("error", reject);
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error === undefined) {
        resolve();
      } else {
        reject(error);
      }
    });
  });
}

async function main(): Promise<void> {
  const config = loadServiceConfig();
  const liveProbe = await LiveProbe.start({
    serviceId: config.serviceId,
    brokerUrl: config.brokerUrl,
    environment: process.env["NODE_ENV"] ?? "development",
  });

  const pool = new FakeDbPool(5);
  const processor = new PaymentProcessor(pool, config.bugEnabled);
  const app = createPaymentApp({
    serviceId: config.serviceId,
    bugEnabled: config.bugEnabled,
    processor,
  });

  let server: Server;
  try {
    server = await listen(app, config.port, config.host);
  } catch (error: unknown) {
    await liveProbe.stop();
    throw error;
  }

  process.stdout.write(
    `[payment] STARTED service=${config.serviceId} ` +
      `url=http://${config.host}:${String(config.port)} bug=${
        config.bugEnabled ? "on" : "off"
      }\n`,
  );

  let shutdownPromise: Promise<void> | undefined;
  const shutdown = (signal: string): Promise<void> => {
    shutdownPromise ??= (async () => {
      process.stdout.write(`[payment] STOPPING signal=${signal}\n`);
      await close(server);
      await liveProbe.stop();
      process.stdout.write("[payment] STOPPED\n");
    })();
    return shutdownPromise;
  };

  process.once("SIGINT", () => {
    void shutdown("SIGINT").catch((error: unknown) => {
      console.error("[payment] shutdown failed", error);
      process.exitCode = 1;
    });
  });
  process.once("SIGTERM", () => {
    void shutdown("SIGTERM").catch((error: unknown) => {
      console.error("[payment] shutdown failed", error);
      process.exitCode = 1;
    });
  });
}

main().catch((error: unknown) => {
  console.error("[payment] failed to start", error);
  process.exitCode = 1;
});
